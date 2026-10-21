import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import sharp from 'sharp';
import type {
  CompressOptions,
  ImageFormat,
  JobWarning,
  PreviewRequest,
  PreviewResult,
  ProcessorJob,
  ProcessorResult,
  ProcessorRunContext,
  ProcessorSettings,
} from '@orbitdrop/contracts';
import { mapFsError } from '@orbitdrop/core/node';
import {
  canEncode,
  encodePreview,
  encodeToolImage,
  loadImage,
  parseToolOptions,
  regionHasTransparency,
  singleInput,
  stage,
  throwIfCancelled,
  toRaw,
  toToolError,
  writeToolOutput,
  type EncodedImage,
  type LoadedImage,
} from './common';
import { Lru, onClearPreviewCaches } from './source-cache';

/**
 * Compress (P1). Re-encodes with the chosen format/quality, optionally
 * downscaling so the longest edge ≤ maxEdge (never upscales).
 *  - format 'input': JPEG/PNG/WebP/AVIF keep their format (AVIF → WebP if it
 *    cannot be encoded); HEIC → JPEG; TIFF, BMP and GIF (first frame) → PNG.
 *  - JPEG: mozjpeg (progressive, trellis), 4:2:0 below quality 90.
 *  - WebP: lossy at `quality`, effort 6.
 *  - PNG: 'palette' = libimagequant quantization to ≤ 256 colours at `quality`
 *    (lossy, usually much smaller); 'lossless' = zlib level 9 recompression only.
 *  - keepMetadata copies EXIF/XMP/ICC (orientation is applied to the pixels and
 *    the tag reset to 1); otherwise everything is stripped and pixels converted
 *    to sRGB.
 * A result that is not smaller than the input still gets written but carries
 * the OUTPUT_LARGER_THAN_INPUT warning (never reported as a successful
 * compression). The preview reports `estimatedBytes` = the byte size of a real
 * full-resolution encode with the same options (cached per options), and its
 * image is decoded from that encoded result, so quality loss is visible; an
 * `estimateOnly` request (the per-file estimates of a batch) returns just the
 * size, dimensions and format of that encode, without an image.
 */

export function resolveCompressFormat(option: CompressOptions['format'], inputFormat: ImageFormat, avifOk: boolean): ImageFormat {
  if (option !== 'input') return option;
  switch (inputFormat) {
    case 'jpeg':
    case 'png':
    case 'webp':
      return inputFormat;
    case 'avif':
      return avifOk ? 'avif' : 'webp';
    case 'heic':
      return 'jpeg';
    case 'tiff':
    case 'bmp':
    case 'gif':
      return 'png';
  }
}

export interface CompressedImage extends EncodedImage {
  /** Transparent pixels were flattened onto white (JPEG target). */
  readonly alphaFlattened: boolean;
}

export async function encodeCompressed(image: LoadedImage, options: CompressOptions, settings: ProcessorSettings): Promise<CompressedImage> {
  const format = resolveCompressFormat(options.format, image.input.format, await canEncode('avif'));
  const resize = options.maxEdge !== null && Math.max(image.width, image.height) > options.maxEdge ? options.maxEdge : null;
  const encoded = await encodeToolImage(
    () => {
      const p = image.open();
      return resize === null ? p : p.resize({ width: resize, height: resize, fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: false });
    },
    {
      format,
      settings,
      quality: options.quality,
      hasAlpha: image.hasAlpha,
      flattenBackground: '#FFFFFF',
      keepMetadata: options.keepMetadata,
      png: { palette: options.pngMode === 'palette', compressionLevel: 9 },
      webp: { effort: 6 },
    },
  );
  const alphaFlattened = encoded.flattened && (await regionHasTransparency(image));
  return { ...encoded, alphaFlattened };
}

export async function runCompress(job: ProcessorJob, ctx: ProcessorRunContext): Promise<ProcessorResult> {
  const { signal } = ctx;
  const input = singleInput(job);
  const options = parseToolOptions('tool.compress', job.options);
  try {
    stage(ctx.onProgress, 'reading');
    const image = await loadImage(input, job.limits, signal);
    throwIfCancelled(signal);
    stage(ctx.onProgress, 'encoding');
    const encoded = await encodeCompressed(image, options, job.settings);
    const warnings: JobWarning[] = [];
    if (encoded.alphaFlattened) warnings.push({ code: 'ALPHA_FLATTENED', params: { background: '#FFFFFF' } });
    const inputBytes = image.buffer.length;
    if (encoded.data.length >= inputBytes) {
      warnings.push({ code: 'OUTPUT_LARGER_THAN_INPUT', params: { inputBytes, outputBytes: encoded.data.length } });
    }
    stage(ctx.onProgress, 'writing');
    const output = await writeToolOutput(job, input, encoded, signal, ctx.onCommitted);
    return { outputs: [output], warnings };
  } catch (error) {
    throw toToolError(error, signal);
  }
}

interface EncodeCacheEntry {
  readonly encoded: CompressedImage;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

/** What an estimate needs from an encode: a few numbers, so many fit. */
interface EstimateEntry {
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly format: ImageFormat;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

/** Full-resolution encodes by (file identity, options, settings): the expensive part. */
const encodeCache = new Lru<EncodeCacheEntry>(4, 128 * 1024 * 1024);
/** Finished previews by encode key + preview size. */
const previewCache = new Lru<PreviewResult>(12, 64 * 1024 * 1024);
/**
 * Size, dimensions and format of every encode by the same key (count-bounded,
 * ~100 bytes each). Filled by preview and estimate encodes alike, so the
 * per-file estimates of a batch are instant for options seen before even when
 * the 4-entry encode cache no longer holds the bytes.
 */
const estimateCache = new Lru<EstimateEntry>(512, 512);
let encodes = 0;

export function clearCompressCaches(): void {
  encodeCache.clear();
  previewCache.clear();
  estimateCache.clear();
}
// Main frees preview memory when the last editor closes; the encodes go with the decoded sources.
onClearPreviewCaches(clearCompressCaches);

/** Full-resolution preview/estimate encodes run so far in this worker (tests, diagnostics). */
export function compressEncodeCount(): number {
  return encodes;
}

/**
 * Full-resolution preview encodes run one at a time per worker. A request that
 * was superseded (aborted) while waiting never starts its encode, and a queued
 * request whose options were encoded in the meantime is served from the cache —
 * so dragging the quality slider (or a batch of estimates) cannot pile up
 * full-size encodes.
 */
let encodeChain: Promise<unknown> = Promise.resolve();

function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = encodeChain.then(task, task);
  encodeChain = run.catch(() => undefined);
  return run;
}

async function encodeKeyFor(request: PreviewRequest, options: CompressOptions): Promise<string> {
  let info;
  try {
    info = await stat(request.input.path);
  } catch (error) {
    throw mapFsError(error, 'READ_PERMISSION_DENIED');
  }
  return createHash('sha256')
    .update(JSON.stringify([request.input.path, info.size, info.mtimeMs, options, request.settings]))
    .digest('hex');
}

function estimateOf(entry: EncodeCacheEntry): EstimateEntry {
  const { encoded } = entry;
  return { bytes: encoded.data.length, width: encoded.width, height: encoded.height, format: encoded.format, sourceWidth: entry.sourceWidth, sourceHeight: entry.sourceHeight };
}

/** One full-resolution encode (call inside `serially`); always records its estimate. */
async function encodeNow(request: PreviewRequest, options: CompressOptions, key: string, signal: AbortSignal): Promise<EncodeCacheEntry> {
  throwIfCancelled(signal);
  const image = await loadImage(request.input, request.limits, signal);
  throwIfCancelled(signal);
  encodes += 1;
  const entry: EncodeCacheEntry = { encoded: await encodeCompressed(image, options, request.settings), sourceWidth: image.width, sourceHeight: image.height };
  estimateCache.set(key, estimateOf(entry));
  return entry;
}

/** The encoded bytes for these options (the preview image is decoded from them). */
async function encodedFor(request: PreviewRequest, options: CompressOptions, key: string, signal: AbortSignal): Promise<EncodeCacheEntry> {
  return (
    encodeCache.get(key) ??
    serially(async () => {
      const cached = encodeCache.get(key);
      if (cached) return cached;
      const fresh = await encodeNow(request, options, key, signal);
      encodeCache.set(key, fresh, fresh.encoded.data.length);
      return fresh;
    })
  );
}

/**
 * Only the size for these options: from the estimate cache, else from cached
 * bytes, else one encode whose bytes are not kept (the four byte slots stay
 * with the previews the editor shows).
 */
async function estimateFor(request: PreviewRequest, options: CompressOptions, key: string, signal: AbortSignal): Promise<EstimateEntry> {
  const known = (): EstimateEntry | undefined => {
    const hit = estimateCache.get(key);
    if (hit) return hit;
    const bytes = encodeCache.get(key);
    return bytes ? estimateOf(bytes) : undefined;
  };
  return known() ?? serially(async () => known() ?? estimateOf(await encodeNow(request, options, key, signal)));
}

/**
 * Compress preview. `estimatedBytes` is the byte length of a real
 * full-resolution encode with these options (what the job would write) and the
 * image is decoded from that encode. With `estimateOnly` (per-file estimates
 * of a batch) no image is rendered: `data` is empty and width/height are 0.
 * `outputFormat` is the format actually encoded ('input' resolved).
 */
export async function previewCompress(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult> {
  const options = parseToolOptions('tool.compress', request.options);
  try {
    const key = await encodeKeyFor(request, options);
    if (request.estimateOnly === true) {
      const estimate = await estimateFor(request, options, key, signal);
      throwIfCancelled(signal);
      return {
        data: new Uint8Array(0),
        mime: 'image/png',
        width: 0,
        height: 0,
        sourceWidth: estimate.sourceWidth,
        sourceHeight: estimate.sourceHeight,
        outputWidth: estimate.width,
        outputHeight: estimate.height,
        estimatedBytes: estimate.bytes,
        outputFormat: estimate.format,
      };
    }
    const maxEdge = Math.max(16, Math.floor(request.maxEdge));
    const previewKey = `${key}:${maxEdge}`;
    const hit = previewCache.get(previewKey);
    if (hit) return hit;

    const entry = await encodedFor(request, options, key, signal);
    throwIfCancelled(signal);
    const { encoded } = entry;
    // Decode the real encoded bytes so the preview shows the actual artefacts. The result is never
    // larger than the input, so the input pixel limit applies (jobs accept that much, too).
    const raw = await toRaw(
      sharp(encoded.data, { limitInputPixels: request.limits.maxInputPixels })
        .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .ensureAlpha(),
    );
    const preview = await encodePreview(raw, { lossless: true });
    const result: PreviewResult = {
      data: preview.data,
      mime: preview.mime,
      width: preview.width,
      height: preview.height,
      sourceWidth: entry.sourceWidth,
      sourceHeight: entry.sourceHeight,
      outputWidth: encoded.width,
      outputHeight: encoded.height,
      estimatedBytes: encoded.data.length,
      outputFormat: encoded.format,
    };
    previewCache.set(previewKey, result, preview.data.length + 1024);
    return result;
  } catch (error) {
    throw toToolError(error, signal);
  }
}
