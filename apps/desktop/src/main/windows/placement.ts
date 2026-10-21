import type { Point, Rect, Size } from '@orbitdrop/contracts';

/** Pure window geometry in global DIP (top-left origin), shared by the window manager and tests. */

export const WINDOW_MARGIN = 8;

/** Shrink a size so it fits inside the work area with a margin on every side. */
export function fitSize(size: Size, workArea: Rect, margin = WINDOW_MARGIN): Size {
  return {
    width: Math.max(1, Math.min(Math.round(size.width), Math.floor(workArea.width - 2 * margin))),
    height: Math.max(1, Math.min(Math.round(size.height), Math.floor(workArea.height - 2 * margin))),
  };
}

function clampAxis(start: number, length: number, areaStart: number, areaLength: number, margin: number): number {
  const lo = areaStart + margin;
  const hi = areaStart + areaLength - margin - length;
  if (hi < lo) return Math.round(areaStart + (areaLength - length) / 2);
  return Math.round(Math.min(hi, Math.max(lo, start)));
}

/** Move a rect (size unchanged unless it does not fit) fully inside the work area. */
export function clampRect(rect: Rect, workArea: Rect, margin = WINDOW_MARGIN): Rect {
  const size = fitSize(rect, workArea, margin);
  return {
    x: clampAxis(rect.x, size.width, workArea.x, workArea.width, margin),
    y: clampAxis(rect.y, size.height, workArea.y, workArea.height, margin),
    width: size.width,
    height: size.height,
  };
}

/** Center a window of `size` on `anchor` (pointer / drop point), then keep it inside the work area. */
export function placeCentered(anchor: Point, size: Size, workArea: Rect, margin = WINDOW_MARGIN): Rect {
  const fitted = fitSize(size, workArea, margin);
  return clampRect({ x: anchor.x - fitted.width / 2, y: anchor.y - fitted.height / 2, ...fitted }, workArea, margin);
}

/**
 * New bounds for a renderer resize request: the horizontal center and the top
 * edge stay put, the size is clamped to [min, work area], and the result is
 * kept inside the work area.
 */
export function resizeWithin(current: Rect, requested: Size, workArea: Rect, min: Size, margin = WINDOW_MARGIN): Rect {
  const wanted = { width: Math.max(min.width, requested.width), height: Math.max(min.height, requested.height) };
  const size = fitSize(wanted, workArea, margin);
  const centerX = current.x + current.width / 2;
  return clampRect({ x: centerX - size.width / 2, y: current.y, ...size }, workArea, margin);
}

export function rectCenter(rect: Rect): Point {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}
