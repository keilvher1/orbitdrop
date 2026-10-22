import { PDFDocument, type PDFImage } from 'pdf-lib';
import sharp from 'sharp';
import {
  OrbitError,
  isImageFormat,
  type ConvertOptions,
  type JobWarning,
  type ProcessingLimits,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorRunContext,
} from '@orbitdrop/contracts';
import { convertedName } from '@orbitdrop/core';
import { configureSharp, droppedFrames, framesWarning, mapSharpError, openImageSource, readInputBuffer, type DroppedFrames } from '../common/io';
import { OutputLedger, extensionMismatchWarning, reporter, throwIfCancelled, toOrbitError, writableOutputDir } from './common';

/**
 * Images → one PDF (convert.pdf, a merging action), one image per page, in the
 * confirmed order (options.order = fileIds, must list every input once).
 *
 * Page size:
 *  - 'image': the image at its physical size (pixels × 72 / density; 72 DPI
 *    when the file has no density), plus marginPt on every side.
 *  - 'a4' / 'letter': the page turns landscape for landscape images; the image
 *    is centred inside the margins and scaled down to fit (never enlarged).
 *
 * Embedding:
 *  - Baseline JPEGs (8-bit gray/RGB, upright orientation, sRGB or no ICC
 *    profile) are embedded byte-for-byte (no re-encoding, no quality loss),
 *    after a full decode proved the data intact (a truncated JPEG is
 *    IMAGE_CORRUPT here too, never a broken picture in a "successful" PDF).
 *  - Other JPEGs (EXIF-rotated, progressive, CMYK, wide-gamut ICC) are decoded,
 *    oriented, converted to sRGB and re-encoded as baseline JPEG q95 4:4:4 —
 *    they are photos already, PNG would multiply the PDF size.
 *  - Every other format is decoded (orientation applied, 8-bit, sRGB) and
 *    embedded losslessly as PNG; transparency is kept (soft mask). Animated or
 *    multi-page inputs contribute their first frame/page (FIRST_FRAME_ONLY /
 *    FIRST_PAGE_ONLY).
 */

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;
/** PDF viewers (and the PDF spec's implementation limits) cap pages at 200 in = 14 400 pt per side. */
const MAX_PAGE_PT = 14_400;
const MIN_PAGE_PT = 3;

export function orderInputs(inputs: readonly ProcessorInput[], order: readonly string[] | undefined): ProcessorInput[] {
  if (inputs.length === 0) throw new OrbitError('INVALID_OPTIONS', 'No input files');
  if (!order) return [...inputs];
  const byId = new Map(inputs.map((i) => [i.fileId, i] as const));
  if (byId.size !== inputs.length) throw new OrbitError('INVALID_OPTIONS', 'Duplicate input files');
  if (order.length !== inputs.length || new Set(order).size !== order.length || order.some((id) => !byId.has(id))) {
    throw new OrbitError('INVALID_OPTIONS', 'Page order must list every selected file exactly once');
  }
  return order.map((id) => byId.get(id)!);
}

/**
 * pdf-lib parses JPEGs with `new DataView(bytes.buffer)`, ignoring byteOffset,
 * so a Buffer that is a view into a larger ArrayBuffer (Node's pool for small
 * Buffer.concat results, subarrays) is read from the wrong place ("SOI not
 * found in JPEG"). Hand it a Uint8Array that owns its whole buffer.
 */
export function exactBytes(data: Uint8Array): Uint8Array {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : new Uint8Array(data);
}

interface JpegFrame {
  readonly marker: number;
  readonly precision: number;
  readonly components: number;
}

/** First SOF marker of a JPEG (before SOS), or null. */
export function jpegFrameInfo(buf: Uint8Array): JpegFrame | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null;
    let marker = buf[pos + 1]!;
    while (marker === 0xff && pos + 2 < buf.length) {
      pos += 1;
      marker = buf[pos + 1]!;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (pos + 4 > buf.length) return null;
    const length = (buf[pos + 2]! << 8) | buf[pos + 3]!;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (pos + 10 > buf.length) return null;
      return { marker, precision: buf[pos + 4]!, components: buf[pos + 9]! };
    }
    pos += 2 + length;
  }
  return null;
}

/** Description of an ICC profile ('desc' tag, v2 text or v4 mluc), or null. */
export function iccDescription(icc: Uint8Array): string | null {
  const buf = Buffer.from(icc.buffer, icc.byteOffset, icc.byteLength);
  if (buf.length < 132) return null;
  const count = buf.readUInt32BE(128);
  for (let i = 0; i < Math.min(count, 200); i += 1) {
    const entry = 132 + i * 12;
    if (entry + 12 > buf.length) return null;
    if (buf.toString('latin1', entry, entry + 4) !== 'desc') continue;
    const off = buf.readUInt32BE(entry + 4);
    if (off + 12 > buf.length) return null;
    const type = buf.toString('latin1', off, off + 4);
    if (type === 'desc') {
      const n = buf.readUInt32BE(off + 8);
      return buf.toString('latin1', off + 12, Math.min(off + 12 + n, buf.length)).replace(/\0[\s\S]*$/u, '');
    }
    if (type === 'mluc' && off + 28 <= buf.length && buf.readUInt32BE(off + 8) > 0) {
      const len = buf.readUInt32BE(off + 20);
      const start = off + buf.readUInt32BE(off + 24);
      const end = Math.min(start + len, buf.length);
      let out = '';
      for (let p = start; p + 1 < end; p += 2) out += String.fromCharCode(buf.readUInt16BE(p));
      return out;
    }
    return null;
  }
  return null;
}

/**
 * Drop APP1 (EXIF/XMP), APP13 (IPTC) and COM segments from a JPEG without
 * touching the compressed data. Returns the metadata kinds removed.
 */
export function stripJpegMetadata(buf: Buffer): { data: Buffer; removed: string[] } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { data: buf, removed: [] };
  const parts: Buffer[] = [buf.subarray(0, 2)];
  const removed = new Set<string>();
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return { data: buf, removed: [] };
    const marker = buf[pos + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      parts.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    const length = buf.readUInt16BE(pos + 2);
    const end = pos + 2 + length;
    if (length < 2 || end > buf.length) return { data: buf, removed: [] };
    const segment = buf.subarray(pos, end);
    if (marker === 0xe1) {
      const id = buf.toString('latin1', pos + 4, Math.min(pos + 4 + 29, end));
      removed.add(id.startsWith('Exif') ? 'exif' : id.startsWith('http://ns.adobe.com/xap') ? 'xmp' : 'app1');
    } else if (marker === 0xed) {
      removed.add('iptc');
    } else if (marker === 0xfe) {
      removed.add('comment');
    } else {
      parts.push(segment);
    }
    pos = end;
  }
  if (removed.size === 0) return { data: buf, removed: [] };
  parts.push(buf.subarray(pos));
  return { data: Buffer.concat(parts), removed: [...removed] };
}

export interface PreparedImage {
  readonly kind: 'jpg' | 'png';
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Pixels per inch used for the physical size. */
  readonly density: number;
  /** Metadata kinds (exif, xmp, iptc…) not carried into the PDF. */
  readonly metadataRemoved: readonly string[];
  /** Frames/pages of an animated or multi-page input that were not used (first one only). */
  readonly dropped: DroppedFrames | null;
}

/**
 * Decode every scan (at reduced size where the codec allows it: JPEG DCT scaling still
 * entropy-decodes all data) with failOn 'error', so a truncated or corrupt JPEG is rejected
 * before its bytes are embedded unchanged.
 */
async function assertDecodes(buffer: Buffer, limits: ProcessingLimits): Promise<void> {
  await sharp(buffer, { limitInputPixels: limits.maxInputPixels, failOn: 'error' }).resize(64, 64, { fit: 'inside' }).raw().toBuffer();
}

function metadataKinds(meta: { exif?: unknown; xmp?: unknown; iptc?: unknown }): string[] {
  return [meta.exif ? 'exif' : '', meta.xmp ? 'xmp' : '', meta.iptc ? 'iptc' : ''].filter(Boolean);
}

/** Pixels per inch for the physical size; 72 when missing or implausible (e.g. JFIF aspect-ratio-only "1"). */
function densityOf(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 36 && value <= 4800 ? value : 72;
}

export async function prepareImage(buffer: Buffer, input: ProcessorInput, limits: ProcessingLimits, keepMetadata: boolean): Promise<PreparedImage> {
  configureSharp();
  try {
    if (input.format === 'jpeg') {
      const meta = await sharp(buffer, { limitInputPixels: limits.maxInputPixels }).metadata();
      if (!meta.width || !meta.height) throw new OrbitError('IMAGE_CORRUPT', 'Image could not be decoded');
      if (meta.width * meta.height > limits.maxInputPixels) throw new OrbitError('IMAGE_TOO_LARGE', 'Image exceeds the pixel limit');
      const frame = jpegFrameInfo(buffer);
      const upright = (meta.orientation ?? 1) === 1;
      const baseline = frame !== null && (frame.marker === 0xc0 || frame.marker === 0xc1) && frame.precision === 8;
      const simpleColour = frame !== null && (frame.components === 1 || frame.components === 3);
      const srgb = !meta.icc || /srgb/i.test(iccDescription(meta.icc) ?? '');
      if (upright && baseline && simpleColour && srgb) {
        await assertDecodes(buffer, limits);
        const stripped = keepMetadata ? { data: buffer, removed: [] } : stripJpegMetadata(buffer);
        return {
          kind: 'jpg',
          bytes: stripped.data,
          width: meta.width,
          height: meta.height,
          density: densityOf(meta.density),
          metadataRemoved: stripped.removed.filter((k) => k !== 'comment' && k !== 'app1'),
          dropped: null,
        };
      }
      const source = await openImageSource(buffer, 'jpeg', limits);
      const { data, info } = await source.open().jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
      return { kind: 'jpg', bytes: data, width: info.width, height: info.height, density: densityOf(meta.density), metadataRemoved: metadataKinds(meta), dropped: null };
    }
    const format = input.format as Parameters<typeof openImageSource>[1];
    const source = await openImageSource(buffer, format, limits);
    const { meta } = source;
    const { data, info } = await source.open().png({ compressionLevel: 1 }).toBuffer({ resolveWithObject: true });
    return {
      kind: 'png',
      bytes: data,
      width: info.width,
      height: info.height,
      density: densityOf(meta.density),
      metadataRemoved: metadataKinds(meta),
      dropped: droppedFrames(format, meta, buffer),
    };
  } catch (error) {
    throw mapSharpError(error);
  }
}

export interface PageLayout {
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Page and image rectangle (points) for one image. */
export function layoutPage(
  pixelWidth: number,
  pixelHeight: number,
  density: number,
  pageSize: ConvertOptions['pageSize'],
  marginPt: number,
): PageLayout {
  const naturalW = (pixelWidth * 72) / density;
  const naturalH = (pixelHeight * 72) / density;
  if (pageSize === 'image') {
    const limit = MAX_PAGE_PT - 2 * marginPt;
    const scale = Math.min(1, limit / naturalW, limit / naturalH);
    const w = Math.min(limit, naturalW * scale);
    const h = Math.min(limit, naturalH * scale);
    const pageWidth = Math.max(MIN_PAGE_PT, w + 2 * marginPt);
    const pageHeight = Math.max(MIN_PAGE_PT, h + 2 * marginPt);
    return { pageWidth, pageHeight, x: (pageWidth - w) / 2, y: (pageHeight - h) / 2, width: w, height: h };
  }
  const [shortSide, longSide] = PAGE_SIZES[pageSize];
  const landscape = pixelWidth > pixelHeight;
  const pageWidth = landscape ? longSide : shortSide;
  const pageHeight = landscape ? shortSide : longSide;
  const margin = Math.min(marginPt, pageWidth / 2 - 1, pageHeight / 2 - 1);
  const boxW = pageWidth - 2 * margin;
  const boxH = pageHeight - 2 * margin;
  const scale = Math.min(1, boxW / naturalW, boxH / naturalH);
  const w = naturalW * scale;
  const h = naturalH * scale;
  return { pageWidth, pageHeight, x: (pageWidth - w) / 2, y: (pageHeight - h) / 2, width: w, height: h };
}

export async function convertImagesToPdf(job: ProcessorJob, options: ConvertOptions, ctx: ProcessorRunContext): Promise<ProcessorResult> {
  const ordered = orderInputs(job.inputs, options.order);
  for (const input of ordered) {
    if (!isImageFormat(input.format)) throw new OrbitError('UNSUPPORTED_FORMAT', 'Only images can be combined into a PDF');
  }
  if (ordered.length > job.limits.maxPdfPages) {
    throw new OrbitError('TOO_MANY_FILES', 'Too many images for one PDF', { detail: `${ordered.length} > ${job.limits.maxPdfPages}` });
  }
  const progress = reporter(ctx);
  const total = ordered.length;
  const first = ordered[0]!;
  const dir = await writableOutputDir(job, first);
  progress({ kind: 'determinate', done: 0, total, unit: 'file' });

  const doc = await PDFDocument.create();
  doc.setCreator('OrbitDrop');
  doc.setProducer('OrbitDrop (pdf-lib)');
  const metadataRemoved = new Set<string>();
  const dropped: { frames: DroppedFrames | null; framesFiles: number; pages: DroppedFrames | null; pagesFiles: number } = { frames: null, framesFiles: 0, pages: null, pagesFiles: 0 };
  for (const [index, input] of ordered.entries()) {
    throwIfCancelled(ctx.signal);
    const buffer = await readInputBuffer(input, job.limits, ctx.signal);
    const prepared = await prepareImage(buffer, input, job.limits, options.keepMetadata);
    for (const kind of prepared.metadataRemoved) metadataRemoved.add(kind);
    if (prepared.dropped?.kind === 'frames') {
      dropped.frames ??= prepared.dropped;
      dropped.framesFiles += 1;
    } else if (prepared.dropped?.kind === 'pages') {
      dropped.pages ??= prepared.dropped;
      dropped.pagesFiles += 1;
    }
    throwIfCancelled(ctx.signal);
    let image: PDFImage;
    try {
      const bytes = exactBytes(prepared.bytes);
      image = prepared.kind === 'jpg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    } catch (error) {
      throw new OrbitError('IMAGE_CORRUPT', 'Image could not be embedded in the PDF', {
        detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
        cause: error,
      });
    }
    const layout = layoutPage(prepared.width, prepared.height, prepared.density, options.pageSize, options.marginPt);
    const page = doc.addPage([layout.pageWidth, layout.pageHeight]);
    page.drawImage(image, { x: layout.x, y: layout.y, width: layout.width, height: layout.height });
    progress({ kind: 'determinate', done: index + 1, total, unit: 'file' });
  }

  throwIfCancelled(ctx.signal);
  progress({ kind: 'indeterminate', stage: 'writing' });
  let bytes: Uint8Array;
  try {
    bytes = await doc.save({ useObjectStreams: true });
  } catch (error) {
    throw toOrbitError(error, ctx.signal);
  }
  const ledger = new OutputLedger(ctx.onCommitted);
  const output = await ledger.commit(dir, convertedName(first.displayName, '.pdf'), job.jobId, bytes, ctx.signal, {
    format: 'pdf',
    pages: total,
  });

  const warnings: JobWarning[] = [];
  for (const input of ordered) {
    const mismatch = extensionMismatchWarning(input);
    if (mismatch) {
      warnings.push(mismatch);
      break;
    }
  }
  if (dropped.frames) warnings.push(framesWarning(dropped.frames, dropped.framesFiles));
  if (dropped.pages) warnings.push(framesWarning(dropped.pages, dropped.pagesFiles));
  if (metadataRemoved.size > 0) warnings.push({ code: 'METADATA_REMOVED', params: { kinds: [...metadataRemoved].join(',') } });
  return { outputs: [output], warnings };
}
