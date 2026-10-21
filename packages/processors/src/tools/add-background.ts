import sharp, { type OverlayOptions, type Sharp } from 'sharp';
import {
  OrbitError,
  type AddBackgroundOptions,
  type BackgroundPreset,
  type CompositionLayout,
  type JobWarning,
  type PreviewRequest,
  type PreviewResult,
  type ProcessingLimits,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorRunContext,
} from '@orbitdrop/contracts';
import { computeCompositionLayout, previewScaleFor, scaleCompositionLayout } from '@orbitdrop/core';
import { findPreset, presetSvg, roundedRectMaskSvg, shadowShapeSvg } from './backgrounds';
import {
  encodePreview,
  encodeToolImage,
  invalidOptions,
  loadImage,
  parseToolOptions,
  rawHasTransparency,
  requireImageInput,
  sharpFromRaw,
  singleInput,
  stage,
  throwIfCancelled,
  toRaw,
  toToolError,
  writeToolOutput,
  type RawImage,
} from './common';
import { getScaledSource } from './source-cache';

/**
 * Add Background (spec §7). One renderer, `renderComposition`, draws a
 * CompositionLayout at whatever scale it is given: the final export uses the
 * layout in final output pixels with the full-resolution source; the preview
 * uses `scaleCompositionLayout(finalLayout, k)` with a downscaled decode of the
 * same source. Drawing order: background → shadow → content, so the shadow is
 * under the image and (margins ≥ shadow extents) never clipped by the canvas.
 *
 *  - background: solid colour, a preset (SVG gradients, see backgrounds.ts) or a
 *    user image scaled with "cover" (centre crop of the background only).
 *  - content: oriented source, converted to sRGB, resized (Lanczos-3, only ever
 *    down: contentScale ≤ 1) to the content rect, corners cut with an
 *    antialiased rounded-rect mask (dest-in).
 *  - shadow: the same rounded rect, offset by offsetY, Gaussian-blurred with
 *    blurSigma, black at `opacity`; rendered as a single-channel mask only inside
 *    its bounding box (content rect ± 3σ).
 */

export type ResolvedBackground =
  | { readonly kind: 'solid'; readonly color: string }
  | { readonly kind: 'preset'; readonly preset: BackgroundPreset }
  | { readonly kind: 'image'; readonly open: () => Sharp };

export interface CompositionRenderInput {
  readonly layout: CompositionLayout;
  /** Oriented content image (any resolution at least the content rect); called once. */
  readonly content: () => Sharp;
  /** Size of `content()`'s output, to skip a no-op resize. */
  readonly contentSize: { readonly width: number; readonly height: number };
  readonly background: ResolvedBackground;
  readonly signal?: AbortSignal;
}

async function renderBackground(background: ResolvedBackground, width: number, height: number): Promise<RawImage> {
  switch (background.kind) {
    case 'solid':
      return toRaw(sharp({ create: { width, height, channels: 4, background: background.color } }));
    case 'preset': {
      const raw = await toRaw(sharp(Buffer.from(presetSvg(background.preset, width, height)), { limitInputPixels: false }).ensureAlpha());
      if (raw.width !== width || raw.height !== height) {
        return toRaw(sharpFromRaw(raw).resize(width, height, { fit: 'fill' }));
      }
      return raw;
    }
    case 'image':
      return toRaw(background.open().resize(width, height, { fit: 'cover', position: 'centre' }).toColourspace('srgb').ensureAlpha());
  }
}

async function renderShadowOverlay(layout: CompositionLayout): Promise<OverlayOptions | null> {
  const shadow = layout.shadow;
  if (!shadow || !(shadow.opacity > 0)) return null;
  const { width: canvasW, height: canvasH } = layout.canvas;
  const rect = layout.content;
  const reach = 3 * shadow.blurSigma;
  const x0 = Math.max(0, Math.floor(rect.x - reach));
  const y0 = Math.max(0, Math.floor(rect.y + shadow.offsetY - reach));
  const x1 = Math.min(canvasW, Math.ceil(rect.x + rect.width + reach));
  const y1 = Math.min(canvasH, Math.ceil(rect.y + shadow.offsetY + rect.height + reach));
  const boxW = x1 - x0;
  const boxH = y1 - y0;
  if (boxW <= 0 || boxH <= 0) return null;
  const svg = shadowShapeSvg(
    boxW,
    boxH,
    { x: rect.x - x0, y: rect.y + shadow.offsetY - y0, width: rect.width, height: rect.height },
    layout.cornerRadius,
  );
  // Materialize the 1-channel shape first: in sharp's fixed operation order extractChannel runs
  // after blur, so blurring the SVG pipeline directly would blur all four RGBA channels (~4× work).
  let m = await toRaw(sharp(Buffer.from(svg), { limitInputPixels: false }).extractChannel(0));
  // sharp's Gaussian needs sigma ≥ 0.3; below that the blur is invisible anyway. libvips truncates
  // the kernel where it falls below minAmplitude × peak: the default 0.2 cuts it at ~1.8σ (visibly
  // harder edges, ~10 levels off); 0.01 keeps it within ~1 level of a true Gaussian out to ~3σ.
  if (shadow.blurSigma >= 0.3) {
    m = await toRaw(sharpFromRaw(m).blur({ sigma: shadow.blurSigma, minAmplitude: 0.01 }).toColourspace('b-w'));
  }
  const rgba = Buffer.alloc(boxW * boxH * 4);
  for (let i = 0, j = 3; i < m.data.length; i += m.channels, j += 4) rgba[j] = Math.round(m.data[i]! * shadow.opacity);
  return { input: rgba, raw: { width: boxW, height: boxH, channels: 4 }, left: x0, top: y0 };
}

/** Render a composition to raw RGBA pixels of exactly layout.canvas size. */
export async function renderComposition(input: CompositionRenderInput): Promise<RawImage> {
  const { layout, signal } = input;
  const { width, height } = layout.canvas;
  const rect = layout.content;
  const background = await renderBackground(input.background, width, height);
  throwIfCancelled(signal);

  let content = input.content();
  if (input.contentSize.width !== rect.width || input.contentSize.height !== rect.height) {
    // Full-quality downscale: no JPEG/WebP shrink-on-load shortcut (it can add slight moiré).
    content = content.resize(rect.width, rect.height, { fit: 'fill', kernel: 'lanczos3', fastShrinkOnLoad: false });
  }
  content = content.toColourspace('srgb').ensureAlpha();
  if (layout.cornerRadius > 0) {
    content = content.composite([{ input: Buffer.from(roundedRectMaskSvg(rect.width, rect.height, layout.cornerRadius)), blend: 'dest-in' }]);
  }
  const contentRaw = await toRaw(content);
  throwIfCancelled(signal);

  const overlays: OverlayOptions[] = [];
  const shadow = await renderShadowOverlay(layout);
  if (shadow) overlays.push(shadow);
  overlays.push({
    input: contentRaw.data,
    raw: { width: contentRaw.width, height: contentRaw.height, channels: contentRaw.channels as 4 },
    left: rect.x,
    top: rect.y,
  });
  throwIfCancelled(signal);
  return toRaw(sharpFromRaw(background).composite(overlays));
}

function backgroundAsset(options: AddBackgroundOptions, assets: Readonly<Record<string, ProcessorInput>> | undefined): ProcessorInput | null {
  if (options.background.kind !== 'image') return null;
  const asset = assets?.[options.background.fileId];
  if (!asset) throw invalidOptions('Background image is not available');
  return requireImageInput(asset);
}

function staticBackground(options: AddBackgroundOptions): ResolvedBackground | null {
  const bg = options.background;
  if (bg.kind === 'solid') return { kind: 'solid', color: bg.color };
  if (bg.kind === 'preset') {
    const preset = findPreset(bg.presetId);
    if (!preset) throw invalidOptions('Unknown background preset');
    return { kind: 'preset', preset };
  }
  return null;
}

function assertCanvasWithinLimits(layout: CompositionLayout, limits: ProcessingLimits): void {
  if (layout.canvas.width * layout.canvas.height > limits.maxOutputPixels) {
    throw new OrbitError('IMAGE_TOO_LARGE', 'Output would exceed the pixel limit');
  }
}

export async function runAddBackground(job: ProcessorJob, ctx: ProcessorRunContext): Promise<ProcessorResult> {
  const { signal } = ctx;
  const input = singleInput(job);
  const options = parseToolOptions('tool.addBackground', job.options);
  try {
    stage(ctx.onProgress, 'reading');
    const image = await loadImage(input, job.limits, signal);
    const asset = backgroundAsset(options, job.assets);
    let background = staticBackground(options);
    if (asset) {
      const bgImage = await loadImage(asset, job.limits, signal);
      background = { kind: 'image', open: () => bgImage.open() };
    }
    const layout = computeCompositionLayout(image.width, image.height, options);
    assertCanvasWithinLimits(layout, job.limits);
    throwIfCancelled(signal);

    stage(ctx.onProgress, 'rendering');
    const canvas = await renderComposition({
      layout,
      content: () => image.open(),
      contentSize: { width: image.width, height: image.height },
      background: background!,
      signal,
    });
    throwIfCancelled(signal);

    stage(ctx.onProgress, 'encoding');
    const transparent = rawHasTransparency(canvas);
    // Opaque results are written without an alpha channel (smaller PNG, same pixels).
    const make = (): Sharp => (transparent ? sharpFromRaw(canvas) : sharpFromRaw(canvas).removeAlpha());
    const encoded = await encodeToolImage(make, {
      format: options.format,
      settings: job.settings,
      quality: options.quality,
      hasAlpha: transparent,
      flattenBackground: '#FFFFFF',
    });
    const warnings: JobWarning[] = encoded.flattened ? [{ code: 'ALPHA_FLATTENED', params: { background: '#FFFFFF' } }] : [];

    stage(ctx.onProgress, 'writing');
    const output = await writeToolOutput(job, input, encoded, signal, ctx.onCommitted);
    return { outputs: [output], warnings };
  } catch (error) {
    throw toToolError(error, signal);
  }
}

/** Round a preview decode size up so nearby requests share one cache entry. */
function bucket(edge: number): number {
  return Math.ceil(edge / 128) * 128;
}

export async function previewAddBackground(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult> {
  const options = parseToolOptions('tool.addBackground', request.options);
  try {
    const maxEdge = Math.max(16, Math.floor(request.maxEdge));
    // One decode per file and preview size; the content is resized from it for every slider change.
    const source = await getScaledSource(request.input, request.limits, () => maxEdge, signal);
    const layout = computeCompositionLayout(source.sourceWidth, source.sourceHeight, options);
    const scaled = scaleCompositionLayout(layout, previewScaleFor(layout, maxEdge));
    throwIfCancelled(signal);

    let background = staticBackground(options);
    const asset = backgroundAsset(options, request.assets);
    if (asset) {
      const { width: cw, height: ch } = scaled.canvas;
      const bg = await getScaledSource(
        asset,
        request.limits,
        (bw, bh) => bucket(Math.max(bw, bh) * Math.max(cw / bw, ch / bh)),
        signal,
      );
      background = { kind: 'image', open: () => sharpFromRaw(bg) };
    }

    const canvas = await renderComposition({
      layout: scaled,
      content: () => sharpFromRaw(source),
      contentSize: { width: source.width, height: source.height },
      background: background!,
      signal,
    });
    throwIfCancelled(signal);
    // JPEG output is flattened onto white; show the same in the preview.
    const shown = options.format === 'jpeg' && rawHasTransparency(canvas) ? await toRaw(sharpFromRaw(canvas).flatten({ background: '#FFFFFF' }).ensureAlpha()) : canvas;
    const preview = await encodePreview(shown);
    return {
      data: preview.data,
      mime: preview.mime,
      width: preview.width,
      height: preview.height,
      sourceWidth: source.sourceWidth,
      sourceHeight: source.sourceHeight,
      outputWidth: layout.canvas.width,
      outputHeight: layout.canvas.height,
      layout,
      // PNG and JPEG are always encodable: the job writes exactly this format.
      outputFormat: options.format,
    };
  } catch (error) {
    throw toToolError(error, signal);
  }
}
