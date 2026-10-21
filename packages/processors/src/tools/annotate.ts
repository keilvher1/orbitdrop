import type { OverlayOptions } from 'sharp';
import type { AnnotationShape, PreviewRequest, PreviewResult, ProcessorJob, ProcessorResult, ProcessorRunContext } from '@orbitdrop/contracts';
import { annotationBounds, drawAnnotations } from '@orbitdrop/core';
import {
  encodePreview,
  encodeToolImage,
  loadImage,
  parseToolOptions,
  regionHasTransparency,
  resolveToolFormat,
  sharpFromRaw,
  singleInput,
  stage,
  throwIfCancelled,
  toRaw,
  toToolError,
  writeToolOutput,
  type LoadedImage,
} from './common';
import { clipBox, clusterBoxes } from './boxes';
import { loadCanvas, resolveAnnotationFont } from './fonts';
import { needsProfileConversion, srgbToProfile, withProfileFile } from './profile';
import { getScaledSource } from './source-cache';

/**
 * Annotate (P1). Shapes are drawn with the shared `drawAnnotations` routine
 * (@orbitdrop/core, also used by the renderer's live canvas) onto transparent
 * @napi-rs/canvas tiles at full resolution of the oriented image, then
 * composited over the image with sharp. Tiles cover only clusters of nearby
 * shapes (boxes.ts), so scattered marks on a huge photo stay cheap. On images
 * that keep a wide-gamut profile the sRGB overlay colours are converted into
 * that profile (profile.ts), so the export shows the colour the editor showed.
 * The input format is kept by default (JPEG stays JPEG). Text uses a
 * Hangul-capable system font (see fonts.ts).
 */

/** Largest overlay tile, in pixels, so huge clusters never need one giant canvas. */
const MAX_TILE_PIXELS = 16 * 1024 * 1024;

export interface OverlayTile {
  readonly data: Buffer;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Render shapes (source px × scale) into RGBA tiles clipped to a width×height image. */
export async function renderAnnotationTiles(
  shapes: readonly AnnotationShape[],
  width: number,
  height: number,
  scale: number,
  fontFamily: string,
): Promise<OverlayTile[]> {
  const { createCanvas } = await loadCanvas();
  const measure = createCanvas(1, 1).getContext('2d');
  const boxes = shapes.map((shape) => {
    const b = annotationBounds([shape], { scale, fontFamily }, measure);
    return b ? clipBox(b, width, height) : null;
  });
  const tiles: OverlayTile[] = [];
  for (const cluster of clusterBoxes(boxes)) {
    const members = cluster.members.map((i) => shapes[i]!);
    const { x: left, y: top, width: w, height: h } = cluster.box;
    const tileRows = Math.max(1, Math.floor(MAX_TILE_PIXELS / w));
    for (let y = top; y < top + h; y += tileRows) {
      const th = Math.min(tileRows, top + h - y);
      const ctx = createCanvas(w, th).getContext('2d');
      ctx.translate(-left, -y);
      drawAnnotations(ctx, members, { scale, fontFamily });
      const pixels = ctx.getImageData(0, 0, w, th).data;
      tiles.push({ data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), left, top: y, width: w, height: th });
    }
  }
  return tiles;
}

/** Overlay tiles in the colour space of an image that keeps a wide-gamut profile. */
async function tilesForImage(tiles: OverlayTile[], image: LoadedImage): Promise<OverlayTile[]> {
  if (tiles.length === 0 || !needsProfileConversion(image)) return tiles;
  return withProfileFile(image.meta.icc!, (path) =>
    Promise.all(
      tiles.map(async (t) => {
        const raw = await srgbToProfile({ data: t.data, width: t.width, height: t.height, channels: 4 }, path);
        return { ...t, data: raw.data };
      }),
    ),
  );
}

function tileOverlays(tiles: readonly OverlayTile[]): OverlayOptions[] {
  return tiles.map((t) => ({ input: t.data, raw: { width: t.width, height: t.height, channels: 4 as const }, left: t.left, top: t.top }));
}

export async function runAnnotate(job: ProcessorJob, ctx: ProcessorRunContext): Promise<ProcessorResult> {
  const { signal } = ctx;
  const input = singleInput(job);
  const options = parseToolOptions('tool.annotate', job.options);
  try {
    stage(ctx.onProgress, 'reading');
    const image = await loadImage(input, job.limits, signal);
    const format = await resolveToolFormat(options.outputFormat, input.format);
    throwIfCancelled(signal);
    stage(ctx.onProgress, 'rendering');
    const tiles = await tilesForImage(await renderAnnotationTiles(options.shapes, image.width, image.height, 1, (await resolveAnnotationFont()).css), image);
    throwIfCancelled(signal);
    stage(ctx.onProgress, 'encoding');
    const overlays = tileOverlays(tiles);
    const make = () => {
      if (overlays.length === 0) return image.open();
      const composed = image.open().composite(overlays);
      // Compositing adds an alpha channel; an opaque source stays opaque (RGB output).
      return image.hasAlpha ? composed : composed.removeAlpha();
    };
    const encoded = await encodeToolImage(make, {
      format,
      settings: job.settings,
      quality: options.quality,
      hasAlpha: image.hasAlpha,
      flattenBackground: '#FFFFFF',
      keepIcc: image.keepIcc,
    });
    const warnings = encoded.flattened && (await regionHasTransparency(image)) ? [{ code: 'ALPHA_FLATTENED' as const, params: { background: '#FFFFFF' } }] : [];
    stage(ctx.onProgress, 'writing');
    const output = await writeToolOutput(job, input, encoded, signal);
    return { outputs: [output], warnings };
  } catch (error) {
    throw toToolError(error, signal);
  }
}

export async function previewAnnotate(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult> {
  const options = parseToolOptions('tool.annotate', request.options);
  try {
    const maxEdge = Math.max(16, Math.floor(request.maxEdge));
    const source = await getScaledSource(request.input, request.limits, () => maxEdge, signal);
    throwIfCancelled(signal);
    const scale = source.width / source.sourceWidth;
    const tiles = await renderAnnotationTiles(options.shapes, source.width, source.height, scale, (await resolveAnnotationFont()).css);
    const raw = tiles.length > 0 ? await toRaw(sharpFromRaw(source).composite(tileOverlays(tiles))) : source;
    const preview = await encodePreview(raw);
    return {
      ...preview,
      sourceWidth: source.sourceWidth,
      sourceHeight: source.sourceHeight,
      outputWidth: source.sourceWidth,
      outputHeight: source.sourceHeight,
    };
  } catch (error) {
    throw toToolError(error, signal);
  }
}
