import type { OverlayOptions } from 'sharp';
import type { PreviewRequest, PreviewResult, ProcessorJob, ProcessorResult, ProcessorRunContext, RedactRegion } from '@orbitdrop/contracts';
import {
  encodePreview,
  encodeToolImage,
  hexToRgb,
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
import { clusterBoxes } from './boxes';
import { needsProfileConversion, srgbColoursToProfile, withProfileFile } from './profile';
import { getScaledSource } from './source-cache';

/**
 * Redact (P1). Regions (oriented source pixels) are burned into the final pixels:
 *  - 'solid': an opaque box of `color`.
 *  - 'mosaic': the region is divided into blockSize × blockSize cells aligned to
 *    the region's top-left corner (partial cells at the right/bottom edges);
 *    every cell is replaced by the alpha-weighted mean colour of its pixels.
 *    Pixelation is NOT a guaranteed removal of information (large blocks on
 *    small text or known content can sometimes be reversed); use 'solid' for
 *    anything that must not be recoverable.
 * Regions partly outside the image are clipped; a region fully outside is an
 * INVALID_OPTIONS error (so a wrong coordinate never silently leaves data
 * visible). Regions are applied in order. On transparent images the region is
 * cleared first (dest-out) so the original never shows through a patch.
 * The result is re-encoded from pixels: EXIF (incl. GPS and the embedded
 * thumbnail), XMP, IPTC and any other metadata are never copied; only the ICC
 * colour profile is kept.
 */

export interface PixelBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function clipRegion(rect: PixelBox, width: number, height: number): PixelBox | null {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.width);
  const y1 = Math.min(height, rect.y + rect.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Mosaic of `box` from RGBA pixels `src` whose top-left is at (srcLeft, srcTop) in image coordinates. */
export function mosaicPixels(src: RawImage, srcLeft: number, srcTop: number, box: PixelBox, blockSize: number): Buffer {
  const out = Buffer.alloc(box.width * box.height * 4);
  const bs = Math.max(1, Math.round(blockSize));
  const data = src.data;
  for (let by = 0; by < box.height; by += bs) {
    const bh = Math.min(bs, box.height - by);
    for (let bx = 0; bx < box.width; bx += bs) {
      const bw = Math.min(bs, box.width - bx);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let yy = 0; yy < bh; yy += 1) {
        let i = ((box.y - srcTop + by + yy) * src.width + (box.x - srcLeft + bx)) * 4;
        for (let xx = 0; xx < bw; xx += 1, i += 4) {
          const a = data[i + 3]!;
          sr += data[i]! * a;
          sg += data[i + 1]! * a;
          sb += data[i + 2]! * a;
          sa += a;
        }
      }
      const n = bw * bh;
      const r = sa > 0 ? Math.round(sr / sa) : 0;
      const g = sa > 0 ? Math.round(sg / sa) : 0;
      const b = sa > 0 ? Math.round(sb / sa) : 0;
      const a = Math.round(sa / n);
      for (let yy = 0; yy < bh; yy += 1) {
        let o = ((by + yy) * box.width + bx) * 4;
        for (let xx = 0; xx < bw; xx += 1, o += 4) {
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = a;
        }
      }
    }
  }
  return out;
}

export interface ScaledRegion {
  readonly box: PixelBox;
  readonly style: RedactRegion['style'];
  readonly color: string;
  readonly blockSize: number;
}

/** Clip the regions to the image; throws INVALID_OPTIONS for a region entirely outside it. */
export function prepareRegions(regions: readonly RedactRegion[], width: number, height: number): ScaledRegion[] {
  return regions.map((region) => {
    const box = clipRegion(region.rect, width, height);
    if (!box) throw invalidOptions('A redaction region lies outside the image');
    return { box, style: region.style, color: region.color, blockSize: region.blockSize };
  });
}

/** Regions for a preview drawn at `scale` (edges rounded, block size scaled, at least 1 px). */
export function scaleRegions(regions: readonly ScaledRegion[], scale: number, width: number, height: number): ScaledRegion[] {
  if (scale === 1) return [...regions];
  return regions.map((region) => {
    const b = region.box;
    const x0 = Math.min(width - 1, Math.round(b.x * scale));
    const y0 = Math.min(height - 1, Math.round(b.y * scale));
    const x1 = Math.min(width, Math.max(x0 + 1, Math.round((b.x + b.width) * scale)));
    const y1 = Math.min(height, Math.max(y0 + 1, Math.round((b.y + b.height) * scale)));
    return { ...region, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, blockSize: Math.max(1, region.blockSize * scale) };
  });
}

/** RGBA pixels of `box`, decoded for the mosaic regions inside it. */
export interface MosaicSource {
  readonly raw: RawImage;
  readonly box: PixelBox;
}

function contains(outer: PixelBox, inner: PixelBox): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

/**
 * Composite operations for the regions. Each mosaic region must lie inside one
 * of `mosaicSources` (pixels in the same colour space as the pipeline they are
 * composited onto). Solid boxes are sharp `create` inputs (no pixel buffer) in
 * `solidColour(region.color)` — the requested sRGB colour, or its equivalent in
 * the image's kept profile.
 */
export function redactOverlays(
  regions: readonly ScaledRegion[],
  mosaicSources: readonly MosaicSource[],
  clearFirst: boolean,
  solidColour: (hex: string) => { r: number; g: number; b: number } = hexToRgb,
): OverlayOptions[] {
  const overlays: OverlayOptions[] = [];
  for (const region of regions) {
    const { box } = region;
    if (clearFirst) {
      overlays.push({
        input: { create: { width: box.width, height: box.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } },
        left: box.x,
        top: box.y,
        blend: 'dest-out',
      });
    }
    if (region.style === 'mosaic') {
      const source = mosaicSources.find((s) => contains(s.box, box));
      if (!source) throw new Error('mosaic source missing');
      const pixels = mosaicPixels(source.raw, source.box.x, source.box.y, box, region.blockSize);
      overlays.push({ input: pixels, raw: { width: box.width, height: box.height, channels: 4 }, left: box.x, top: box.y });
    } else {
      const { r, g, b } = solidColour(region.color);
      overlays.push({ input: { create: { width: box.width, height: box.height, channels: 4, background: { r, g, b, alpha: 1 } } }, left: box.x, top: box.y });
    }
  }
  return overlays;
}

export async function runRedact(job: ProcessorJob, ctx: ProcessorRunContext): Promise<ProcessorResult> {
  const { signal } = ctx;
  const input = singleInput(job);
  const options = parseToolOptions('tool.redact', job.options);
  try {
    stage(ctx.onProgress, 'reading');
    const image = await loadImage(input, job.limits, signal);
    const regions = prepareRegions(options.regions, image.width, image.height);
    const format = await toolOutputFormat(options.outputFormat, input.format);
    throwIfCancelled(signal);

    stage(ctx.onProgress, 'rendering');
    // Mosaic pixels are decoded per cluster of nearby regions (not the union of all of them),
    // with the same colour handling as the output pipeline (ICC kept → stored values; else sRGB).
    const mosaicRegions = regions.filter((r) => r.style === 'mosaic');
    const mosaicSources: MosaicSource[] = [];
    for (const cluster of clusterBoxes(mosaicRegions.map((r) => r.box))) {
      throwIfCancelled(signal);
      const { x, y, width, height } = cluster.box;
      let p = image.open().extract({ left: x, top: y, width, height });
      p = image.keepIcc ? p.keepIccProfile() : p.toColourspace('srgb');
      mosaicSources.push({ raw: await toRaw(p.ensureAlpha()), box: cluster.box });
    }
    // Solid colours are sRGB; on images keeping a wide-gamut profile they are converted into it.
    const colours = new Map<string, { r: number; g: number; b: number }>();
    const solids = [...new Set(regions.filter((r) => r.style === 'solid').map((r) => r.color.toUpperCase()))];
    if (solids.length > 0 && needsProfileConversion(image)) {
      const converted = await withProfileFile(image.meta.icc!, (path) =>
        srgbColoursToProfile(
          solids.map((hex) => {
            const { r, g, b } = hexToRgb(hex);
            return [r, g, b] as const;
          }),
          path,
        ),
      );
      solids.forEach((hex, i) => colours.set(hex, { r: converted[i]![0], g: converted[i]![1], b: converted[i]![2] }));
    }
    throwIfCancelled(signal);
    const overlays = redactOverlays(regions, mosaicSources, image.hasAlpha, (hex) => colours.get(hex.toUpperCase()) ?? hexToRgb(hex));

    stage(ctx.onProgress, 'encoding');
    const make = () => {
      const composed = image.open().composite(overlays);
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

export async function previewRedact(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult> {
  const options = parseToolOptions('tool.redact', request.options);
  try {
    const maxEdge = Math.max(16, Math.floor(request.maxEdge));
    const source = await getScaledSource(request.input, request.limits, () => maxEdge, signal);
    throwIfCancelled(signal);
    const scale = source.width / source.sourceWidth;
    // Clipped/validated against the full-size image (same errors as the final run), then scaled.
    const regions = scaleRegions(prepareRegions(options.regions, source.sourceWidth, source.sourceHeight), scale, source.width, source.height);
    const overlays = redactOverlays(regions, [{ raw: source, box: { x: 0, y: 0, width: source.width, height: source.height } }], source.sourceHasAlpha);
    const raw = await toRaw(sharpFromRaw(source).composite(overlays));
    const preview = await encodePreview(raw);
    return {
      ...preview,
      sourceWidth: source.sourceWidth,
      sourceHeight: source.sourceHeight,
      outputWidth: source.sourceWidth,
      outputHeight: source.sourceHeight,
      outputFormat: await toolOutputFormat(options.outputFormat, requireImageInput(request.input).format),
    };
  } catch (error) {
    throw toToolError(error, signal);
  }
}
