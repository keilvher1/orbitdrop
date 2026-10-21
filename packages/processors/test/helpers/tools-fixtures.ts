import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import {
  DEFAULT_PROCESSING_LIMITS,
  formatFromExtension,
  type FileFormat,
  type JobProgress,
  type PreviewKind,
  type PreviewResult,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorSettings,
  type ToolActionId,
} from '@orbitdrop/contracts';
import { renderToolPreview, runTool } from '../../src/tools';

/** Test fixtures for the tool executors. Every image is generated here (no shared fixture files). */

export const settings: ProcessorSettings = { pdfDpi: 300, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 };
export const limits = DEFAULT_PROCESSING_LIMITS;

export async function makeTempDir(tag: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `orbitdrop-tools-${tag}-`));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** Files in `dir` (sorted); temp files of the safe writer start with "." and contain ".orbitdrop-". */
export async function listDir(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

export async function inputFor(path: string, format?: FileFormat): Promise<ProcessorInput> {
  const info = await stat(path);
  const fmt = format ?? formatFromExtension(path.slice(path.lastIndexOf('.')));
  if (!fmt) throw new Error(`no format for ${path}`);
  return { fileId: randomUUID().replace(/-/g, '').slice(0, 12), path, displayName: basename(path), sourceDir: dirname(path), format: fmt, bytes: info.size };
}

export interface RunOptions {
  readonly outputDir?: string | null;
  readonly assets?: Record<string, ProcessorInput>;
  readonly signal?: AbortSignal;
  readonly progress?: JobProgress[];
}

export function jobFor(actionId: ToolActionId, input: ProcessorInput, options: unknown, extra: RunOptions = {}): ProcessorJob {
  return {
    jobId: `job-${randomUUID().slice(0, 8)}`,
    actionId,
    inputs: [input],
    options,
    outputDir: extra.outputDir ?? null,
    settings,
    limits,
    ...(extra.assets ? { assets: extra.assets } : {}),
  };
}

export async function runToolJob(actionId: ToolActionId, input: ProcessorInput, options: unknown, extra: RunOptions = {}): Promise<ProcessorResult> {
  return runTool(jobFor(actionId, input, options, extra), {
    signal: extra.signal ?? new AbortController().signal,
    onProgress: (p) => extra.progress?.push(p),
  });
}

export async function preview(
  kind: PreviewKind,
  input: ProcessorInput,
  options: unknown,
  maxEdge: number,
  extra: { assets?: Record<string, ProcessorInput>; signal?: AbortSignal } = {},
): Promise<PreviewResult> {
  return renderToolPreview(
    { previewId: randomUUID(), kind, input, options, maxEdge, settings, limits, ...(extra.assets ? { assets: extra.assets } : {}) },
    { signal: extra.signal ?? new AbortController().signal },
  );
}

// ---------------------------------------------------------------- pixels

export interface Rgba {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

export async function readRgba(input: string | Buffer | Uint8Array): Promise<Rgba> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export function px(img: Rgba, x: number, y: number): [number, number, number, number] {
  const i = (Math.floor(y) * img.width + Math.floor(x)) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

export function near(actual: readonly number[], expected: readonly number[], tolerance: number): boolean {
  return expected.every((v, i) => Math.abs((actual[i] ?? 0) - v) <= tolerance);
}

/** Mean absolute difference per channel (RGB only) between two equally sized images. */
export function meanAbsDiff(a: Rgba, b: Rgba): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
  }
  return sum / ((a.data.length / 4) * 3);
}

export function luminance(p: readonly number[]): number {
  return 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;
}

export const RED = [255, 0, 0] as const;
export const GREEN = [0, 255, 0] as const;
export const BLUE = [0, 0, 255] as const;
export const YELLOW = [255, 255, 0] as const;

/** Raw RGB image whose quadrants are TL red, TR green, BL blue, BR yellow (in stored orientation). */
export function quadrantRaw(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const right = x >= width / 2;
      const bottom = y >= height / 2;
      const c = !right && !bottom ? RED : right && !bottom ? GREEN : !right && bottom ? BLUE : YELLOW;
      raw.set(c, (y * width + x) * 3);
    }
  }
  return raw;
}

export function quadrantJpeg(width: number, height: number): Promise<Buffer> {
  return sharp(quadrantRaw(width, height), { raw: { width, height, channels: 3 } }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
}

/** Deterministic "photo": smooth gradients plus pseudo-random noise (hard to compress). */
export function noisyRaw(width: number, height: number, seed = 1, noise = 60): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const base = [(x / width) * 200 + 20, (y / height) * 200 + 20, ((x + y) / (width + height)) * 200 + 20];
      for (let c = 0; c < 3; c += 1) raw[i + c] = Math.max(0, Math.min(255, Math.round(base[c]! + (rand() - 0.5) * noise)));
    }
  }
  return raw;
}

export function noisyJpeg(width: number, height: number, quality: number, seed = 1): Promise<Buffer> {
  return sharp(noisyRaw(width, height, seed), { raw: { width, height, channels: 3 } }).jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer();
}

/** Minimal 24-bit BI_RGB BMP writer (bottom-up rows padded to 4 bytes) from raw RGB. */
export function bmp24(raw: Buffer, width: number, height: number): Buffer {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + stride * height);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y += 1) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      out[row + x * 3] = raw[i + 2]!;
      out[row + x * 3 + 1] = raw[i + 1]!;
      out[row + x * 3 + 2] = raw[i]!;
    }
  }
  return out;
}

/** Minimal reader for uncompressed 24-bit and 32-bit (BI_RGB / BI_BITFIELDS BGRA) BMPs → RGBA. */
export function readBmp(buf: Buffer): Rgba {
  if (buf.toString('latin1', 0, 2) !== 'BM') throw new Error('not a BMP');
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) throw new Error(`unsupported bpp ${bpp}`);
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = offset + (rawHeight > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x += 1) {
      const s = row + (x * bpp) / 8;
      const o = (y * width + x) * 4;
      data[o] = buf[s + 2]!;
      data[o + 1] = buf[s + 1]!;
      data[o + 2] = buf[s]!;
      data[o + 3] = bpp === 32 ? buf[s + 3]! : 255;
    }
  }
  return { data, width, height };
}

export async function writeFixture(dir: string, name: string, data: Buffer | Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, data);
  return path;
}

// ---------------------------------------------------------------- EXIF builder

type TiffValue =
  | { readonly type: 'ascii'; readonly value: string }
  | { readonly type: 'short'; readonly value: readonly number[] }
  | { readonly type: 'long'; readonly value: readonly number[] }
  | { readonly type: 'rational'; readonly value: readonly (readonly [number, number])[] }
  | { readonly type: 'undefined'; readonly value: Buffer };

type Ifd = Map<number, TiffValue>;

const TYPE_CODE = { ascii: 2, short: 3, long: 4, rational: 5, undefined: 7 } as const;

function valueBytes(v: TiffValue): Buffer {
  switch (v.type) {
    case 'ascii':
      return Buffer.from(`${v.value}\u0000`, 'latin1');
    case 'short': {
      const b = Buffer.alloc(v.value.length * 2);
      v.value.forEach((n, i) => b.writeUInt16BE(n, i * 2));
      return b;
    }
    case 'long': {
      const b = Buffer.alloc(v.value.length * 4);
      v.value.forEach((n, i) => b.writeUInt32BE(n, i * 4));
      return b;
    }
    case 'rational': {
      const b = Buffer.alloc(v.value.length * 8);
      v.value.forEach(([n, d], i) => {
        b.writeUInt32BE(n, i * 8);
        b.writeUInt32BE(d, i * 8 + 4);
      });
      return b;
    }
    case 'undefined':
      return v.value;
  }
}

function valueCount(v: TiffValue): number {
  switch (v.type) {
    case 'ascii':
      return v.value.length + 1;
    case 'undefined':
      return v.value.length;
    default:
      return v.value.length;
  }
}

function ifdSize(ifd: Ifd): number {
  let data = 0;
  for (const v of ifd.values()) {
    const len = valueBytes(v).length;
    if (len > 4) data += len + (len & 1);
  }
  return 2 + ifd.size * 12 + 4 + data;
}

function writeIfd(ifd: Ifd, offset: number, next: number): Buffer {
  const out = Buffer.alloc(ifdSize(ifd));
  const tags = [...ifd.keys()].sort((a, b) => a - b);
  out.writeUInt16BE(tags.length, 0);
  let dataPos = 2 + tags.length * 12 + 4;
  tags.forEach((tag, i) => {
    const v = ifd.get(tag)!;
    const bytes = valueBytes(v);
    const e = 2 + i * 12;
    out.writeUInt16BE(tag, e);
    out.writeUInt16BE(TYPE_CODE[v.type], e + 2);
    out.writeUInt32BE(valueCount(v), e + 4);
    if (bytes.length <= 4) bytes.copy(out, e + 8);
    else {
      out.writeUInt32BE(offset + dataPos, e + 8);
      bytes.copy(out, dataPos);
      dataPos += bytes.length + (bytes.length & 1);
    }
  });
  out.writeUInt32BE(next, 2 + tags.length * 12);
  return out;
}

export interface ExifSpec {
  readonly orientation?: number;
  readonly make?: string;
  readonly model?: string;
  readonly software?: string;
  readonly dateTimeOriginal?: string;
  readonly exposureTime?: readonly [number, number];
  readonly fNumber?: readonly [number, number];
  readonly iso?: number;
  readonly lensModel?: string;
  readonly gps?: { readonly lat: number; readonly lon: number };
  readonly thumbnail?: Buffer;
}

function toDms(value: number): (readonly [number, number])[] {
  const abs = Math.abs(value);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = Math.round(((abs - d) * 60 - m) * 60 * 10000);
  return [
    [d, 1],
    [m, 1],
    [s, 10000],
  ];
}

/** Big-endian TIFF/EXIF payload (without the "Exif\0\0" prefix). */
export function buildTiffExif(spec: ExifSpec): Buffer {
  const ifd0: Ifd = new Map();
  if (spec.make) ifd0.set(0x010f, { type: 'ascii', value: spec.make });
  if (spec.model) ifd0.set(0x0110, { type: 'ascii', value: spec.model });
  if (spec.orientation) ifd0.set(0x0112, { type: 'short', value: [spec.orientation] });
  if (spec.software) ifd0.set(0x0131, { type: 'ascii', value: spec.software });
  const exif: Ifd = new Map();
  if (spec.dateTimeOriginal) exif.set(0x9003, { type: 'ascii', value: spec.dateTimeOriginal });
  if (spec.exposureTime) exif.set(0x829a, { type: 'rational', value: [spec.exposureTime] });
  if (spec.fNumber) exif.set(0x829d, { type: 'rational', value: [spec.fNumber] });
  if (spec.iso) exif.set(0x8827, { type: 'short', value: [spec.iso] });
  if (spec.lensModel) exif.set(0xa434, { type: 'ascii', value: spec.lensModel });
  const gps: Ifd = new Map();
  if (spec.gps) {
    gps.set(0x0001, { type: 'ascii', value: spec.gps.lat < 0 ? 'S' : 'N' });
    gps.set(0x0002, { type: 'rational', value: toDms(spec.gps.lat) });
    gps.set(0x0003, { type: 'ascii', value: spec.gps.lon < 0 ? 'W' : 'E' });
    gps.set(0x0004, { type: 'rational', value: toDms(spec.gps.lon) });
  }
  if (exif.size > 0) ifd0.set(0x8769, { type: 'long', value: [0] });
  if (gps.size > 0) ifd0.set(0x8825, { type: 'long', value: [0] });
  const ifd1: Ifd = new Map();
  if (spec.thumbnail) {
    ifd1.set(0x0103, { type: 'short', value: [6] });
    ifd1.set(0x0201, { type: 'long', value: [0] });
    ifd1.set(0x0202, { type: 'long', value: [spec.thumbnail.length] });
  }
  // Layout: header(8) IFD0 ExifIFD GPSIFD IFD1 thumbnail
  const off0 = 8;
  const offExif = off0 + ifdSize(ifd0);
  const offGps = offExif + (exif.size > 0 ? ifdSize(exif) : 0);
  const off1 = offGps + (gps.size > 0 ? ifdSize(gps) : 0);
  const offThumb = off1 + (ifd1.size > 0 ? ifdSize(ifd1) : 0);
  if (exif.size > 0) ifd0.set(0x8769, { type: 'long', value: [offExif] });
  if (gps.size > 0) ifd0.set(0x8825, { type: 'long', value: [offGps] });
  if (spec.thumbnail) ifd1.set(0x0201, { type: 'long', value: [offThumb] });
  const header = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]);
  return Buffer.concat([
    header,
    writeIfd(ifd0, off0, ifd1.size > 0 ? off1 : 0),
    exif.size > 0 ? writeIfd(exif, offExif, 0) : Buffer.alloc(0),
    gps.size > 0 ? writeIfd(gps, offGps, 0) : Buffer.alloc(0),
    ifd1.size > 0 ? writeIfd(ifd1, off1, 0) : Buffer.alloc(0),
    spec.thumbnail ?? Buffer.alloc(0),
  ]);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

export const exifSegment = (spec: ExifSpec): Buffer => jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), buildTiffExif(spec)]));

export const XMP_PACKET =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Secret Author</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>';

export const xmpSegment = (): Buffer => jpegSegment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\u0000', 'latin1'), Buffer.from(XMP_PACKET, 'utf8')]));

export function iptcSegment(caption: string): Buffer {
  const text = Buffer.from(caption, 'utf8');
  const iim = Buffer.concat([Buffer.from([0x1c, 0x02, 0x78]), Buffer.from([text.length >> 8, text.length & 255]), text]);
  const resource = Buffer.concat([
    Buffer.from('8BIM', 'latin1'),
    Buffer.from([0x04, 0x04, 0x00, 0x00]),
    Buffer.from([0, 0, (iim.length >> 8) & 255, iim.length & 255]),
    iim,
    iim.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
  return jpegSegment(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\u0000', 'latin1'), resource]));
}

export const commentSegment = (text: string): Buffer => jpegSegment(0xfe, Buffer.from(text, 'latin1'));

/** Insert segments right after SOI (and after APP0 JFIF if present). */
export function insertJpegSegments(jpeg: Buffer, segments: readonly Buffer[]): Buffer {
  let pos = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) pos = 4 + jpeg.readUInt16BE(4);
  return Buffer.concat([jpeg.subarray(0, pos), ...segments, jpeg.subarray(pos)]);
}

/** Bytes from the first SOS marker to EOI (the compressed image data). */
export function jpegScanData(jpeg: Buffer): Buffer {
  let pos = 2;
  while (pos < jpeg.length) {
    if (jpeg[pos] !== 0xff) throw new Error('bad jpeg');
    const marker = jpeg[pos + 1]!;
    if (marker === 0xda) return jpeg.subarray(pos);
    pos += 2 + jpeg.readUInt16BE(pos + 2);
  }
  throw new Error('no SOS');
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** Insert chunks right after IHDR (before IDAT, where decoders read eXIf/iCCP). */
export function insertPngChunks(png: Buffer, chunks: readonly Buffer[]): Buffer {
  if (png.toString('latin1', 12, 16) !== 'IHDR') throw new Error('IHDR not first');
  const afterIhdr = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, afterIhdr), ...chunks, png.subarray(afterIhdr)]);
}

/** Concatenated payloads of all chunks of a type. */
export function pngChunkData(png: Buffer, type: string): Buffer {
  const parts: Buffer[] = [];
  let pos = 8;
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos);
    if (png.toString('latin1', pos + 4, pos + 8) === type) parts.push(png.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  return Buffer.concat(parts);
}

export function pngChunkTypes(png: Buffer): string[] {
  const types: string[] = [];
  let pos = 8;
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos);
    types.push(png.toString('latin1', pos + 4, pos + 8));
    pos += 12 + len;
  }
  return types;
}

export function riffChunkTypes(webp: Buffer): string[] {
  const types: string[] = [];
  let pos = 12;
  while (pos + 8 <= webp.length) {
    const size = webp.readUInt32LE(pos + 4);
    types.push(webp.toString('latin1', pos, pos + 4));
    pos += 8 + size + (size & 1);
  }
  return types;
}

export function riffChunk(webp: Buffer, type: string): Buffer | null {
  let pos = 12;
  while (pos + 8 <= webp.length) {
    const size = webp.readUInt32LE(pos + 4);
    if (webp.toString('latin1', pos, pos + 4) === type) return webp.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size & 1);
  }
  return null;
}
