import type { AspectRatioId } from '@orbitdrop/contracts';

/**
 * Crop geometry. Two spaces are involved:
 *  - source space: integer pixels of the *oriented* image (EXIF orientation
 *    applied — `ImageInfo.orientedWidth/Height`). CropOptions.rect is here.
 *  - view space: any space that shows the whole oriented image, e.g. the
 *    downscaled preview bitmap (`EditorContext.source.width/height`) or its
 *    displayed size in CSS pixels. Device pixel ratio does not matter because
 *    pointer coordinates are in CSS pixels too.
 * All rect operations below work in source space and return integer rects
 * that lie inside the image and are at least 1×1. Nothing is ever larger than
 * the source (no upscaling in P0).
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Width / height of each aspect preset; null = free. */
export const ASPECT_VALUES: Readonly<Record<AspectRatioId, number | null>> = {
  free: null,
  '1:1': 1,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
};

export function aspectValue(id: AspectRatioId): number | null {
  return ASPECT_VALUES[id];
}

// ------------------------------------------------------------------ mapping

export interface ViewMapping {
  /** Oriented source size in pixels. */
  readonly source: Size;
  /** Size of the view showing the whole image (preview bitmap px or displayed CSS px). */
  readonly view: Size;
}

/** Largest size with the aspect of `content` that fits in `box` (may upscale small images for display). */
export function fitSize(content: Size, box: Size): Size {
  if (content.width <= 0 || content.height <= 0) return { width: 0, height: 0 };
  const k = Math.min(box.width / content.width, box.height / content.height);
  return { width: Math.max(1, Math.round(content.width * k)), height: Math.max(1, Math.round(content.height * k)) };
}

/**
 * Mapping for an editor canvas: the image is displayed at `fitSize(oriented, box)`.
 * The preview bitmap (EditorContext.source) has the oriented aspect up to rounding,
 * so the displayed size is derived from the oriented size, not the bitmap.
 */
export function editorMapping(oriented: Size, box: Size): ViewMapping {
  return { source: oriented, view: fitSize(oriented, box) };
}

export function viewToSource(p: Point, m: ViewMapping): Point {
  return { x: (p.x * m.source.width) / m.view.width, y: (p.y * m.source.height) / m.view.height };
}

export function sourceToView(p: Point, m: ViewMapping): Point {
  return { x: (p.x * m.view.width) / m.source.width, y: (p.y * m.view.height) / m.source.height };
}

/** Source pixels per view unit along x (used for deltas). */
export function sourcePerView(m: ViewMapping): number {
  return m.source.width / m.view.width;
}

export function sourceRectToView(r: Rect, m: ViewMapping): Rect {
  const a = sourceToView({ x: r.x, y: r.y }, m);
  const b = sourceToView({ x: r.x + r.width, y: r.y + r.height }, m);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

/** View rect → integer source rect (edges rounded, then clamped into the image). */
export function viewRectToSource(r: Rect, m: ViewMapping): Rect {
  const a = viewToSource({ x: r.x, y: r.y }, m);
  const b = viewToSource({ x: r.x + r.width, y: r.y + r.height }, m);
  const x0 = Math.round(Math.min(a.x, b.x));
  const y0 = Math.round(Math.min(a.y, b.y));
  const x1 = Math.round(Math.max(a.x, b.x));
  const y1 = Math.round(Math.max(a.y, b.y));
  return clampRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, m.source);
}

// ------------------------------------------------------------- rect helpers

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Integer rect inside `bounds`, at least 1×1, never larger than the image. */
export function clampRect(r: Rect, bounds: Size): Rect {
  const W = Math.max(1, Math.floor(bounds.width));
  const H = Math.max(1, Math.floor(bounds.height));
  const width = clamp(Math.round(r.width), 1, W);
  const height = clamp(Math.round(r.height), 1, H);
  const x = clamp(Math.round(r.x), 0, W - width);
  const y = clamp(Math.round(r.y), 0, H - height);
  return { x, y, width, height };
}

export function fullRect(bounds: Size): Rect {
  return { x: 0, y: 0, width: Math.floor(bounds.width), height: Math.floor(bounds.height) };
}

export function rectEquals(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Integer width/height for a ratio, from a width (height follows by rounding). */
function dimsFromWidth(width: number, ratio: number): Size {
  const w = Math.max(1, Math.round(width));
  return { width: w, height: Math.max(1, Math.round(w / ratio)) };
}

/**
 * Largest integer size with `ratio` that fits in `limit` (both dimensions ≥ 1).
 * Rounding never pushes a dimension over the limit.
 */
export function maxSizeForRatio(ratio: number, limit: Size): Size {
  let width = Math.min(Math.floor(limit.width), Math.floor(limit.height * ratio));
  width = Math.max(1, width);
  let dims = dimsFromWidth(width, ratio);
  while ((dims.height > limit.height || dims.width > limit.width) && dims.width > 1) {
    width -= 1;
    dims = dimsFromWidth(width, ratio);
  }
  return { width: Math.min(dims.width, Math.floor(limit.width)), height: Math.min(dims.height, Math.floor(limit.height)) };
}

/** Largest rect with `ratio` inside `within`, centred on it. */
export function largestRectWithAspect(ratio: number, within: Rect): Rect {
  const size = maxSizeForRatio(ratio, within);
  return {
    x: Math.round(within.x + (within.width - size.width) / 2),
    y: Math.round(within.y + (within.height - size.height) / 2),
    width: size.width,
    height: size.height,
  };
}

/** Selection when the editor opens or the aspect is reset: the whole image, or the largest centred rect of the ratio. */
export function initialCropRect(aspect: AspectRatioId, bounds: Size): Rect {
  const ratio = aspectValue(aspect);
  const full = fullRect(bounds);
  return ratio === null ? full : clampRect(largestRectWithAspect(ratio, full), bounds);
}

/** Switching the aspect preset: fit the new ratio inside the current selection, keeping its centre. */
export function applyAspect(r: Rect, aspect: AspectRatioId, bounds: Size): Rect {
  const ratio = aspectValue(aspect);
  if (ratio === null) return clampRect(r, bounds);
  return clampRect(largestRectWithAspect(ratio, r), bounds);
}

export function moveRect(start: Rect, dx: number, dy: number, bounds: Size): Rect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, bounds);
}

/**
 * Resize from a handle by a pointer delta (source px). Free: the dragged edges
 * follow the pointer and stop at the image edge and at 1 px from the opposite
 * edge. Fixed ratio: the opposite corner (or edge) is the anchor; the size
 * follows whichever axis the pointer moved further along, then shrinks to fit
 * the image.
 */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, aspect: AspectRatioId, bounds: Size): Rect {
  const W = Math.floor(bounds.width);
  const H = Math.floor(bounds.height);
  const ratio = aspectValue(aspect);
  const left = start.x;
  const top = start.y;
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');

  if (ratio === null) {
    const x0 = west ? clamp(left + dx, 0, right - 1) : left;
    const x1 = east ? clamp(right + dx, left + 1, W) : right;
    const y0 = north ? clamp(top + dy, 0, bottom - 1) : top;
    const y1 = south ? clamp(bottom + dy, top + 1, H) : bottom;
    return clampRect({ x: Math.round(x0), y: Math.round(y0), width: Math.round(x1) - Math.round(x0), height: Math.round(y1) - Math.round(y0) }, bounds);
  }

  const corner = (west || east) && (north || south);
  if (corner) {
    // Follow the axis the pointer moved further along (in width units), so the
    // corner can grow and shrink in any direction.
    const dw = east ? dx : -dx;
    const dh = (south ? dy : -dy) * ratio;
    const maxW = east ? W - left : right;
    const maxH = south ? H - top : bottom;
    const wanted = Math.max(1, start.width + (Math.abs(dw) >= Math.abs(dh) ? dw : dh));
    const size = maxSizeForRatio(ratio, { width: Math.min(maxW, wanted), height: maxH });
    const x = east ? left : right - size.width;
    const y = south ? top : bottom - size.height;
    return clampRect({ x, y, ...size }, bounds);
  }

  if (east || west) {
    const w0 = Math.max(1, start.width + (east ? dx : -dx));
    const maxW = east ? W - left : right;
    const size = maxSizeForRatio(ratio, { width: Math.min(maxW, w0), height: H });
    const cy = top + start.height / 2;
    const x = east ? left : right - size.width;
    return clampRect({ x, y: clamp(Math.round(cy - size.height / 2), 0, H - size.height), ...size }, bounds);
  }

  const h0 = Math.max(1, start.height + (south ? dy : -dy));
  const maxH = south ? H - top : bottom;
  const size = maxSizeForRatio(ratio, { width: W, height: Math.min(maxH, h0) });
  const cx = left + start.width / 2;
  const y = south ? top : bottom - size.height;
  return clampRect({ x: clamp(Math.round(cx - size.width / 2), 0, W - size.width), y, ...size }, bounds);
}

/** New selection dragged from `anchor` to `pointer` (source px). */
export function rectFromPoints(anchor: Point, pointer: Point, aspect: AspectRatioId, bounds: Size): Rect {
  const W = Math.floor(bounds.width);
  const H = Math.floor(bounds.height);
  const ax = clamp(anchor.x, 0, W);
  const ay = clamp(anchor.y, 0, H);
  const px = clamp(pointer.x, 0, W);
  const py = clamp(pointer.y, 0, H);
  const ratio = aspectValue(aspect);
  if (ratio === null) {
    return clampRect({ x: Math.min(ax, px), y: Math.min(ay, py), width: Math.abs(px - ax), height: Math.abs(py - ay) }, bounds);
  }
  const east = px >= ax;
  const south = py >= ay;
  const maxW = east ? W - ax : ax;
  const maxH = south ? H - ay : ay;
  const wanted = Math.max(Math.abs(px - ax), Math.abs(py - ay) * ratio, 1);
  const size = maxSizeForRatio(ratio, { width: Math.max(1, Math.min(maxW, wanted)), height: Math.max(1, maxH) });
  return clampRect({ x: east ? ax : ax - size.width, y: south ? ay : ay - size.height, ...size }, bounds);
}

// ------------------------------------------------------- numeric W/H fields

export type DimensionError = { readonly kind: 'notInteger' } | { readonly kind: 'range'; readonly max: number } | { readonly kind: 'ratio'; readonly max: number };

export type DimensionResult = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: DimensionError };

/** Largest width and height a selection can have for this aspect (never above the source). */
export function sizeLimits(aspect: AspectRatioId, bounds: Size): Size {
  const ratio = aspectValue(aspect);
  if (ratio === null) return { width: Math.floor(bounds.width), height: Math.floor(bounds.height) };
  return maxSizeForRatio(ratio, bounds);
}

/**
 * Validate a W or H field: a whole number from 1 to the source size; with a
 * fixed ratio also small enough that the other side still fits.
 */
export function parseDimension(text: string, axis: 'width' | 'height', aspect: AspectRatioId, bounds: Size): DimensionResult {
  // NFKC: full-width digits typed through an IME ("１２０") are the same number.
  const trimmed = text.normalize('NFKC').trim().replace(/[,\s]/g, '');
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: { kind: 'notInteger' } };
  const value = Number.parseInt(trimmed, 10);
  const sourceMax = Math.floor(axis === 'width' ? bounds.width : bounds.height);
  if (value < 1 || value > sourceMax) return { ok: false, error: { kind: 'range', max: sourceMax } };
  const ratioMax = sizeLimits(aspect, bounds)[axis];
  if (value > ratioMax) return { ok: false, error: { kind: 'ratio', max: ratioMax } };
  return { ok: true, value };
}

/** Apply a typed width (or height), keeping the selection centre; the other side follows a fixed ratio. */
export function setRectDimension(r: Rect, axis: 'width' | 'height', value: number, aspect: AspectRatioId, bounds: Size): Rect {
  const W = Math.floor(bounds.width);
  const H = Math.floor(bounds.height);
  const ratio = aspectValue(aspect);
  let width = r.width;
  let height = r.height;
  if (axis === 'width') {
    width = clamp(Math.round(value), 1, W);
    if (ratio !== null) height = clamp(Math.round(width / ratio), 1, H);
  } else {
    height = clamp(Math.round(value), 1, H);
    if (ratio !== null) width = clamp(Math.round(height * ratio), 1, W);
  }
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return clampRect({ x: cx - width / 2, y: cy - height / 2, width, height }, bounds);
}

/**
 * Keyboard nudging. Arrow keys move by `step` source px; with `resize` they
 * grow/shrink the right/bottom edge instead (ratio kept when fixed).
 */
export function nudgeRect(r: Rect, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown', step: number, resize: boolean, aspect: AspectRatioId, bounds: Size): Rect {
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
  if (!resize) return moveRect(r, dx, dy, bounds);
  const ratio = aspectValue(aspect);
  if (ratio === null) return resizeRect(r, dx !== 0 ? 'e' : 's', dx, dy, aspect, bounds);
  // Fixed ratio: top-left stays, the size changes along the pressed axis. For
  // up/down the width follows the target height, rounded away from the current
  // width so every press changes the size (otherwise a sub-pixel width step —
  // e.g. 0.5625 px at 9:16 — would be floored away and the key would do nothing).
  let wanted: number;
  if (dx !== 0) {
    wanted = r.width + dx;
  } else {
    const exact = (r.height + dy) * ratio;
    wanted = dy > 0 ? Math.max(r.width + 1, Math.ceil(exact)) : Math.min(r.width - 1, Math.floor(exact));
  }
  const size = maxSizeForRatio(ratio, {
    width: Math.min(Math.floor(bounds.width) - r.x, Math.max(1, wanted)),
    height: Math.floor(bounds.height) - r.y,
  });
  return clampRect({ x: r.x, y: r.y, ...size }, bounds);
}
