import { lstat } from 'node:fs/promises';
import { extname } from 'node:path';
import sharp, { type Metadata, type Sharp } from 'sharp';
import {
  ACTIONS,
  FORMAT_INFO,
  OrbitError,
  isImageFormat,
  parseActionOptions,
  type ActionOptions,
  type ImageFormat,
  type JobProgress,
  type JobWarning,
  type ProcessingLimits,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorOutput,
  type ProcessorRunContext,
  type ProcessorSettings,
  type ToolActionId,
  type ToolOutputFormat,
} from '@orbitdrop/contracts';
import { toolResultName } from '@orbitdrop/core';
import { imageIOHelperPath, isExecutableFile } from '../codecs/imageio';
import {
  defaultQuality,
  droppedFrames,
  encodeImage,
  framesWarning,
  keepMetadataFor,
  mapSharpError,
  openImage,
  outputDirFor,
  readInputBuffer,
  toEightBit,
  writeBytes,
  type DroppedFrames,
} from '../common/io';

/**
 * Helpers shared by the tool executors (crop, add background, compress,
 * metadata, edit, annotate, redact) and their previews.
 *
 * Colour policy (documented in docs/workstreams/processors-edit.md):
 *  - Same-image tools (crop, edit, annotate, redact) keep an embedded RGB ICC
 *    profile and the stored pixel values (no gamut clipping); colours they draw
 *    are converted from sRGB into that profile (profile.ts). CMYK/grey profiles
 *    are converted to sRGB because PNG/WebP cannot store CMYK.
 *  - Add Background converts the content to sRGB (the backgrounds are sRGB).
 *  - EXIF/XMP/IPTC are never copied by these tools (orientation is applied to
 *    the pixels first, so dropping EXIF never rotates the result).
 *  - Output is 8 bits per channel.
 */

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OrbitError('CANCELLED', 'Cancelled');
}

/** Normalize any thrown value into an OrbitError (cancellation wins over decoder noise). */
export function toToolError(error: unknown, signal?: AbortSignal): OrbitError {
  if (error instanceof OrbitError) return error;
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new OrbitError('CANCELLED', 'Cancelled', { cause: error });
  }
  return mapSharpError(error);
}

/** Validate tool options with the shared schemas; zod issues become INVALID_OPTIONS (paths only, no values). */
export function parseToolOptions<A extends ToolActionId>(actionId: A, raw: unknown): ActionOptions<A> {
  try {
    return parseActionOptions(actionId, raw);
  } catch (error) {
    const issues = (error as { issues?: readonly { path?: readonly PropertyKey[]; code?: string }[] }).issues;
    const detail = Array.isArray(issues)
      ? issues
          .slice(0, 5)
          .map((i) => `${(i.path ?? []).map(String).join('.') || '(root)'}: ${i.code ?? 'invalid'}`)
          .join('; ')
      : undefined;
    throw new OrbitError('INVALID_OPTIONS', `Invalid options for ${actionId}`, detail === undefined ? { cause: error } : { detail, cause: error });
  }
}

export function invalidOptions(message: string): OrbitError {
  return new OrbitError('INVALID_OPTIONS', message);
}

export function requireImageInput(input: ProcessorInput | undefined): ProcessorInput & { readonly format: ImageFormat } {
  if (!input) throw new OrbitError('INVALID_OPTIONS', 'No input file');
  if (!isImageFormat(input.format)) throw new OrbitError('UNSUPPORTED_FORMAT', 'This tool only accepts images');
  return input as ProcessorInput & { readonly format: ImageFormat };
}

export function singleInput(job: ProcessorJob): ProcessorInput & { readonly format: ImageFormat } {
  if (job.inputs.length !== 1) throw new OrbitError('INVALID_OPTIONS', 'Tools process exactly one input per job');
  return requireImageInput(job.inputs[0]);
}

export function stage(onProgress: ((p: JobProgress) => void) | undefined, s: 'reading' | 'decoding' | 'rendering' | 'encoding' | 'writing'): void {
  onProgress?.({ kind: 'indeterminate', stage: s });
}

/**
 * A decoded-on-demand, auto-oriented, 8-bit image. `open()` returns a fresh
 * pipeline each time, built from one shared buffer (never `Sharp.clone()`,
 * which deep-copies its input buffer on every call).
 */
export interface LoadedImage {
  readonly input: ProcessorInput & { readonly format: ImageFormat };
  /** The file's bytes (lossless metadata removal works on these). */
  readonly buffer: Buffer;
  /** Metadata of the original file (orientation, ICC bytes, depth as stored…). */
  readonly meta: Metadata;
  /** Oriented size (what the user sees). */
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  readonly grey: boolean;
  /** The file has an embedded ICC profile. */
  readonly hasProfile: boolean;
  /**
   * Embedded ICC profile kept by same-image tools: only for RGB images (P3, Adobe RGB…).
   * CMYK and greyscale profiles are converted to sRGB instead, because the tools
   * composite RGB(A) drawings/patches and PNG/WebP cannot store CMYK.
   */
  readonly keepIcc: boolean;
  /** Frames/pages of an animated or multi-page input the tool does not use (it works on the first). */
  readonly dropped: DroppedFrames | null;
  /** Pipelines from open() are 8-bit (16-bit/float inputs were normalized once at load). */
  open(): Sharp;
}

/** FIRST_FRAME_ONLY / FIRST_PAGE_ONLY for a tool's result when the input had several frames or pages. */
export function framesWarnings(image: Pick<LoadedImage, 'dropped'>): JobWarning[] {
  return image.dropped ? [framesWarning(image.dropped, 1)] : [];
}

function isGreySpace(meta: Metadata): boolean {
  return meta.space === 'b-w' || meta.space === 'grey16';
}

/**
 * Loading rules:
 *  - JPEG/PNG/WebP/GIF/TIFF/AVIF (8-bit): `open()` = `sharp(buffer).autoOrient()` with the same
 *    input options as common/io `openImage` (pixel limit, failOn 'error', first frame only).
 *  - BMP: decoded once by the builtin codec (through `openImage`); `open()` reuses the RGBA.
 *  - HEIC and every input that is not 8 bits per channel (16-bit PNG/TIFF, high-bit-depth AVIF,
 *    float TIFF): decoded once into an 8-bit lossless PNG intermediate — oriented, the RGB ICC
 *    profile kept as is (CMYK converted to sRGB, grey kept grey). Outputs are 8-bit anyway, and
 *    sharp mishandles 16-bit input in several paths: RGB16 with a profile is processed in Display P3
 *    and written back without conversion, recomb silently casts to 8-bit before linear, and some
 *    geometry ops drop the kept profile. Normalizing once keeps every tool on the 8-bit path.
 */
export async function loadImage(input: ProcessorInput, limits: ProcessingLimits, signal?: AbortSignal): Promise<LoadedImage> {
  const image = requireImageInput(input);
  const buffer = await readInputBuffer(image, limits, signal);
  throwIfCancelled(signal);
  try {
    const base = await openImage(buffer, image.format, limits);
    const meta = await base.metadata();
    const width = meta.autoOrient?.width ?? meta.width;
    const height = meta.autoOrient?.height ?? meta.height;
    if (!width || !height) throw new OrbitError('IMAGE_CORRUPT', 'Image has no size');
    if (width * height > limits.maxInputPixels) throw new OrbitError('IMAGE_TOO_LARGE', 'Image exceeds the pixel limit');
    const hasProfile = meta.hasProfile === true || meta.icc !== undefined;
    const keepIcc = hasProfile && (meta.space === 'srgb' || meta.space === 'rgb16');
    const grey = isGreySpace(meta);
    const eightBit = meta.depth === 'uchar' || meta.depth === 'char';
    const inputOptions = { limitInputPixels: limits.maxInputPixels, failOn: 'error', animated: false } as const;

    let open: () => Sharp;
    if (image.format === 'bmp') {
      const raw = await toRaw(base);
      open = () => sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels as 1 | 2 | 3 | 4 }, limitInputPixels: limits.maxInputPixels });
    } else if (image.format === 'heic' || !eightBit) {
      // Depth first, without geometry (common/io toEightBit): sharp drops a kept profile when it
      // rotates 16-bit data (EXIF auto-orientation included), so the intermediate stays unrotated
      // and keeps EXIF — its Orientation tag is applied by open() on 8-bit data. EXIF/XMP also let
      // Compress' keepMetadata copy them; the other tools never copy metadata. CMYK/grey profiles
      // are applied, not kept. (HEIC arrives already decoded and oriented through openImage.)
      const unrotated = image.format === 'heic' ? base : sharp(buffer, inputOptions);
      const intermediate = await toEightBit(unrotated, meta);
      open = () => sharp(intermediate, inputOptions).autoOrient();
    } else {
      open = () => sharp(buffer, inputOptions).autoOrient();
    }
    throwIfCancelled(signal);
    const dropped = droppedFrames(image.format, meta, buffer);
    return { input: image, buffer, meta, width, height, hasAlpha: meta.hasAlpha === true, grey, hasProfile, keepIcc, dropped, open };
  } catch (error) {
    throw toToolError(error, signal);
  }
}

/** Raw pixels with their layout. */
export interface RawImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly channels: number;
}

export async function toRaw(pipeline: Sharp): Promise<RawImage> {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

export function sharpFromRaw(raw: RawImage): Sharp {
  return sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels as 1 | 2 | 3 | 4 } });
}

/** True when an RGBA (or grey+alpha) buffer has at least one pixel that is not fully opaque. */
export function rawHasTransparency(raw: RawImage): boolean {
  if (raw.channels !== 4 && raw.channels !== 2) return false;
  const step = raw.channels;
  for (let i = step - 1; i < raw.data.length; i += step) if (raw.data[i]! < 255) return true;
  return false;
}

/** Whether the alpha channel of (a region of) the oriented image has transparent pixels. */
export async function regionHasTransparency(
  image: LoadedImage,
  region?: { left: number; top: number; width: number; height: number },
): Promise<boolean> {
  if (!image.hasAlpha) return false;
  let pipeline = image.open();
  if (region) pipeline = pipeline.extract(region);
  const alpha = await toRaw(pipeline.extractChannel('alpha'));
  for (let i = 0; i < alpha.data.length; i += 1) if (alpha.data[i]! < 255) return true;
  return false;
}

let avifEncodable: Promise<boolean> | null = null;
let tiffEncodable: Promise<boolean> | null = null;

async function probeEncode(fn: (s: Sharp) => Sharp): Promise<boolean> {
  try {
    await fn(sharp({ create: { width: 2, height: 2, channels: 3, background: '#808080' } })).toBuffer();
    return true;
  } catch {
    return false;
  }
}

/** Whether the bundled sharp can encode a format (measured once by encoding a tiny image). */
export async function canEncode(format: ImageFormat): Promise<boolean> {
  switch (format) {
    case 'jpeg':
    case 'png':
    case 'webp':
      return true;
    case 'avif':
      avifEncodable ??= probeEncode((s) => s.avif({ quality: 50, effort: 0 }));
      return avifEncodable;
    case 'tiff':
      tiffEncodable ??= probeEncode((s) => s.tiff({ compression: 'lzw' }));
      return tiffEncodable;
    default:
      // gif (first frame only → PNG), bmp/heic go through the codecs with a PNG fallback.
      return false;
  }
}

/**
 * Output format for tools with a ToolOutputFormat option. 'input' keeps
 * JPEG/PNG/WebP (and AVIF/TIFF when sharp can encode them, BMP/HEIC when their
 * codecs are available — see encodeToolImage's fallback); GIF becomes PNG
 * because tools work on the first frame only.
 */
export async function resolveToolFormat(option: ToolOutputFormat, inputFormat: ImageFormat): Promise<ImageFormat> {
  if (option !== 'input') return option;
  switch (inputFormat) {
    case 'jpeg':
    case 'png':
    case 'webp':
    case 'bmp':
    case 'heic':
      return inputFormat;
    case 'avif':
    case 'tiff':
      return (await canEncode(inputFormat)) ? inputFormat : 'png';
    case 'gif':
      return 'png';
  }
}

/** Formats encodeToolImage can produce (GIF is never written by tools). */
export type WritableFormat = Exclude<ImageFormat, 'gif'>;

/**
 * Whether HEIC can be written: the macOS ImageIO codec helper named by
 * ORBITDROP_IMAGEIO_HELPER exists and is executable — the same check
 * encodeWithImageIO makes before spawning it (a stat, no spawn).
 */
export async function canWriteHeic(): Promise<boolean> {
  const helper = imageIOHelperPath();
  return helper !== null && (await isExecutableFile(helper));
}

/**
 * The format encodeToolImage really writes when asked for `target`:
 * JPEG/PNG/WebP as asked; BMP through the builtin codec; AVIF/TIFF when sharp
 * can encode them; HEIC when the ImageIO codec helper is available; PNG
 * otherwise (and always for GIF: tools write the first frame). Jobs and
 * previews both go through this, so a preview's `outputFormat` names the
 * format the job writes.
 */
export async function writtenFormat(target: ImageFormat): Promise<WritableFormat> {
  switch (target) {
    case 'jpeg':
    case 'png':
    case 'webp':
    case 'bmp':
      return target;
    case 'avif':
    case 'tiff':
      return (await canEncode(target)) ? target : 'png';
    case 'heic':
      return (await canWriteHeic()) ? 'heic' : 'png';
    case 'gif':
      return 'png';
  }
}

/** Format crop/edit/annotate/redact write for their outputFormat option (jobs and previews alike). */
export async function toolOutputFormat(option: ToolOutputFormat, inputFormat: ImageFormat): Promise<WritableFormat> {
  return writtenFormat(await resolveToolFormat(option, inputFormat));
}

export interface EncodeToolRequest {
  readonly format: ImageFormat;
  readonly settings: ProcessorSettings;
  /** Lossy formats; defaults to the settings for the format. */
  readonly quality?: number | undefined;
  /** Whether the pipeline's output has an alpha channel. */
  readonly hasAlpha: boolean;
  /** Background for alpha when the target cannot store it. */
  readonly flattenBackground?: string;
  readonly keepIcc?: boolean;
  /** Keep EXIF/XMP/ICC (compress keepMetadata). Orientation was already applied, sharp writes Orientation = 1. */
  readonly keepMetadata?: boolean;
  readonly png?: { readonly palette?: boolean; readonly compressionLevel?: number };
  readonly webp?: { readonly lossless?: boolean; readonly effort?: number };
  readonly jpegChroma?: '4:2:0' | '4:4:4';
}

export interface EncodedImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly format: ImageFormat;
  /** Alpha was merged onto `flattenBackground`. */
  readonly flattened: boolean;
}

function applyEncoder(pipeline: Sharp, format: 'jpeg' | 'png' | 'webp' | 'avif' | 'tiff', quality: number, req: EncodeToolRequest): Sharp {
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg({ quality, mozjpeg: true, chromaSubsampling: req.jpegChroma ?? (quality >= 90 ? '4:4:4' : '4:2:0') });
    case 'png':
      return pipeline.png(
        req.png?.palette
          ? { palette: true, quality, effort: 8, compressionLevel: req.png.compressionLevel ?? 9 }
          : { compressionLevel: req.png?.compressionLevel ?? 6 },
      );
    case 'webp':
      return pipeline.webp(req.webp?.lossless ? { lossless: true, effort: req.webp.effort ?? 4 } : { quality, effort: req.webp?.effort ?? 4 });
    case 'avif':
      return pipeline.avif({ quality, effort: 4 });
    case 'tiff':
      return pipeline.tiff({ compression: 'lzw' });
  }
}

/**
 * Encode a pipeline built by `make()` (called again for a fallback). The
 * target goes through `writtenFormat` first: formats the bundled engines
 * cannot write (HEIC without the ImageIO helper, AVIF/TIFF without a sharp
 * encoder, GIF) become PNG; the returned `format` is what was actually written.
 */
export async function encodeToolImage(make: () => Sharp, req: EncodeToolRequest): Promise<EncodedImage> {
  const target = await writtenFormat(req.format);
  const flatten = req.hasAlpha && !FORMAT_INFO[target].alpha;
  // keepMetadata on CMYK needs the explicit sRGB output profile (see keepMetadataFor).
  const space = req.keepMetadata ? (await make().metadata()).space : undefined;
  const prepare = (): Sharp => {
    let p = make();
    if (flatten) p = p.flatten({ background: req.flattenBackground ?? '#FFFFFF' });
    if (req.keepMetadata) p = keepMetadataFor(p, space);
    else if (req.keepIcc) p = p.keepIccProfile();
    return p;
  };
  if (target === 'bmp' || target === 'heic') {
    try {
      const out = await encodeImage(prepare(), target, req.settings, {
        ...(req.quality === undefined ? {} : { quality: req.quality }),
        flattenBackground: req.flattenBackground ?? '#FFFFFF',
      });
      return { data: out.data, width: out.width, height: out.height, format: target, flattened: flatten || out.flattened };
    } catch (error) {
      // The codec helper could not be started after all (e.g. removed since writtenFormat looked): PNG.
      if (!(error instanceof OrbitError) || error.code !== 'ENGINE_UNAVAILABLE') throw error;
      return encodeToolImage(make, { ...req, format: 'png' });
    }
  }
  const quality = req.quality ?? defaultQuality(target, req.settings);
  const { data, info } = await applyEncoder(prepare(), target, quality, req).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, format: target, flattened: flatten };
}

/**
 * Output file name: "<base><suffix><ext>". When the format is unchanged the
 * input's own extension spelling is kept (photo.JPEG → photo Cropped.JPEG),
 * otherwise the canonical extension is used.
 */
export function toolOutputName(input: ProcessorInput, actionId: ToolActionId, format: ImageFormat): string {
  const inputExt = extname(input.displayName);
  const ext = format === input.format && FORMAT_INFO[format].extensions.includes(inputExt.toLowerCase()) ? inputExt : FORMAT_INFO[format].extension;
  return toolResultName(input.displayName, ACTIONS[actionId].outputSuffix, ext);
}

/**
 * Commit a tool's output (never overwrites) and report it through
 * `onCommitted` (ProcessorRunContext): if the worker dies before the job ends,
 * main removes the file again, so the automatic retry does not leave
 * "name.ext" plus "name (2).ext" behind.
 */
export async function writeToolOutput(
  job: ProcessorJob,
  input: ProcessorInput,
  encoded: Pick<EncodedImage, 'data' | 'format' | 'width' | 'height'>,
  signal?: AbortSignal,
  onCommitted?: ProcessorRunContext['onCommitted'],
): Promise<ProcessorOutput> {
  throwIfCancelled(signal);
  const name = toolOutputName(input, job.actionId as ToolActionId, encoded.format);
  const path = await writeBytes(outputDirFor(job, input), name, job.jobId, encoded.data, signal);
  if (onCommitted) {
    try {
      const info = await lstat(path);
      onCommitted({ path, dev: info.dev, ino: info.ino, size: info.size });
    } catch {
      // cannot identify the file: main will not remove it
    }
  }
  return { path, format: encoded.format, bytes: encoded.data.length, width: encoded.width, height: encoded.height };
}

/** "#RRGGBB" → {r,g,b}. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw invalidOptions('Expected a #RRGGBB colour');
  const n = Number.parseInt(m[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export interface PreviewImage {
  readonly data: Uint8Array;
  readonly mime: 'image/png' | 'image/jpeg';
  readonly width: number;
  readonly height: number;
}

/**
 * Encode a preview: JPEG (quality 90) for opaque images, PNG (fast zlib level)
 * when the image has transparent pixels or `lossless` is requested.
 */
export async function encodePreview(raw: RawImage, options: { lossless?: boolean } = {}): Promise<PreviewImage> {
  const transparent = rawHasTransparency(raw);
  const pipeline = sharpFromRaw(raw);
  if (transparent || options.lossless) {
    const data = await pipeline.png({ compressionLevel: 2, adaptiveFiltering: false }).toBuffer();
    return { data, mime: 'image/png', width: raw.width, height: raw.height };
  }
  const data = await (raw.channels === 4 ? pipeline.removeAlpha() : pipeline).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
  return { data, mime: 'image/jpeg', width: raw.width, height: raw.height };
}
