import sharp, { type Metadata } from 'sharp';
import {
  OrbitError,
  type ImageFormat,
  type ImageInfo,
  type ProcessingLimits,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorRunContext,
} from '@orbitdrop/contracts';
import { readInputBuffer } from '../common/io';
import {
  encodeToolImage,
  loadImage,
  parseToolOptions,
  requireImageInput,
  resolveToolFormat,
  singleInput,
  stage,
  throwIfCancelled,
  toToolError,
  writeToolOutput,
  type EncodedImage,
  type LoadedImage,
} from './common';
import { summarizeExif } from './exif';
import { iccDescription, isSrgbProfile } from './icc';
import { stripGif, stripJpeg, stripPng, stripWebp } from './metadata-lossless';

/**
 * Metadata (P1): read (`inspectImage`) and "strip" — a NEW copy without EXIF
 * (incl. GPS and embedded thumbnails), XMP, IPTC, comments and other
 * non-visual metadata. Arbitrary metadata editing is not offered.
 *
 * Which path is used:
 *  1. Lossless (bytes of the compressed image untouched, see
 *     metadata-lossless.ts) when ALL hold: the output format equals the input
 *     format and is JPEG, PNG, WebP or GIF; the EXIF orientation is absent or 1
 *     (otherwise removing EXIF would change how the image is displayed); and no
 *     colour conversion is needed — iccPolicy 'keep', or no ICC profile, or an
 *     sRGB profile (dropping it changes nothing visually).
 *  2. Re-encode otherwise (orientation ≠ 1 → pixels rotated; a non-sRGB
 *     profile with 'convertToSrgb' → pixels converted to sRGB and the profile
 *     dropped; 'keep' → profile attached, pixels unchanged; or a format
 *     change). JPEG/WebP/AVIF are re-encoded at quality 95 (4:4:4 chroma for
 *     JPEG), lossless WebP stays lossless, PNG/TIFF are lossless.
 *  The lossless result is verified (it must decode and carry no EXIF/XMP/IPTC);
 *  if verification fails the re-encode path is used instead.
 */

const REENCODE_QUALITY = 95;

function bitDepthLabel(meta: Metadata): string | null {
  if (meta.bitsPerSample && meta.bitsPerSample < 8) return `${meta.bitsPerSample}-bit`;
  switch (meta.depth) {
    case 'uchar':
    case 'char':
      return '8-bit';
    case 'ushort':
    case 'short':
      return '16-bit';
    case 'uint':
    case 'int':
      return '32-bit';
    case 'float':
      return '32-bit float';
    case 'double':
      return '64-bit float';
    default:
      return meta.depth ?? null;
  }
}

async function readMetadata(input: ProcessorInput & { format: ImageFormat }, buffer: Buffer, limits: ProcessingLimits): Promise<Metadata> {
  try {
    return await sharp(buffer, { limitInputPixels: limits.maxInputPixels, failOn: 'none' }).metadata();
  } catch (error) {
    // Formats sharp cannot parse itself (BMP, HEIC without libheif HEVC) go through our decoders.
    if (input.format === 'bmp' || input.format === 'heic') {
      const loaded = await loadImage(input, limits);
      return loaded.meta;
    }
    throw error;
  }
}

export async function inspectImage(input: ProcessorInput, limits: ProcessingLimits): Promise<ImageInfo> {
  const image = requireImageInput(input);
  const buffer = await readInputBuffer(image, limits);
  try {
    const meta = await readMetadata(image, buffer, limits);
    const orientation = meta.orientation ?? null;
    const swap = orientation !== null && orientation >= 5 && orientation <= 8;
    return {
      format: image.format,
      bytes: buffer.length,
      width: meta.width,
      height: meta.height,
      orientedWidth: meta.autoOrient?.width ?? (swap ? meta.height : meta.width),
      orientedHeight: meta.autoOrient?.height ?? (swap ? meta.width : meta.height),
      orientation,
      hasAlpha: meta.hasAlpha === true,
      channels: meta.channels,
      space: meta.space ?? null,
      density: meta.density ?? null,
      bitDepth: bitDepthLabel(meta),
      hasIccProfile: meta.hasProfile === true || meta.icc !== undefined,
      iccDescription: iccDescription(meta.icc),
      hasExif: meta.exif !== undefined && meta.exif.length > 0,
      hasXmp: meta.xmp !== undefined && meta.xmp.length > 0,
      hasIptc: meta.iptc !== undefined && meta.iptc.length > 0,
      exif: summarizeExif(meta.exif),
      pages: meta.pages ?? null,
    };
  } catch (error) {
    throw toToolError(error);
  }
}

export type StripMethod = 'lossless' | 'reencode';

export interface StripResult extends EncodedImage {
  readonly method: StripMethod;
}

function losslessStrip(format: ImageFormat, buffer: Buffer, keepIcc: boolean): Buffer | null {
  switch (format) {
    case 'jpeg':
      return stripJpeg(buffer, { keepIcc });
    case 'png':
      return stripPng(buffer, { keepIcc });
    case 'webp':
      return stripWebp(buffer, { keepIcc });
    case 'gif':
      return stripGif(buffer, { keepIcc });
    default:
      return null;
  }
}

async function verifyStripped(data: Buffer, keepIcc: boolean, limits: ProcessingLimits): Promise<{ width: number; height: number } | null> {
  try {
    const meta = await sharp(data, { limitInputPixels: limits.maxInputPixels, failOn: 'error' }).metadata();
    if (meta.exif || meta.xmp || meta.iptc) return null;
    if (!keepIcc && meta.icc) return null;
    if (meta.orientation !== undefined && meta.orientation !== 1) return null;
    // Decode every scan (at reduced size where the codec allows it) to prove the data is intact.
    await sharp(data, { limitInputPixels: limits.maxInputPixels, failOn: 'error' }).resize(64, 64, { fit: 'inside' }).raw().toBuffer();
    return { width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

/** Remove metadata from an image; see the file comment for the lossless/re-encode rules. */
export async function stripMetadata(
  image: LoadedImage,
  options: { iccPolicy: 'convertToSrgb' | 'keep'; outputFormat: 'input' | 'png' | 'jpeg' | 'webp' },
  settings: ProcessorJob['settings'],
  limits: ProcessingLimits,
): Promise<StripResult> {
  const format = await resolveToolFormat(options.outputFormat, image.input.format);
  const sameFormat = format === image.input.format || (options.outputFormat === 'input' && image.input.format === 'gif');
  const orientation = image.meta.orientation ?? 1;
  const hasIcc = image.meta.icc !== undefined || image.meta.hasProfile === true;
  const srgb = hasIcc && isSrgbProfile(iccDescription(image.meta.icc));
  const noColourChange = options.iccPolicy === 'keep' || !hasIcc || srgb;

  if (sameFormat && orientation === 1 && noColourChange) {
    // Lossless: 'keep' keeps the profile bytes whatever the colour space (CMYK, grey, RGB).
    const keepBytes = options.iccPolicy === 'keep' && hasIcc;
    const stripped = losslessStrip(image.input.format, image.buffer, keepBytes);
    if (stripped) {
      const size = await verifyStripped(stripped, keepBytes, limits);
      if (size) return { data: stripped, width: size.width, height: size.height, format: image.input.format, flattened: false, method: 'lossless' };
    }
  }
  // Re-encode: an RGB profile can be attached as is; CMYK/grey profiles are converted to sRGB.
  const keepIcc = options.iccPolicy === 'keep' && image.keepIcc;

  const target = format;
  const losslessWebp = image.input.format === 'webp' && target === 'webp' && image.buffer.includes(Buffer.from('VP8L'));
  const encoded = await encodeToolImage(() => image.open(), {
    format: target,
    settings,
    quality: REENCODE_QUALITY,
    hasAlpha: image.hasAlpha,
    flattenBackground: '#FFFFFF',
    keepIcc,
    jpegChroma: '4:4:4',
    webp: { lossless: losslessWebp },
  });
  return { ...encoded, method: 'reencode' };
}

export async function runMetadata(job: ProcessorJob, ctx: ProcessorRunContext): Promise<ProcessorResult> {
  const { signal } = ctx;
  const input = singleInput(job);
  const options = parseToolOptions('tool.metadata', job.options);
  try {
    stage(ctx.onProgress, 'reading');
    const image = await loadImage(input, job.limits, signal);
    throwIfCancelled(signal);
    stage(ctx.onProgress, 'encoding');
    const result = await stripMetadata(image, options, job.settings, job.limits);
    if (result.data.length === 0) throw new OrbitError('INTERNAL', 'Empty result');
    const warnings = result.flattened ? [{ code: 'ALPHA_FLATTENED' as const, params: { background: '#FFFFFF' } }] : [];
    stage(ctx.onProgress, 'writing');
    const output = await writeToolOutput(job, input, result, signal, ctx.onCommitted);
    return { outputs: [output], warnings };
  } catch (error) {
    throw toToolError(error, signal);
  }
}
