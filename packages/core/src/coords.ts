import type { Point, Rect, Size } from '@orbitdrop/contracts';

/**
 * Coordinate model shared by main, the renderer fallback wheel and — through the
 * golden vectors in tests/fixtures/wheel-golden.json — the native helpers.
 *
 * OrbitDrop global DIP space
 *   origin at the top-left corner of the primary display, x grows right, y grows
 *   down, unit = device-independent pixel (macOS point, Windows physical pixel ÷
 *   (dpi / 96)). Displays left of / above the primary have negative coordinates.
 *   DIP values may be fractional (e.g. 1366 px at 125 % = 1092.8 DIP).
 *
 * Rectangles are half-open: p is inside r when
 *   r.x <= p.x < r.x + r.width  and  r.y <= p.y < r.y + r.height,
 * so a point on an edge shared by two displays belongs to the right / lower one.
 * (In AppKit's y-up space this is exactly NSMouseInRect(p, frame, NO); on
 * Windows it is PtInRect.)
 *
 * macOS: AppKit global coordinates have their origin at the bottom-left of the
 *   primary screen (NSScreen.screens[0], the one with the menu bar) and y grows
 *   up. They are converted with the primary screen frame (`appKitPointToGlobal`).
 *
 * Windows (Per-Monitor DPI Aware v2): the helper sees physical pixels in
 *   virtual-screen coordinates (primary monitor top-left = (0, 0); others may be
 *   negative). Each monitor has its own DPI, so there is no single global scale.
 *   `displaysFromWin32Monitors` lays the monitors out in DIP so that monitors
 *   touching in physical space still touch in DIP space (see the algorithm
 *   there). Conversions are affine per monitor:
 *     dip = dipOrigin + (physical − physicalOrigin) / scale.
 *   Only use this layout inside one process (the helper); never exchange global
 *   coordinates with Electron, whose mixed-DPI layout may differ in corner cases.
 */

export interface Display {
  readonly id: string;
  /** Full display rectangle in global DIP. */
  readonly bounds: Rect;
  /** Usable area (no menu bar / Dock / taskbar) in global DIP. */
  readonly workArea: Rect;
  /** Physical pixels per DIP (macOS backingScaleFactor, Windows dpi / 96). */
  readonly scaleFactor: number;
  readonly primary: boolean;
}

/** Anything with display bounds (our Display, Electron's Display, a bare rect wrapper). */
export interface HasBounds {
  readonly bounds: Rect;
}

// ------------------------------------------------------------------ rect helpers

export function rectRight(r: Rect): number {
  return r.x + r.width;
}

export function rectBottom(r: Rect): number {
  return r.y + r.height;
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Half-open containment (see module doc). Empty rectangles contain nothing. */
export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/** Euclidean distance from p to the closed rectangle (0 inside or on an edge). */
export function distanceToRect(r: Rect, p: Point): number {
  const dx = p.x < r.x ? r.x - p.x : p.x > r.x + r.width ? p.x - (r.x + r.width) : 0;
  const dy = p.y < r.y ? r.y - p.y : p.y > r.y + r.height ? p.y - (r.y + r.height) : 0;
  return Math.hypot(dx, dy);
}

/** Distance between two closed rectangles (0 when they touch or overlap). */
export function distanceBetweenRects(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - rectRight(b), b.x - rectRight(a));
  const dy = Math.max(0, a.y - rectBottom(b), b.y - rectBottom(a));
  return Math.hypot(dx, dy);
}

/** Overlap of two rectangles, or null when they do not overlap with a positive area. */
export function intersectRects(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(rectRight(a), rectRight(b));
  const bottom = Math.min(rectBottom(a), rectBottom(b));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Smallest rectangle containing all rectangles, or null for an empty list. */
export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x = Number.POSITIVE_INFINITY;
  let y = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x = Math.min(x, r.x);
    y = Math.min(y, r.y);
    right = Math.max(right, rectRight(r));
    bottom = Math.max(bottom, rectBottom(r));
  }
  return { x, y, width: right - x, height: bottom - y };
}

/** Shrink a rectangle by `inset` on every side (negative grows it). Size never goes below 0. */
export function insetRect(r: Rect, inset: number): Rect {
  const width = Math.max(0, r.width - 2 * inset);
  const height = Math.max(0, r.height - 2 * inset);
  return { x: r.x + (r.width - width) / 2, y: r.y + (r.height - height) / 2, width, height };
}

export function rectCenteredAt(center: Point, size: Size): Rect {
  return { x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height };
}

/**
 * Move (never resize) `rect` so it lies inside `area`. On an axis where the
 * rectangle is larger than the area it is centered on the area instead (it then
 * overhangs both sides equally) — the same rule placeWheel uses.
 */
export function clampRectIntoArea(rect: Rect, area: Rect): Rect {
  const axis = (start: number, length: number, areaStart: number, areaLength: number): number => {
    if (length > areaLength) return areaStart + (areaLength - length) / 2;
    return Math.min(Math.max(start, areaStart), areaStart + areaLength - length);
  };
  return {
    x: axis(rect.x, rect.width, area.x, area.width),
    y: axis(rect.y, rect.height, area.y, area.height),
    width: rect.width,
    height: rect.height,
  };
}

/** Shrink `rect` to at most the area's size (keeping its center), then clamp it into the area. */
export function fitRectIntoArea(rect: Rect, area: Rect): Rect {
  const width = Math.max(0, Math.min(rect.width, area.width));
  const height = Math.max(0, Math.min(rect.height, area.height));
  const center = rectCenter(rect);
  return clampRectIntoArea(rectCenteredAt(center, { width, height }), area);
}

// ------------------------------------------------------------------ display lookup

/**
 * Index of the display whose bounds contain the point (half-open; first match
 * in list order). Otherwise the display nearest to the point (distance to the
 * closed rectangle; ties go to the lower index). -1 for an empty list.
 */
export function displayIndexAtPoint(point: Point, displays: readonly HasBounds[]): number {
  for (let i = 0; i < displays.length; i += 1) {
    if (rectContainsPoint(displays[i]!.bounds, point)) return i;
  }
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < displays.length; i += 1) {
    const distance = distanceToRect(displays[i]!.bounds, point);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** The display containing the point, else the nearest one; undefined only for an empty list. */
export function displayForPoint<D extends HasBounds>(point: Point, displays: readonly D[]): D | undefined {
  const index = displayIndexAtPoint(point, displays);
  return index < 0 ? undefined : displays[index];
}

/**
 * Display a rectangle mostly lies on (largest intersection area, like
 * MonitorFromRect); when it intersects none, the display nearest to its center.
 */
export function displayIndexForRect(rect: Rect, displays: readonly HasBounds[]): number {
  let best = -1;
  let bestArea = 0;
  for (let i = 0; i < displays.length; i += 1) {
    const overlap = intersectRects(rect, displays[i]!.bounds);
    const area = overlap === null ? 0 : overlap.width * overlap.height;
    if (area > bestArea) {
      bestArea = area;
      best = i;
    }
  }
  return best >= 0 ? best : displayIndexAtPoint(rectCenter(rect), displays);
}

// ------------------------------------------------------------------ rounding

/** floor(x + 0.5): rounds halves towards +∞. Natives must use this, not C++ std::round / Swift .rounded(). */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/** Values closer than this to an integer snap to it when computing enclosing pixel rectangles. */
export const PIXEL_SNAP_EPSILON = 1e-6;

/**
 * 'none'      keep fractional values
 * 'nearest'   round each edge (left, top, right, bottom) with roundHalfUp
 * 'enclosing' floor left/top and ceil right/bottom (after snapping values within
 *             PIXEL_SNAP_EPSILON of an integer), so the result covers the input
 */
export type PixelRounding = 'none' | 'nearest' | 'enclosing';

export function roundRect(r: Rect, mode: PixelRounding): Rect {
  if (mode === 'none') return r;
  const left = r.x;
  const top = r.y;
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  if (mode === 'nearest') {
    const x = roundHalfUp(left);
    const y = roundHalfUp(top);
    return { x, y, width: roundHalfUp(right) - x, height: roundHalfUp(bottom) - y };
  }
  const x = Math.floor(left + PIXEL_SNAP_EPSILON);
  const y = Math.floor(top + PIXEL_SNAP_EPSILON);
  return { x, y, width: Math.ceil(right - PIXEL_SNAP_EPSILON) - x, height: Math.ceil(bottom - PIXEL_SNAP_EPSILON) - y };
}

// ------------------------------------------------------------------ macOS (AppKit)

/** One NSScreen as the macOS helper reads it (AppKit global coordinates, points). */
export interface AppKitScreen {
  readonly id?: string;
  readonly frame: Rect;
  readonly visibleFrame: Rect;
  readonly backingScaleFactor: number;
}

/** AppKit global point (bottom-left origin, y up) → OrbitDrop global DIP (top-left origin, y down). */
export function appKitPointToGlobal(p: Point, primaryFrame: Rect): Point {
  return { x: p.x - primaryFrame.x, y: primaryFrame.y + primaryFrame.height - p.y };
}

export function globalPointToAppKit(p: Point, primaryFrame: Rect): Point {
  return { x: p.x + primaryFrame.x, y: primaryFrame.y + primaryFrame.height - p.y };
}

/** AppKit rect (origin = bottom-left corner) → global DIP rect (origin = top-left corner). */
export function appKitRectToGlobal(r: Rect, primaryFrame: Rect): Rect {
  return { x: r.x - primaryFrame.x, y: primaryFrame.y + primaryFrame.height - (r.y + r.height), width: r.width, height: r.height };
}

export function globalRectToAppKit(r: Rect, primaryFrame: Rect): Rect {
  return { x: r.x + primaryFrame.x, y: primaryFrame.y + primaryFrame.height - (r.y + r.height), width: r.width, height: r.height };
}

/**
 * Display model from NSScreen.screens. screens[0] must be the primary screen
 * (the one with the menu bar, whose frame origin is (0, 0)), as AppKit orders them.
 */
export function displaysFromAppKitScreens(screens: readonly AppKitScreen[]): Display[] {
  const primary = screens[0];
  if (primary === undefined) return [];
  return screens.map((screen, index) => ({
    id: screen.id ?? `screen-${index}`,
    bounds: appKitRectToGlobal(screen.frame, primary.frame),
    workArea: appKitRectToGlobal(screen.visibleFrame, primary.frame),
    scaleFactor: validScale(screen.backingScaleFactor),
    primary: index === 0,
  }));
}

// ------------------------------------------------------------------ Windows (physical pixels, per-monitor DPI)

/** One monitor as the Windows helper reads it (MONITORINFO + GetDpiForMonitor(MDT_EFFECTIVE_DPI)). */
export interface Win32Monitor {
  readonly id?: string;
  /** rcMonitor, physical pixels, virtual-screen coordinates. */
  readonly bounds: Rect;
  /** rcWork, physical pixels. */
  readonly workArea: Rect;
  /** Effective DPI; 96 = 100 %. */
  readonly dpi: number;
  /** MONITORINFOF_PRIMARY. When no monitor is flagged, the one containing (0, 0) is primary. */
  readonly primary?: boolean;
}

export interface Win32Display extends Display {
  readonly physicalBounds: Rect;
  readonly physicalWorkArea: Rect;
  readonly dpi: number;
}

function validScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** dpi / 96; invalid DPI values (≤ 0, NaN) count as 96. */
export function scaleFactorForDpi(dpi: number): number {
  return Number.isFinite(dpi) && dpi > 0 ? dpi / 96 : 1;
}

type Edge = 'right' | 'left' | 'bottom' | 'top';

/**
 * Which edge of `parent` the rectangle `child` touches (shares an edge segment
 * or only a corner). Checked in the order right, left, bottom, top.
 */
function touchingEdge(parent: Rect, child: Rect): Edge | null {
  const yOverlap = child.y <= rectBottom(parent) && rectBottom(child) >= parent.y;
  const xOverlap = child.x <= rectRight(parent) && rectRight(child) >= parent.x;
  if (child.x === rectRight(parent) && yOverlap) return 'right';
  if (rectRight(child) === parent.x && yOverlap) return 'left';
  if (child.y === rectBottom(parent) && xOverlap) return 'bottom';
  if (rectBottom(child) === parent.y && xOverlap) return 'top';
  return null;
}

/**
 * DIP start of the child along the shared edge:
 *  - starts aligned in physical space → starts aligned in DIP
 *  - else ends aligned → ends aligned in DIP
 *  - else the start of the overlapping segment maps to the same DIP coordinate
 *    in both monitors (so they keep touching).
 */
function attachAlongEdge(
  parentBegin: number,
  parentEnd: number,
  childBegin: number,
  childEnd: number,
  parentDipBegin: number,
  parentDipLength: number,
  parentScale: number,
  childScale: number,
): number {
  if (childBegin === parentBegin) return parentDipBegin;
  if (childEnd === parentEnd) return parentDipBegin + parentDipLength - (childEnd - childBegin) / childScale;
  const anchor = Math.max(childBegin, parentBegin);
  return parentDipBegin + (anchor - parentBegin) / parentScale - (anchor - childBegin) / childScale;
}

/**
 * Lay out Windows monitors in global DIP.
 *
 *  1. scale = dpi / 96. The primary monitor (flagged, else the one containing
 *     physical (0, 0), else the first) gets DIP origin = physical origin / scale,
 *     i.e. (0, 0).
 *  2. Monitors are ranked by (physical top, physical left, input index).
 *  3. Breadth-first from the primary: for each placed monitor P (queue order),
 *     every unplaced monitor C (rank order) touching P is attached to P's DIP
 *     edge (`touchingEdge`, `attachAlongEdge`) and queued.
 *  4. Monitors not connected to the primary (gaps between monitors) are placed
 *     one at a time — the unplaced monitor closest to any placed one first —
 *     keeping their physical offset from that nearest placed monitor scaled by
 *     its scale; then step 3 continues from it.
 *  5. Each work area keeps its physical offset inside its monitor, divided by the
 *     monitor's scale.
 *
 * With a single DPI this is exactly physical / scale for every monitor.
 */
export function displaysFromWin32Monitors(monitors: readonly Win32Monitor[]): Win32Display[] {
  const n = monitors.length;
  if (n === 0) return [];
  const scales = monitors.map((m) => scaleFactorForDpi(m.dpi));
  let primary = monitors.findIndex((m) => m.primary === true);
  if (primary < 0) primary = monitors.findIndex((m) => rectContainsPoint(m.bounds, { x: 0, y: 0 }));
  if (primary < 0) primary = 0;

  const ranked = monitors
    .map((m, index) => ({ index, top: m.bounds.y, left: m.bounds.x }))
    .sort((a, b) => a.top - b.top || a.left - b.left || a.index - b.index)
    .map((entry) => entry.index);

  const origins: (Point | null)[] = monitors.map(() => null);
  const dipSize = (i: number): Size => ({ width: monitors[i]!.bounds.width / scales[i]!, height: monitors[i]!.bounds.height / scales[i]! });
  const dipRect = (i: number): Rect => ({ ...origins[i]!, ...dipSize(i) });

  const pb = monitors[primary]!.bounds;
  origins[primary] = { x: pb.x / scales[primary]!, y: pb.y / scales[primary]! };
  const queue: number[] = [primary];
  let placedCount = 1;

  const attach = (p: number, c: number, edge: Edge): Point => {
    const P = monitors[p]!.bounds;
    const C = monitors[c]!.bounds;
    const D = dipRect(p);
    const sp = scales[p]!;
    const sc = scales[c]!;
    switch (edge) {
      case 'right':
        return { x: D.x + D.width, y: attachAlongEdge(P.y, rectBottom(P), C.y, rectBottom(C), D.y, D.height, sp, sc) };
      case 'left':
        return { x: D.x - C.width / sc, y: attachAlongEdge(P.y, rectBottom(P), C.y, rectBottom(C), D.y, D.height, sp, sc) };
      case 'bottom':
        return { x: attachAlongEdge(P.x, rectRight(P), C.x, rectRight(C), D.x, D.width, sp, sc), y: D.y + D.height };
      case 'top':
        return { x: attachAlongEdge(P.x, rectRight(P), C.x, rectRight(C), D.x, D.width, sp, sc), y: D.y - C.height / sc };
    }
  };

  while (placedCount < n || queue.length > 0) {
    while (queue.length > 0) {
      const p = queue.shift()!;
      for (const c of ranked) {
        if (origins[c] !== null) continue;
        const edge = touchingEdge(monitors[p]!.bounds, monitors[c]!.bounds);
        if (edge === null) continue;
        origins[c] = attach(p, c, edge);
        placedCount += 1;
        queue.push(c);
      }
    }
    if (placedCount >= n) break;
    // Disconnected monitor: closest unplaced one (rank order on ties), relative to its nearest placed monitor.
    let bestChild = -1;
    let bestParent = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const c of ranked) {
      if (origins[c] !== null) continue;
      for (const p of ranked) {
        if (origins[p] === null) continue;
        const distance = distanceBetweenRects(monitors[p]!.bounds, monitors[c]!.bounds);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestChild = c;
          bestParent = p;
        }
      }
    }
    const P = monitors[bestParent]!.bounds;
    const C = monitors[bestChild]!.bounds;
    const D = origins[bestParent]!;
    const sp = scales[bestParent]!;
    origins[bestChild] = { x: D.x + (C.x - P.x) / sp, y: D.y + (C.y - P.y) / sp };
    placedCount += 1;
    queue.push(bestChild);
  }

  return monitors.map((m, i) => {
    const s = scales[i]!;
    const origin = origins[i]!;
    return {
      id: m.id ?? `monitor-${i}`,
      bounds: dipRect(i),
      workArea: {
        x: origin.x + (m.workArea.x - m.bounds.x) / s,
        y: origin.y + (m.workArea.y - m.bounds.y) / s,
        width: m.workArea.width / s,
        height: m.workArea.height / s,
      },
      scaleFactor: s,
      primary: i === primary,
      physicalBounds: m.bounds,
      physicalWorkArea: m.workArea,
      dpi: m.dpi,
    };
  });
}

/** Physical point → global DIP using this display's mapping (no display search). */
export function physicalPointToDipOn(display: Win32Display, p: Point): Point {
  const s = display.scaleFactor;
  return {
    x: display.bounds.x + (p.x - display.physicalBounds.x) / s,
    y: display.bounds.y + (p.y - display.physicalBounds.y) / s,
  };
}

/** Global DIP point → physical using this display's mapping (no rounding). */
export function dipPointToPhysicalOn(display: Win32Display, p: Point): Point {
  const s = display.scaleFactor;
  return {
    x: display.physicalBounds.x + (p.x - display.bounds.x) * s,
    y: display.physicalBounds.y + (p.y - display.bounds.y) * s,
  };
}

export function physicalRectToDipOn(display: Win32Display, r: Rect): Rect {
  const origin = physicalPointToDipOn(display, r);
  return { x: origin.x, y: origin.y, width: r.width / display.scaleFactor, height: r.height / display.scaleFactor };
}

export function dipRectToPhysicalOn(display: Win32Display, r: Rect, rounding: PixelRounding = 'none'): Rect {
  const origin = dipPointToPhysicalOn(display, r);
  return roundRect({ x: origin.x, y: origin.y, width: r.width * display.scaleFactor, height: r.height * display.scaleFactor }, rounding);
}

export interface Converted<T> {
  readonly value: T;
  readonly displayIndex: number;
}

/** Physical point → global DIP, using the monitor that contains it physically (nearest otherwise). */
export function physicalToDipPoint(p: Point, displays: readonly Win32Display[]): Converted<Point> | null {
  const displayIndex = displayIndexAtPoint(p, displays.map((d) => ({ bounds: d.physicalBounds })));
  if (displayIndex < 0) return null;
  return { value: physicalPointToDipOn(displays[displayIndex]!, p), displayIndex };
}

/** Global DIP point → physical, using the display that contains it in DIP (nearest otherwise). */
export function dipToPhysicalPoint(p: Point, displays: readonly Win32Display[]): Converted<Point> | null {
  const displayIndex = displayIndexAtPoint(p, displays);
  if (displayIndex < 0) return null;
  return { value: dipPointToPhysicalOn(displays[displayIndex]!, p), displayIndex };
}

/** Physical rect → DIP using the monitor with the largest physical overlap. */
export function physicalToDipRect(r: Rect, displays: readonly Win32Display[]): Converted<Rect> | null {
  const displayIndex = displayIndexForRect(r, displays.map((d) => ({ bounds: d.physicalBounds })));
  if (displayIndex < 0) return null;
  return { value: physicalRectToDipOn(displays[displayIndex]!, r), displayIndex };
}

/** DIP rect → physical using the display with the largest DIP overlap. */
export function dipToPhysicalRect(r: Rect, displays: readonly Win32Display[], rounding: PixelRounding = 'none'): Converted<Rect> | null {
  const displayIndex = displayIndexForRect(r, displays);
  if (displayIndex < 0) return null;
  return { value: dipRectToPhysicalOn(displays[displayIndex]!, r, rounding), displayIndex };
}

/**
 * Bounding box of all monitors in physical pixels (SM_XVIRTUALSCREEN,
 * SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN). Its origin is
 * negative when a monitor sits left of / above the primary.
 */
export function virtualScreenBounds(monitors: readonly HasBounds[]): Rect | null {
  return unionRects(monitors.map((m) => m.bounds));
}

/** Screen (virtual-screen) coordinates → coordinates relative to the virtual-screen origin (≥ 0). */
export function screenToVirtualScreenOffset(p: Point, virtualScreen: Rect): Point {
  return { x: p.x - virtualScreen.x, y: p.y - virtualScreen.y };
}

export function virtualScreenOffsetToScreen(p: Point, virtualScreen: Rect): Point {
  return { x: p.x + virtualScreen.x, y: p.y + virtualScreen.y };
}
