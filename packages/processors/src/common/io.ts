import { open, type FileHandle } from 'node:fs/promises';
import sharp, { type JpegOptions, type Metadata, type Sharp, type SharpOptions } from 'sharp';
import {
  FORMAT_INFO,
  OrbitError,
  type ImageFormat,
  type JobWarning,
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
  let handle: FileHandle;
  try {
    handle = await open(input.path, 'r');
  } catch (error) {
    throw mapFsError(error, 'READ_PERMISSION_DENIED');
  }
  try {
    // The size main validated may be stale (the file can grow or be emptied before the job runs):
    // check the file being read, before reading it.
    const { size } = await handle.stat();
    if (size > limits.maxInputBytes) throw new OrbitError('FILE_TOO_LARGE', 'File is larger than the limit', { detail: `${size} > ${limits.maxInputBytes}` });
    if (size === 0) throw new OrbitError('FILE_EMPTY', 'File is empty');
    const data = await handle.readFile(signal ? { signal } : undefined);
    if (data.length === 0) throw new OrbitError('FILE_EMPTY', 'File is empty');
    return data;
  } catch (error) {
    if (error instanceof OrbitError) throw error;
    if (signal?.aborted) throw new OrbitError('CANCELLED', 'Cancelled', { cause: error });
    throw mapFsError(error, 'READ_PERMISSION_DENIED');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const READ_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * Read a whole input straight into a freshly allocated ArrayBuffer of exactly
 * the file's size and return it as a plain Uint8Array — not a Node Buffer and
 * never a view into Node's shared pool (64 KiB slabs in Electron). PDF.js takes
 * such an array as is and transfers its buffer to its in-process worker, so a
 * PDF job holds the file once instead of twice. The caller hands ownership to
 * the consumer (the array is detached after PDF.js has taken it).
 */
export async function readInputBytes(input: ProcessorInput, limits: ProcessingLimits, signal?: AbortSignal): Promise<Uint8Array> {
  if (input.bytes > limits.maxInputBytes) throw new OrbitError('FILE_TOO_LARGE', 'File is larger than the limit');
  if (signal?.aborted) throw new OrbitError('CANCELLED', 'Cancelled');
  let handle: FileHandle;
  try {
    handle = await open(input.path, 'r');
  } catch (error) {
    throw mapFsError(error, 'READ_PERMISSION_DENIED');
  }
  try {
    const { size } = await handle.stat();
    if (size > limits.maxInputBytes) throw new OrbitError('FILE_TOO_LARGE', 'File is larger than the limit', { detail: `${size} > ${limits.maxInputBytes}` });
    if (size === 0) throw new OrbitError('FILE_EMPTY', 'File is empty');
    const bytes = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      if (signal?.aborted) throw new OrbitError('CANCELLED', 'Cancelled');
      const { bytesRead } = await handle.read(bytes, filled, Math.min(READ_CHUNK_BYTES, size - filled), filled);
      if (bytesRead === 0) break; // the file shrank while reading
      filled += bytesRead;
    }
    return filled === size ? bytes : bytes.slice(0, filled);
  } catch (error) {
    if (error instanceof OrbitError) throw error;
    if (signal?.aborted) throw new OrbitError('CANCELLED', 'Cancelled', { cause: error });
    throw mapFsError(error, 'READ_PERMISSION_DENIED');
  } finally {
    await handle.close().catch(() => undefined);
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

function isEightBit(meta: Metadata): boolean {
  return meta.depth === 'uchar' || meta.depth === 'char';
}

/**
 * 8-bit stand-in for an input that is not 8 bits per channel (16-bit PNG/TIFF, 10/12-bit
 * AVIF, float TIFF, the 16-bit PNG ImageIO decodes a 10-bit HEIC to): a lossless PNG with
 * the same geometry — no rotation, the EXIF orientation stays a tag and is applied by
 * autoOrient() on 8-bit data — the RGB ICC profile kept as is (CMYK converted to sRGB, grey
 * kept grey) and EXIF/XMP carried. `unrotated` must be a plain pipeline over the input.
 *
 * Why: sharp 0.35 mishandles high-bit-depth input in several paths. RGB16 with an embedded
 * profile (any, sRGB included) is processed in Display P3 and written back without converting
 * or tagging it — conversions were off by up to 57 levels against ColorSync (measured); asking
 * for an explicit sRGB output profile fixes that but shifts untagged RGB16 instead. recomb
 * casts to 8-bit before linear, and rotating 16-bit data drops a kept profile. Outputs are
 * 8-bit anyway, and sharp's 8-bit paths handle every profile correctly.
 */
export async function toEightBit(unrotated: Sharp, meta: Metadata): Promise<Buffer> {
  const hasProfile = meta.hasProfile === true || meta.icc !== undefined;
  const keepIcc = hasProfile && (meta.space === 'srgb' || meta.space === 'rgb16');
  const grey = meta.space === 'b-w' || meta.space === 'grey16';
  let pipeline = (keepIcc ? unrotated.keepIccProfile() : unrotated).keepExif().keepXmp();
  pipeline = pipeline.toColourspace(grey ? 'b-w' : 'srgb');
  return pipeline.png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer();
}

/** A decoded input for the conversions: its stored metadata and a factory of 8-bit pipelines. */
export interface ImageSource {
  /**
   * Metadata of the input as stored (orientation, profile, depth, pages, EXIF/XMP/IPTC…);
   * for BMP and HEIC that of the decoded pixels (our codec, ImageIO).
   */
  readonly meta: Metadata;
  /**
   * A fresh auto-oriented 8-bit pipeline each call, built from one shared buffer (never
   * `Sharp.clone()`, which deep-copies its input — +1 GiB for a decoded 16k×16k BMP).
   */
  open(): Sharp;
}

/**
 * Decode once for conversions (image → image, images → PDF, image → DOCX): BMP through our
 * codec, HEIC through ImageIO, everything else by sharp. High-bit-depth input is reduced to 8
 * bits first (toEightBit), so a 16-bit PNG with a profile converts to the right sRGB colours.
 */
export async function openImageSource(buffer: Buffer, format: ImageFormat, limits: ProcessingLimits): Promise<ImageSource> {
  configureSharp();
  const options: SharpOptions = { limitInputPixels: limits.maxInputPixels, failOn: 'error', animated: false };
  if (format === 'bmp') {
    const raw = decodeBmp(buffer, limits.maxInputPixels);
    const open = (): Sharp => sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 }, limitInputPixels: limits.maxInputPixels });
    return { meta: await open().metadata(), open };
  }
  const decoded = format === 'heic' ? await decodeWithImageIO(buffer) : buffer;
  const meta = await sharp(decoded, options).metadata();
  if (isEightBit(meta)) return { meta, open: () => sharp(decoded, options).autoOrient() };
  const intermediate = await toEightBit(sharp(decoded, options), meta);
  return { meta, open: () => sharp(intermediate, options).autoOrient() };
}

/** Frames of an animated PNG from its acTL chunk (libvips reads only the default image), or 0. */
export function apngFrameCount(buffer: Uint8Array): number {
  const view = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.length < 8 || view.readUInt32BE(0) !== 0x89504e47) return 0;
  let pos = 8;
  while (pos + 12 <= view.length) {
    const length = view.readUInt32BE(pos);
    const type = view.toString('latin1', pos + 4, pos + 8);
    if (type === 'acTL' && length >= 8) return view.readUInt32BE(pos + 8); // num_frames
    if (type === 'IDAT' || type === 'IEND') return 0;
    pos += 12 + length;
  }
  return 0;
}

/**
 * Frames or pages the conversions and tools do not use: they process the first frame of an
 * animation (GIF, WebP, APNG) and the first page of a multi-page TIFF/HEIF. Null when the input
 * has only one. Reported as FIRST_FRAME_ONLY / FIRST_PAGE_ONLY so nothing is dropped silently.
 */
export function droppedFrames(format: ImageFormat, meta: Pick<Metadata, 'pages'>, buffer: Uint8Array): DroppedFrames | null {
  const pages = format === 'png' ? apngFrameCount(buffer) : (meta.pages ?? 1);
  if (!(pages > 1)) return null;
  return { kind: format === 'gif' || format === 'webp' || format === 'png' ? 'frames' : 'pages', count: pages };
}

export interface DroppedFrames {
  readonly kind: 'frames' | 'pages';
  /** Frames/pages in the file (only the first was used). */
  readonly count: number;
}

/** FIRST_FRAME_ONLY {frames, files} / FIRST_PAGE_ONLY {pages, files}: `files` = inputs it applies to. */
export function framesWarning(dropped: DroppedFrames, files: number): JobWarning {
  return dropped.kind === 'frames'
    ? { code: 'FIRST_FRAME_ONLY', params: { frames: dropped.count, files } }
    : { code: 'FIRST_PAGE_ONLY', params: { pages: dropped.count, files } };
}

/** Wraps decoder failures (corrupt/truncated data, pixel limit) into OrbitErrors. */
export function mapSharpError(error: unknown): OrbitError {
  if (error instanceof OrbitError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit/i.test(message)) return new OrbitError('IMAGE_TOO_LARGE', 'Image exceeds the pixel limit', { cause: error });
  // Loader prefixes as libvips 8.18 reports them ("vipspng: libpng read error" for a truncated PNG).
  if (/unsupported image format|bad seek|premature end|corrupt|invalid|truncated|VipsJpeg|vipspng|libpng|libspng|pngload|webpload|heifload|tiffload|gifload/i.test(message)) {
    return new OrbitError('IMAGE_CORRUPT', 'Image could not be decoded', { detail: message.slice(0, 300), cause: error });
  }
  return new OrbitError('INTERNAL', 'Image processing failed', { detail: message.slice(0, 300), cause: error });
}

/**
 * keepMetadata() for an output pipeline. On CMYK input, sharp's keepMetadata()/keepIccProfile()
 * convert to sRGB with sharp's built-in CMYK profile instead of the embedded one (52–55 levels
 * off against ColorSync, measured) and then tag the result sRGB; asking for the sRGB output
 * profile explicitly makes the conversion use the embedded profile. RGB profiles are kept as is.
 */
export function keepMetadataFor(pipeline: Sharp, space: string | undefined): Sharp {
  const kept = pipeline.keepMetadata();
  return space === 'cmyk' ? kept.withIccProfile('srgb') : kept;
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
 * Above this many pixels a JPEG is written in one streaming pass: baseline with
 * the standard Huffman tables. mozjpeg (progressive scans, trellis) and
 * optimised Huffman tables keep every DCT coefficient of the image in memory —
 * measured with sharp 0.35.5 at 256 Mpx: mozjpeg 2.11 GB, baseline + optimised
 * tables 1.75 GB, streaming 0.24 GB. The file is larger (up to ~5× for flat
 * images), which is the price for not swapping with several workers.
 */
export const STREAMING_JPEG_PIXELS = 60_000_000;

export function streamsJpeg(pixels: number): boolean {
  return pixels > STREAMING_JPEG_PIXELS;
}

/** JPEG settings for an output of `pixels` pixels; 4:4:4 chroma from quality 90 unless given. */
export function jpegOptions(quality: number, pixels: number, chroma?: '4:2:0' | '4:4:4'): JpegOptions {
  const chromaSubsampling = chroma ?? (quality >= 90 ? '4:4:4' : '4:2:0');
  if (streamsJpeg(pixels)) {
    return {
      quality,
      chromaSubsampling,
      mozjpeg: false,
      progressive: false,
      optimiseCoding: false,
      trellisQuantisation: false,
      overshootDeringing: false,
      optimiseScans: false,
    };
  }
  return { quality, chromaSubsampling, mozjpeg: true };
}

/** Pixels of one frame/page of an image (what an encoder writes for a single-image format). */
export function framePixels(meta: Pick<Metadata, 'width' | 'height' | 'pageHeight'>): number {
  return (meta.width ?? 0) * (meta.pageHeight ?? meta.height ?? 0);
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
  if (options.keepMetadata) pipeline = keepMetadataFor(pipeline, meta.space);
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
      pipeline = pipeline.jpeg(jpegOptions(quality, framePixels(meta)));
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
