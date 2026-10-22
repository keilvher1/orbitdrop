import { FORMAT_INFO, type CropOptions, type JobWarning, type PreviewRequest, type PreviewResult, type ProcessorJob, type ProcessorResult, type ProcessorRunContext } from '@orbitdrop/contracts';
import {
  encodePreview,
  encodeToolImage,
  framesWarnings,
  invalidOptions,
  loadImage,
  parseToolOptions,
  regionHasTransparency,
  requireImageInput,
  sharpFromRaw,
  singleInput,
  stage,
  throwIfCancelled,
  toRaw,
  toToolError,
  toolOutputFormat,
  writeToolOutput,
  type RawImage,
} from './common';
import { getScaledSource, getSourceSize } from './source-cache';

/**
 * Crop (spec §6). The rect is in oriented source pixels (after EXIF
 * orientation, exactly what the editor shows) and must lie inside the image;
 * the output is exactly rect.width × rect.height (never upscaled). The `aspect`
 * option only constrains the editor's handles and is not re-applied here.
 *
 * Format: 'input' keeps JPEG/PNG/WebP (AVIF/TIFF when encodable; BMP/HEIC when
 * their codecs exist), GIF and unencodable formats become PNG. PNG/WebP keep
 * alpha; JPEG flattens transparent pixels onto `flattenBackground` and reports
 * ALPHA_FLATTENED only when the cropped region really had transparency.
 * The ICC profile is kept; EXIF/XMP/IPTC are not copied.
 */

export function assertRectInside(rect: CropOptions['rect'], width: number, height: number): void {
  if (rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1 || rect.x + rect.width > width || rect.y + rect.height > height) {
    throw invalidOptions(`Crop rectangle is outside the ${width}×${height} image`);
  }
}

export async function runCrop(job: ProcessorJob, ctx: ProcessorRunContext): Promise<ProcessorResult> {
  const { signal } = ctx;
  const input = singleInput(job);
  const options = parseToolOptions('tool.crop', job.options);
  try {
    stage(ctx.onProgress, 'reading');
    const image = await loadImage(input, job.limits, signal);
    assertRectInside(options.rect, image.width, image.height);
    const region = { left: options.rect.x, top: options.rect.y, width: options.rect.width, height: options.rect.height };
    const format = await toolOutputFormat(options.outputFormat, input.format);
    throwIfCancelled(signal);

    stage(ctx.onProgress, 'encoding');
    const encoded = await encodeToolImage(() => image.open().extract(region), {
      format,
      settings: job.settings,
      quality: options.quality,
      hasAlpha: image.hasAlpha,
      flattenBackground: options.flattenBackground,
      keepIcc: image.keepIcc,
      outputPixels: region.width * region.height,
    });
    const warnings: JobWarning[] = framesWarnings(image);
    if (encoded.flattened && (await regionHasTransparency(image, region))) {
      warnings.push({ code: 'ALPHA_FLATTENED', params: { background: options.flattenBackground } });
    }

    stage(ctx.onProgress, 'writing');
    const output = await writeToolOutput(job, input, encoded, signal, ctx.onCommitted);
    return { outputs: [output], warnings };
  } catch (error) {
    throw toToolError(error, signal);
  }
}

/**
 * Preview of the cropped region at up to maxEdge. When the region needs at
 * most a 2×maxEdge decode of the whole image, that (cached) decode is reused;
 * otherwise — a small rect on a big photo — only the region is decoded from
 * the file, so no full-resolution copy ends up in the preview cache.
 */
export async function previewCrop(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult> {
  const options = parseToolOptions('tool.crop', request.options);
  try {
    const { rect } = options;
    const maxEdge = Math.max(16, Math.floor(request.maxEdge));
    const size = await getSourceSize(request.input, request.limits, signal);
    assertRectInside(rect, size.width, size.height);
    const k = Math.min(1, maxEdge / Math.max(rect.width, rect.height));
    const outW = Math.max(1, Math.round(rect.width * k));
    const outH = Math.max(1, Math.round(rect.height * k));
    const neededEdge = Math.max(size.width, size.height) * k;
    let raw: RawImage;
    if (neededEdge <= 2 * maxEdge) {
      const source = await getScaledSource(request.input, request.limits, () => neededEdge, signal);
      const s = source.width / source.sourceWidth;
      const x0 = Math.min(source.width - 1, Math.floor(rect.x * s));
      const y0 = Math.min(source.height - 1, Math.floor(rect.y * s));
      const x1 = Math.max(x0 + 1, Math.min(source.width, Math.ceil((rect.x + rect.width) * s)));
      const y1 = Math.max(y0 + 1, Math.min(source.height, Math.ceil((rect.y + rect.height) * s)));
      throwIfCancelled(signal);
      raw = await toRaw(
        sharpFromRaw(source)
          .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
          .resize(outW, outH, { fit: 'fill' }),
      );
    } else {
      const image = await loadImage(request.input, request.limits, signal);
      throwIfCancelled(signal);
      raw = await toRaw(
        image
          .open()
          .extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
          .resize(outW, outH, { fit: 'fill' })
          .toColourspace('srgb')
          .ensureAlpha(),
      );
    }
    const outputFormat = await toolOutputFormat(options.outputFormat, requireImageInput(request.input).format);
    // Formats without alpha (JPEG) get the same flattening as the job.
    const flatten = !FORMAT_INFO[outputFormat].alpha;
    const shown = flatten ? await toRaw(sharpFromRaw(raw).flatten({ background: options.flattenBackground }).ensureAlpha()) : raw;
    const preview = await encodePreview(shown);
    return {
      ...preview,
      sourceWidth: size.width,
      sourceHeight: size.height,
      outputWidth: rect.width,
      outputHeight: rect.height,
      outputFormat,
    };
  } catch (error) {
    throw toToolError(error, signal);
  }
}
