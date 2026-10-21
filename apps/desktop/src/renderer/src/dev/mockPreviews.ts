import {
  BACKGROUND_PRESETS,
  type ActionId,
  type AnnotationShape,
  type Background,
  type CompositionSpec,
  type FileFormat,
  type GradientLayer,
  type PreviewResponse,
  type RedactRegion,
  type Size,
} from '@orbitdrop/contracts';
import { annotationFontFamilyCss, computeCompositionLayout, drawAnnotations, previewScaleFor, scaleCompositionLayout } from '@orbitdrop/core';
import { BLANK_PNG, canvasUrl, ctx2d, makeCanvas } from './mockImages';

/**
 * DEV HARNESS ONLY: stand-ins for the processor previews so every editor can be
 * exercised in a browser. The app itself always gets previews from main /
 * @orbitdrop/processors. Layout and annotation drawing reuse the shared core
 * routines, so these previews follow the same rules as the real ones.
 */

export interface MockSource {
  readonly canvas: HTMLCanvasElement | null;
  readonly oriented: Size;
  readonly bytes: number;
  readonly format: FileFormat;
}

export type MockPreview = Omit<PreviewResponse, 'seq'>;

function fit(size: Size, maxEdge: number): Size {
  const k = Math.min(1, maxEdge / Math.max(size.width, size.height));
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) };
}

function blank(size: Size): MockPreview {
  return { url: BLANK_PNG, width: size.width, height: size.height };
}

function linearGradient(ctx: CanvasRenderingContext2D, layer: Extract<GradientLayer, { type: 'linear' }>, w: number, h: number) {
  // CSS angle convention: 0deg = towards the top, 90deg = towards the right.
  const a = (layer.angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const g = ctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
  for (const stop of layer.stops) g.addColorStop(stop.offset, stop.color);
  return g;
}

function paintBackground(ctx: CanvasRenderingContext2D, background: Background, w: number, h: number, image: HTMLCanvasElement | null) {
  if (background.kind === 'solid') {
    ctx.fillStyle = background.color;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  if (background.kind === 'image') {
    if (image) {
      const k = Math.max(w / image.width, h / image.height);
      const dw = image.width * k;
      const dh = image.height * k;
      ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = '#888888';
      ctx.fillRect(0, 0, w, h);
    }
    return;
  }
  const preset = BACKGROUND_PRESETS.find((p) => p.id === background.presetId) ?? BACKGROUND_PRESETS[0];
  if (!preset) return;
  ctx.fillStyle = preset.base;
  ctx.fillRect(0, 0, w, h);
  for (const layer of preset.layers) {
    if (layer.type === 'linear') {
      ctx.fillStyle = linearGradient(ctx, layer, w, h);
    } else {
      const r = layer.r * Math.max(w, h);
      const g = ctx.createRadialGradient(layer.cx * w, layer.cy * h, 0, layer.cx * w, layer.cy * h, r);
      for (const stop of layer.stops) g.addColorStop(stop.offset, stop.color);
      ctx.fillStyle = g;
    }
    ctx.fillRect(0, 0, w, h);
  }
}

async function addBackground(spec: CompositionSpec, source: MockSource, maxEdge: number, bgImage: HTMLCanvasElement | null): Promise<MockPreview> {
  const full = computeCompositionLayout(source.oriented.width, source.oriented.height, spec);
  const layout = scaleCompositionLayout(full, previewScaleFor(full, maxEdge));
  const canvas = makeCanvas(layout.canvas.width, layout.canvas.height);
  const base = { width: layout.canvas.width, height: layout.canvas.height, outputWidth: full.canvas.width, outputHeight: full.canvas.height, layout: full };
  if (!canvas || !source.canvas) return { ...blank(layout.canvas), ...base };
  const ctx = ctx2d(canvas);
  paintBackground(ctx, spec.background, layout.canvas.width, layout.canvas.height, bgImage);
  const c = layout.content;
  if (layout.shadow) {
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${layout.shadow.opacity})`;
    ctx.shadowBlur = layout.shadow.blurSigma * 2;
    ctx.shadowOffsetY = layout.shadow.offsetY;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.roundRect(c.x, c.y, c.width, c.height, layout.cornerRadius);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(c.x, c.y, c.width, c.height, layout.cornerRadius);
  ctx.clip();
  ctx.drawImage(source.canvas, c.x, c.y, c.width, c.height);
  ctx.restore();
  const { url } = await canvasUrl(canvas, spec.format === 'jpeg' ? 'image/jpeg' : 'image/png', spec.quality / 100);
  return { url, ...base };
}

interface EditOpts {
  readonly rotate?: number;
  readonly flipH?: boolean;
  readonly flipV?: boolean;
  readonly brightness?: number;
  readonly contrast?: number;
  readonly saturation?: number;
}

async function edit(opts: EditOpts, source: MockSource, maxEdge: number): Promise<MockPreview> {
  const rotate = ((opts.rotate ?? 0) % 360 + 360) % 360;
  const swap = rotate === 90 || rotate === 270;
  const out = swap ? { width: source.oriented.height, height: source.oriented.width } : source.oriented;
  const size = fit(out, maxEdge);
  const canvas = makeCanvas(size.width, size.height);
  if (!canvas || !source.canvas) return { ...blank(size), outputWidth: out.width, outputHeight: out.height };
  const ctx = ctx2d(canvas);
  ctx.filter = `brightness(${100 + (opts.brightness ?? 0)}%) contrast(${100 + (opts.contrast ?? 0)}%) saturate(${100 + (opts.saturation ?? 0)}%)`;
  ctx.translate(size.width / 2, size.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.scale(opts.flipH ? -1 : 1, opts.flipV ? -1 : 1);
  const dw = swap ? size.height : size.width;
  const dh = swap ? size.width : size.height;
  ctx.drawImage(source.canvas, -dw / 2, -dh / 2, dw, dh);
  const { url } = await canvasUrl(canvas, 'image/png');
  return { url, width: size.width, height: size.height, outputWidth: out.width, outputHeight: out.height };
}

interface CompressOpts {
  readonly format?: 'input' | 'jpeg' | 'webp' | 'png';
  readonly quality?: number;
  readonly maxEdge?: number | null;
  readonly pngMode?: 'palette' | 'lossless';
}

async function compress(opts: CompressOpts, source: MockSource, maxEdge: number): Promise<MockPreview> {
  const format = opts.format === undefined || opts.format === 'input' ? source.format : opts.format;
  const out = opts.maxEdge ? fit(source.oriented, opts.maxEdge) : source.oriented;
  const size = fit(out, maxEdge);
  const canvas = makeCanvas(size.width, size.height);
  if (!canvas || !source.canvas) return { ...blank(size), outputWidth: out.width, outputHeight: out.height, estimatedBytes: source.bytes };
  ctx2d(canvas).drawImage(source.canvas, 0, 0, size.width, size.height);
  const mime = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
  const encoded = await canvasUrl(canvas, mime, (opts.quality ?? 75) / 100);
  // Scale the preview encode to the full output size (rough, dev only).
  let estimate = Math.round((encoded.bytes * (out.width * out.height)) / (size.width * size.height));
  if (format === 'png') estimate = Math.round(opts.pngMode === 'lossless' ? source.bytes * 1.06 : estimate * 0.45);
  return { url: encoded.url, width: size.width, height: size.height, outputWidth: out.width, outputHeight: out.height, estimatedBytes: estimate };
}

async function redact(regions: readonly RedactRegion[], source: MockSource, maxEdge: number): Promise<MockPreview> {
  const size = fit(source.oriented, maxEdge);
  const canvas = makeCanvas(size.width, size.height);
  if (!canvas || !source.canvas) return blank(size);
  const ctx = ctx2d(canvas);
  ctx.drawImage(source.canvas, 0, 0, size.width, size.height);
  const k = size.width / source.oriented.width;
  for (const region of regions) {
    const x = region.rect.x * k;
    const y = region.rect.y * k;
    const w = Math.max(1, region.rect.width * k);
    const h = Math.max(1, region.rect.height * k);
    if (region.style === 'solid') {
      ctx.fillStyle = region.color;
      ctx.fillRect(x, y, w, h);
    } else {
      const block = Math.max(1, region.blockSize * k);
      const tiny = makeCanvas(Math.max(1, Math.ceil(w / block)), Math.max(1, Math.ceil(h / block)));
      if (!tiny) continue;
      ctx2d(tiny).drawImage(canvas, x, y, w, h, 0, 0, tiny.width, tiny.height);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, x, y, w, h);
      ctx.restore();
    }
  }
  const { url } = await canvasUrl(canvas, 'image/png');
  return { url, width: size.width, height: size.height, outputWidth: source.oriented.width, outputHeight: source.oriented.height };
}

async function annotate(shapes: readonly AnnotationShape[], source: MockSource, maxEdge: number): Promise<MockPreview> {
  const size = fit(source.oriented, maxEdge);
  const canvas = makeCanvas(size.width, size.height);
  if (!canvas || !source.canvas) return blank(size);
  const ctx = ctx2d(canvas);
  ctx.drawImage(source.canvas, 0, 0, size.width, size.height);
  drawAnnotations(ctx, shapes, { scale: size.width / source.oriented.width, fontFamily: annotationFontFamilyCss() });
  const { url } = await canvasUrl(canvas, 'image/png');
  return { url, width: size.width, height: size.height, outputWidth: source.oriented.width, outputHeight: source.oriented.height };
}

async function crop(rect: { x: number; y: number; width: number; height: number }, source: MockSource, maxEdge: number): Promise<MockPreview> {
  const size = fit(rect, maxEdge);
  const canvas = makeCanvas(size.width, size.height);
  if (!canvas || !source.canvas) return blank(size);
  const k = source.canvas.width / source.oriented.width;
  ctx2d(canvas).drawImage(source.canvas, rect.x * k, rect.y * k, rect.width * k, rect.height * k, 0, 0, size.width, size.height);
  const { url } = await canvasUrl(canvas, 'image/png');
  return { url, width: size.width, height: size.height, outputWidth: rect.width, outputHeight: rect.height };
}

export async function renderMockPreview(actionId: ActionId, options: unknown, source: MockSource, maxEdge: number, bgImage: HTMLCanvasElement | null): Promise<MockPreview> {
  const o = (options ?? {}) as Record<string, unknown>;
  switch (actionId) {
    case 'tool.addBackground':
      return addBackground(o as unknown as CompositionSpec, source, maxEdge, bgImage);
    case 'tool.edit':
      return edit(o as EditOpts, source, maxEdge);
    case 'tool.compress':
      return compress(o as CompressOpts, source, maxEdge);
    case 'tool.redact':
      return redact((o.regions as RedactRegion[] | undefined) ?? [], source, maxEdge);
    case 'tool.annotate':
      return annotate((o.shapes as AnnotationShape[] | undefined) ?? [], source, maxEdge);
    case 'tool.crop':
      return crop((o.rect as { x: number; y: number; width: number; height: number }) ?? { x: 0, y: 0, ...source.oriented }, source, maxEdge);
    default:
      return blank(fit(source.oriented, maxEdge));
  }
}
