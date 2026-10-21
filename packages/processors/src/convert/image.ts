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
import { encodeImage, mapSharpError, openImage, readInputBuffer } from '../common/io';
import { OutputLedger, extensionMismatchWarning, reporter, throwIfCancelled, writableOutputDir } from './common';

/**
 * Image → image (JPEG/PNG/WebP/AVIF/TIFF/BMP/HEIC).
 * Policy (documented in docs/workstreams/processors-convert.md):
 *  - EXIF orientation is applied to the pixels; the output is upright with no
 *    orientation tag to re-apply.
 *  - Metadata (EXIF incl. GPS, XMP, IPTC) is dropped unless keepMetadata;
 *    pixels are converted to sRGB. METADATA_REMOVED reports what was dropped.
 *  - Targets without alpha (JPEG) are flattened onto flattenBackground
 *    (default white) → ALPHA_FLATTENED.
 *  - Animated inputs (GIF/WebP) convert their first frame.
 */
export async function convertImageToImage(
  job: ProcessorJob,
  input: ProcessorInput,
  target: ImageFormat,
  options: ConvertOptions,
  ctx: ProcessorRunContext,
): Promise<ProcessorResult> {
  if (!isImageFormat(input.format)) throw new OrbitError('UNSUPPORTED_FORMAT', 'Input is not an image');
  if (input.format === target) {
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
  try {
    const image = await openImage(buffer, input.format, job.limits);
    const meta = await image.metadata();
    hadMetadata = [meta.exif ? 'exif' : '', meta.xmp ? 'xmp' : '', meta.iptc ? 'iptc' : ''].filter(Boolean);
    if (meta.hasAlpha && !FORMAT_INFO[target].alpha) {
      // An alpha channel that is fully opaque loses nothing when flattened.
      hasTransparency = !(await image.clone().stats()).isOpaque;
    }
    throwIfCancelled(ctx.signal);
    progress({ kind: 'indeterminate', stage: 'encoding' });
    encoded = await encodeImage(image, target, job.settings, {
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
  if (encoded.flattened && hasTransparency) warnings.push({ code: 'ALPHA_FLATTENED', params: { background: options.flattenBackground } });
  if (!options.keepMetadata && hadMetadata.length > 0) warnings.push({ code: 'METADATA_REMOVED', params: { kinds: hadMetadata.join(',') } });
  return { outputs: [output], warnings };
}
