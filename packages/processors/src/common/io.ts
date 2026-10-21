import { readFile } from 'node:fs/promises';
import sharp, { type Sharp, type SharpOptions } from 'sharp';
import {
  FORMAT_INFO,
  OrbitError,
  type ImageFormat,
  type ProcessingLimits,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorSettings,
} from '@orbitdrop/contracts';
import { mapFsError, writeOutput } from '@orbitdrop/core/node';
import { decodeBmp, encodeBmp } from '../codecs/bmp';
import { decodeWithImageIO, encodeWithImageIO } from '../codecs/imageio';

/**
 * Shared image I/O for all executors.
 * - Files are read through Node fs (handles long Windows paths, Unicode and
 *   network paths consistently) and handed to sharp as buffers.
 * - EXIF orientation is always applied to pixels first, so every coordinate the
 *   editors send (oriented space) maps 1:1 onto the decoded image.
 * - Results are written through @orbitdrop/core's safe output (temp file +
 *   exclusive commit, never overwriting).
 */

let configured = false;
export function configureSharp(): void {
  if (configured) return;
  configured = true;
  // Keep the libvips operation cache small: the worker is long-lived and handles many files.
  sharp.cache({ memory: 64, files: 0, items: 50 });
}

export async function readInputBuffer(input: ProcessorInput, limits: ProcessingLimits, signal?: AbortSignal): Promise<Buffer> {
  if (input.bytes > limits.maxInputBytes) throw new OrbitError('FILE_TOO_LARGE', 'File is larger than the limit');
  try {
    return await readFile(input.path, signal ? { signal } : undefined);
  } catch (error) {
    if (signal?.aborted) throw new OrbitError('CANCELLED', 'Cancelled', { cause: error });
    throw mapFsError(error, 'READ_PERMISSION_DENIED');
  }
}

/** Open an image buffer with limits and auto-orientation; non-sharp formats go through our codecs. */
export async function openImage(buffer: Buffer, format: ImageFormat, limits: ProcessingLimits): Promise<Sharp> {
  configureSharp();
  const options: SharpOptions = { limitInputPixels: limits.maxInputPixels, failOn: 'error', animated: false };
  if (format === 'bmp') {
    const raw = decodeBmp(buffer, limits.maxInputPixels);
    return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 }, limitInputPixels: limits.maxInputPixels });
  }
  if (format === 'heic') {
    const png = await decodeWithImageIO(buffer);
    return sharp(png, options).autoOrient();
  }
  return sharp(buffer, options).autoOrient();
}

/** Wraps decoder failures (corrupt/truncated data, pixel limit) into OrbitErrors. */
export function mapSharpError(error: unknown): OrbitError {
  if (error instanceof OrbitError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit/i.test(message)) return new OrbitError('IMAGE_TOO_LARGE', 'Image exceeds the pixel limit', { cause: error });
  if (/unsupported image format|bad seek|premature end|corrupt|invalid|truncated|VipsJpeg|pngload|webpload|heifload|tiffload|gifload/i.test(message)) {
    return new OrbitError('IMAGE_CORRUPT', 'Image could not be decoded', { detail: message.slice(0, 300), cause: error });
  }
  return new OrbitError('INTERNAL', 'Image processing failed', { detail: message.slice(0, 300), cause: error });
}

export interface EncodeOptions {
  readonly quality?: number;
  /** Background for formats without alpha. */
  readonly flattenBackground?: string;
  readonly keepMetadata?: boolean;
  /** PNG palette quantization (lossy) for compression. */
  readonly pngPalette?: boolean;
}

export function defaultQuality(format: ImageFormat, settings: ProcessorSettings): number {
  switch (format) {
    case 'jpeg':
      return settings.jpegQuality;
    case 'webp':
      return settings.webpQuality;
    case 'avif':
      return settings.avifQuality;
    case 'heic':
      return settings.heicQuality;
    default:
      return 100;
  }
}

/**
 * Encode to the target format. Returns the encoded bytes and whether alpha had
 * to be flattened. Metadata is dropped unless keepMetadata is set (orientation
 * is already applied to the pixels, so dropping EXIF never rotates the image).
 */
export async function encodeImage(
  image: Sharp,
  format: ImageFormat,
  settings: ProcessorSettings,
  options: EncodeOptions = {},
): Promise<{ data: Buffer; width: number; height: number; flattened: boolean }> {
  const meta = await image.metadata();
  const hasAlpha = meta.hasAlpha === true;
  let pipeline = image;
  let flattened = false;
  if (!FORMAT_INFO[format].alpha && hasAlpha) {
    pipeline = pipeline.flatten({ background: options.flattenBackground ?? '#FFFFFF' });
    flattened = true;
  }
  if (options.keepMetadata) pipeline = pipeline.keepMetadata();
  const quality = options.quality ?? defaultQuality(format, settings);

  if (format === 'bmp') {
    const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: encodeBmp({ data, width: info.width, height: info.height }), width: info.width, height: info.height, flattened };
  }
  if (format === 'heic') {
    const png = await pipeline.png().toBuffer();
    const out = await encodeWithImageIO(png, 'heic', quality);
    const m = await sharp(png).metadata();
    return { data: out, width: m.width ?? 0, height: m.height ?? 0, flattened };
  }

  switch (format) {
    case 'jpeg':
      pipeline = pipeline.jpeg({ quality, mozjpeg: true, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' });
      break;
    case 'png':
      // Level 6 (zlib's default) is ~12× faster than 9 on large images for ~20% larger files.
      pipeline = pipeline.png(options.pngPalette ? { palette: true, quality, effort: 8, compressionLevel: 9 } : { compressionLevel: 6 });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality, effort: 5 });
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality, effort: 4 });
      break;
    case 'tiff':
      pipeline = pipeline.tiff({ compression: 'lzw' });
      break;
    case 'gif':
      pipeline = pipeline.gif();
      break;
  }
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, flattened };
}

/** Folder for a job's outputs: an explicit folder chosen by the user, else next to the input. */
export function outputDirFor(job: ProcessorJob, input: ProcessorInput): string {
  return job.outputDir ?? input.sourceDir;
}

/** Write encoded bytes under a free name in `dir`. Returns the final path. */
export async function writeBytes(dir: string, name: string, jobId: string, data: Uint8Array, signal?: AbortSignal): Promise<string> {
  const { writeFile } = await import('node:fs/promises');
  return writeOutput(dir, name, jobId, (tempPath) => writeFile(tempPath, data), signal);
}
