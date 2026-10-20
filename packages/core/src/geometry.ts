import { DEFAULT_WHEEL_GEOMETRY, type Point, type Rect, type WheelGeometry, type WheelHit } from '@orbitdrop/contracts';
import {
  appKitPointToGlobal,
  dipPointToPhysicalOn,
  dipRectToPhysicalOn,
  displayIndexAtPoint,
  displaysFromAppKitScreens,
  globalRectToAppKit,
  physicalPointToDipOn,
  physicalToDipPoint,
  type AppKitScreen,
  type HasBounds,
  type Win32Display,
} from './coords';

/**
 * Reference implementation of the wheel geometry. native/macos and
 * native/windows port these functions line by line; the golden vectors in
 * tests/fixtures/wheel-golden.json (generated from this file by
 * scripts/gen-golden.mjs) keep them equal.
 *
 * Space: global DIP, top-left origin, y down. Angles in degrees; positive is
 * clockwise on screen. All arithmetic is IEEE-754 double precision.
 */

/** Normalise an angle to [0, 360) (may return 360 − ε rounding to 360 for tiny negative inputs; callers clamp). */
export function normalizeDeg(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

export function outerRadius(diameter: number): number {
  return diameter / 2;
}

export function innerRadius(diameter: number, g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY): number {
  return (diameter / 2) * g.innerRadiusRatio;
}

/** Outer radius of the sector shapes (inside the thin ring). Drawing only: hit-testing uses outerRadius. */
export function sectorOuterRadius(diameter: number, g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY): number {
  return diameter / 2 - g.ringInset;
}

/** Angular span of one sector in degrees. */
export function sectorSpan(sectorCount: number): number {
  return 360 / sectorCount;
}

/** Center angle (degrees) of sector `index`. */
export function sectorCenterDeg(index: number, sectorCount: number, g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY): number {
  return g.startAngleDeg + index * sectorSpan(sectorCount);
}

/** Angle (degrees) where sector `index` begins (its counter-clockwise edge); sector index−1 ends there. */
export function sectorStartDeg(index: number, sectorCount: number, g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY): number {
  const span = sectorSpan(sectorCount);
  return g.startAngleDeg + index * span - span / 2;
}

/**
 * Hit-test a point given relative to the wheel center (dx, dy in DIP, y down).
 *  - non-finite input           → outside
 *  - r <= innerRadius           → center (dead zone, never selects)
 *  - r >  diameter / 2          → outside
 *  - sectorCount < 1            → outside (an empty menu has no sectors)
 *  - otherwise                  → sector, chosen by angle over the full wedge
 *                                 (the visual gaps between sectors and the thin
 *                                 outer ring belong to the nearest sector so the
 *                                 pointer never "falls through")
 * `sectorCount` is truncated to an integer. Sector i covers the half-open
 * angular interval [start + i·span − span/2, start + i·span + span/2).
 */
export function hitTestWheel(
  dx: number,
  dy: number,
  sectorCount: number,
  diameter: number,
  g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY,
): WheelHit {
  const r = Math.hypot(dx, dy);
  if (!Number.isFinite(r)) return { zone: 'outside' };
  if (r <= innerRadius(diameter, g)) return { zone: 'center' };
  if (r > outerRadius(diameter)) return { zone: 'outside' };
  const count = Math.trunc(sectorCount);
  if (!(count >= 1)) return { zone: 'outside' };
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const span = sectorSpan(count);
  const rel = normalizeDeg(angle - g.startAngleDeg + span / 2);
  const index = Math.min(count - 1, Math.floor(rel / span));
  return { zone: 'sector', index };
}

export interface WheelPlacement {
  /** Wheel center in global DIP. */
  readonly center: Point;
  /** Diameter actually used (may shrink on a tiny work area). */
  readonly diameter: number;
  /** Native window frame (disc + margin) in global DIP. */
  readonly windowFrame: Rect;
  /** True when the center had to move away from the activation point. */
  readonly shifted: boolean;
}

/**
 * Place the wheel near the activation point, fully inside the work area of the
 * display that contains the point.
 *  1. smallest = min(g.minDiameter, g.diameter);
 *     diameter = max(smallest, min(g.diameter, min(workArea.w, workArea.h) − 2·edgePadding)).
 *  2. per axis: lo = start + R + edgePadding, hi = start + length − R − edgePadding;
 *     center = clamp(activation, lo, hi), or start + length / 2 when lo > hi
 *     (the wheel does not fit even at its smallest size: it is centered and may
 *     touch the work-area edges) or when the activation coordinate is not finite.
 *  3. windowFrame = square of side diameter + 2·windowMargin centered on center
 *     (the margin may extend beyond the work area; it is transparent).
 *  4. shifted = center differs from the activation point on either axis.
 */
export function placeWheel(activation: Point, workArea: Rect, g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY): WheelPlacement {
  const available = Math.min(workArea.width, workArea.height) - 2 * g.edgePadding;
  const smallest = Math.min(g.minDiameter, g.diameter);
  const diameter = Math.max(smallest, Math.min(g.diameter, available));
  const radius = diameter / 2;
  const clampAxis = (value: number, start: number, length: number): number => {
    const lo = start + radius + g.edgePadding;
    const hi = start + length - radius - g.edgePadding;
    if (lo > hi || !Number.isFinite(value)) return start + length / 2;
    return Math.min(hi, Math.max(lo, value));
  };
  const center = {
    x: clampAxis(activation.x, workArea.x, workArea.width),
    y: clampAxis(activation.y, workArea.y, workArea.height),
  };
  const half = radius + g.windowMargin;
  return {
    center,
    diameter,
    windowFrame: { x: center.x - half, y: center.y - half, width: half * 2, height: half * 2 },
    shifted: center.x !== activation.x || center.y !== activation.y,
  };
}

/**
 * Index of the display whose bounds contain the point (half-open rectangles);
 * falls back to the nearest display; -1 for an empty list. Same rule as
 * coords.displayIndexAtPoint.
 */
export function displayIndexForPoint(point: Point, displays: readonly Rect[]): number {
  return displayIndexAtPoint(
    point,
    displays.map((bounds) => ({ bounds })),
  );
}

export interface DisplayWithWorkArea extends HasBounds {
  readonly workArea: Rect;
}

/**
 * Pick the display for the activation point (containing, else nearest) and
 * place the wheel in its work area. Null when there are no displays.
 */
export function placeWheelOnDisplays(
  activation: Point,
  displays: readonly DisplayWithWorkArea[],
  g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY,
): { readonly displayIndex: number; readonly placement: WheelPlacement } | null {
  const displayIndex = displayIndexAtPoint(activation, displays);
  if (displayIndex < 0) return null;
  return { displayIndex, placement: placeWheel(activation, displays[displayIndex]!.workArea, g) };
}

export interface AppKitWheelPlacement {
  readonly displayIndex: number;
  /** Activation point in global DIP. */
  readonly activation: Point;
  readonly placement: WheelPlacement;
  /** placement.windowFrame in AppKit coordinates (for NSWindow.setFrame). */
  readonly windowFrameAppKit: Rect;
}

/**
 * macOS reference pipeline: AppKit activation point (NSEvent.mouseLocation)
 * → global DIP → display (containing, else nearest) → placeWheel in its work
 * area → window frame back in AppKit coordinates. screens[0] is the primary.
 */
export function placeWheelFromAppKit(
  activationAppKit: Point,
  screens: readonly AppKitScreen[],
  g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY,
): AppKitWheelPlacement | null {
  const primary = screens[0];
  if (primary === undefined) return null;
  const displays = displaysFromAppKitScreens(screens);
  const activation = appKitPointToGlobal(activationAppKit, primary.frame);
  const placed = placeWheelOnDisplays(activation, displays, g);
  if (placed === null) return null;
  return {
    displayIndex: placed.displayIndex,
    activation,
    placement: placed.placement,
    windowFrameAppKit: globalRectToAppKit(placed.placement.windowFrame, primary.frame),
  };
}

/** Pointer in AppKit coordinates → hit on a wheel placed by placeWheelFromAppKit. */
export function hitTestFromAppKit(
  pointerAppKit: Point,
  primaryFrame: Rect,
  placement: Pick<WheelPlacement, 'center' | 'diameter'>,
  sectorCount: number,
  g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY,
): WheelHit {
  return hitTestPlacedWheel(appKitPointToGlobal(pointerAppKit, primaryFrame), placement, sectorCount, g);
}

export interface Win32WheelPlacement {
  /** Monitor containing the activation point physically (nearest otherwise). */
  readonly displayIndex: number;
  /** Activation point in global DIP. */
  readonly activation: Point;
  readonly placement: WheelPlacement;
  /** placement.windowFrame in physical pixels on that monitor, 'enclosing' rounding (for SetWindowPos). */
  readonly windowFramePhysical: Rect;
  /** Wheel center in physical pixels (unrounded). */
  readonly centerPhysical: Point;
}

/**
 * Windows reference pipeline (Per-Monitor DPI Aware v2): physical activation
 * point (GetCursorPos) → monitor by physical containment → global DIP with that
 * monitor's mapping → placeWheel in its DIP work area → window frame back to
 * physical pixels with the same monitor's mapping, enclosing rounding.
 */
export function placeWheelFromPhysical(
  activationPhysical: Point,
  displays: readonly Win32Display[],
  g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY,
): Win32WheelPlacement | null {
  const converted = physicalToDipPoint(activationPhysical, displays);
  if (converted === null) return null;
  const display = displays[converted.displayIndex]!;
  const placement = placeWheel(converted.value, display.workArea, g);
  return {
    displayIndex: converted.displayIndex,
    activation: converted.value,
    placement,
    windowFramePhysical: dipRectToPhysicalOn(display, placement.windowFrame, 'enclosing'),
    centerPhysical: dipPointToPhysicalOn(display, placement.center),
  };
}

/**
 * Pointer in physical pixels (IDropTarget::DragOver POINTL) → hit on a wheel
 * placed by placeWheelFromPhysical. Always converts with the wheel's monitor
 * (the wheel lies inside that monitor's work area).
 */
export function hitTestFromPhysical(
  pointerPhysical: Point,
  wheelDisplay: Win32Display,
  placement: Pick<WheelPlacement, 'center' | 'diameter'>,
  sectorCount: number,
  g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY,
): WheelHit {
  return hitTestPlacedWheel(physicalPointToDipOn(wheelDisplay, pointerPhysical), placement, sectorCount, g);
}

/** Hit-test a pointer given in global DIP against a placed wheel. */
export function hitTestPlacedWheel(
  pointer: Point,
  placement: Pick<WheelPlacement, 'center' | 'diameter'>,
  sectorCount: number,
  g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY,
): WheelHit {
  return hitTestWheel(pointer.x - placement.center.x, pointer.y - placement.center.y, sectorCount, placement.diameter, g);
}

/**
 * Sector arming: after the wheel appears, a sector becomes selectable only once
 * the pointer has moved at least `armDistance` DIP from the activation point
 * (or has passed through the dead zone). Non-finite pointers are never armed.
 */
export function isArmed(activation: Point, pointer: Point, passedCenter: boolean, g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY): boolean {
  if (passedCenter) return true;
  const distance = Math.hypot(pointer.x - activation.x, pointer.y - activation.y);
  return Number.isFinite(distance) && distance >= g.armDistance;
}
