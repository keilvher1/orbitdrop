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
import { Lru } from './source-cache';

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
 * image is decoded from that encoded result, so quality loss is visible.
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
    const output = await writeToolOutput(job, input, encoded, signal);
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

/** Full-resolution encodes by (file identity, options, settings): the expensive part. */
const encodeCache = new Lru<EncodeCacheEntry>(4, 128 * 1024 * 1024);
/** Finished previews by encode key + preview size. */
const previewCache = new Lru<PreviewResult>(12, 64 * 1024 * 1024);

export function clearCompressCaches(): void {
  encodeCache.clear();
  previewCache.clear();
}

export async function previewCompress(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult> {
  const options = parseToolOptions('tool.compress', request.options);
  try {
    let info;
    try {
      info = await stat(request.input.path);
    } catch (error) {
      throw mapFsError(error, 'READ_PERMISSION_DENIED');
    }
    const maxEdge = Math.max(16, Math.floor(request.maxEdge));
    const encodeKey = createHash('sha256')
      .update(JSON.stringify([request.input.path, info.size, info.mtimeMs, options, request.settings]))
      .digest('hex');
    const previewKey = `${encodeKey}:${maxEdge}`;
    const hit = previewCache.get(previewKey);
    if (hit) return hit;

    let entry = encodeCache.get(encodeKey);
    if (!entry) {
      const image = await loadImage(request.input, request.limits, signal);
      throwIfCancelled(signal);
      entry = { encoded: await encodeCompressed(image, options, request.settings), sourceWidth: image.width, sourceHeight: image.height };
      encodeCache.set(encodeKey, entry, entry.encoded.data.length);
    }
    throwIfCancelled(signal);
    const { encoded } = entry;
    // Decode the real encoded bytes so the preview shows the actual artefacts.
    const raw = await toRaw(
      sharp(encoded.data, { limitInputPixels: request.limits.maxOutputPixels })
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
    };
    previewCache.set(previewKey, result, preview.data.length + 1024);
    return result;
  } catch (error) {
    throw toToolError(error, signal);
  }
}
