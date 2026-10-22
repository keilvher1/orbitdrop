import {
  FORMAT_INFO,
  OrbitError,
  isImageFormat,
  type ConvertOptions,
  type ImageFormat,
  type JobWarning,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorRunContext,
} from '@orbitdrop/contracts';
import { convertedName } from '@orbitdrop/core';
import { droppedFrames, encodeImage, framesWarning, mapSharpError, openImageSource, readInputBuffer } from '../common/io';
import { OutputLedger, extensionMismatchWarning, reporter, throwIfCancelled, writableOutputDir } from './common';

/**
 * Image → image (JPEG/PNG/WebP/AVIF/TIFF/BMP/HEIC).
 * Policy (documented in docs/conversion-policy.md):
 *  - EXIF orientation is applied to the pixels; the output is upright with no
 *    orientation tag to re-apply.
 *  - Metadata (EXIF incl. GPS, XMP, IPTC) is dropped unless keepMetadata;
 *    pixels are converted to sRGB. METADATA_REMOVED reports what was dropped.
 *    High-bit-depth input is reduced to 8 bits first (common/io toEightBit).
 *  - Targets without alpha (JPEG) are flattened onto flattenBackground
 *    (default white) → ALPHA_FLATTENED.
 *  - Animated inputs (GIF/WebP/APNG) convert their first frame, multi-page
 *    TIFFs their first page → FIRST_FRAME_ONLY / FIRST_PAGE_ONLY.
 *  - The target may equal the input's real format only when its name says
 *    otherwise: the file is re-encoded under the right extension
 *    (EXTENSION_MISMATCH tells the user what the file really was).
 */
export async function convertImageToImage(
  job: ProcessorJob,
  input: ProcessorInput,
  target: ImageFormat,
  options: ConvertOptions,
  ctx: ProcessorRunContext,
): Promise<ProcessorResult> {
  if (!isImageFormat(input.format)) throw new OrbitError('UNSUPPORTED_FORMAT', 'Input is not an image');
  if (input.format === target && extensionMismatchWarning(input) === null) {
    // Only an image whose name says another format ("photo.jpg" that is a PNG) is re-encoded
    // into its own format, to get a correctly named file (core canRewriteSameFormat).
    throw new OrbitError('INVALID_OPTIONS', 'The file is already in the target format', { detail: `${input.format} → ${target}` });
  }
  const progress = reporter(ctx);
  progress({ kind: 'indeterminate', stage: 'reading' });
  const dir = await writableOutputDir(job, input);
  const buffer = await readInputBuffer(input, job.limits, ctx.signal);
  throwIfCancelled(ctx.signal);

  progress({ kind: 'indeterminate', stage: 'decoding' });
  let encoded: Awaited<ReturnType<typeof encodeImage>>;
  let hadMetadata: string[] = [];
  let hasTransparency = false;
  let dropped: ReturnType<typeof droppedFrames> = null;
  try {
    const source = await openImageSource(buffer, input.format, job.limits);
    const { meta } = source;
    hadMetadata = [meta.exif ? 'exif' : '', meta.xmp ? 'xmp' : '', meta.iptc ? 'iptc' : ''].filter(Boolean);
    dropped = droppedFrames(input.format, meta, buffer);
    if (meta.hasAlpha && !FORMAT_INFO[target].alpha) {
      // An alpha channel that is fully opaque loses nothing when flattened.
      hasTransparency = !(await source.open().stats()).isOpaque;
    }
    throwIfCancelled(ctx.signal);
    progress({ kind: 'indeterminate', stage: 'encoding' });
    encoded = await encodeImage(source.open(), target, job.settings, {
      ...(options.quality === undefined ? {} : { quality: options.quality }),
      flattenBackground: options.flattenBackground,
      keepMetadata: options.keepMetadata,
    });
  } catch (error) {
    throw mapSharpError(error);
  }
  throwIfCancelled(ctx.signal);

  progress({ kind: 'indeterminate', stage: 'writing' });
  const ledger = new OutputLedger(ctx.onCommitted);
  const output = await ledger.commit(
    dir,
    convertedName(input.displayName, FORMAT_INFO[target].extension),
    job.jobId,
    encoded.data,
    ctx.signal,
    { format: target, width: encoded.width, height: encoded.height },
  );

  const warnings: JobWarning[] = [];
  const mismatch = extensionMismatchWarning(input);
  if (mismatch) warnings.push(mismatch);
  if (dropped) warnings.push(framesWarning(dropped, 1));
  if (encoded.flattened && hasTransparency) warnings.push({ code: 'ALPHA_FLATTENED', params: { background: options.flattenBackground } });
  if (!options.keepMetadata && hadMetadata.length > 0) warnings.push({ code: 'METADATA_REMOVED', params: { kinds: hadMetadata.join(',') } });
  return { outputs: [output], warnings };
}
