import { DEFAULT_WHEEL_GEOMETRY, type Point, type Rect, type WheelGeometry, type WheelHit } from '@orbitdrop/contracts';

/**
 * Reference implementation of the wheel geometry. native/macos and
 * native/windows port these functions line by line; the golden vectors in
 * tests/fixtures/wheel-golden.json (generated from this file) keep them equal.
 *
 * Space: global DIP, top-left origin, y down. Angles in degrees; positive is
 * clockwise on screen.
 */

/** Normalise an angle to [0, 360). */
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

/** Outer radius of the sector shapes (inside the thin ring). */
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

/**
 * Hit-test a point given relative to the wheel center (dx, dy in DIP).
 *  - r <= innerRadius          → center (dead zone, never selects)
 *  - r >  diameter / 2         → outside
 *  - otherwise                 → sector, chosen by angle over the full wedge
 *                                (the visual gaps between sectors belong to the
 *                                nearest sector so the pointer never "falls
 *                                through" between two slices)
 * Sector i covers the half-open angular interval
 *   [start + i·span − span/2, start + i·span + span/2).
 */
export function hitTestWheel(
  dx: number,
  dy: number,
  sectorCount: number,
  diameter: number,
  g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY,
): WheelHit {
  const r = Math.hypot(dx, dy);
  if (r <= innerRadius(diameter, g)) return { zone: 'center' };
  if (r > outerRadius(diameter)) return { zone: 'outside' };
  if (sectorCount <= 0) return { zone: 'outside' };
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const span = sectorSpan(sectorCount);
  const rel = normalizeDeg(angle - g.startAngleDeg + span / 2);
  const index = Math.min(sectorCount - 1, Math.floor(rel / span));
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
 *  1. diameter = min(g.diameter, min(workArea.w, workArea.h) − 2·edgePadding),
 *     never below g.minDiameter (if even that does not fit, the wheel is
 *     centered on the work area and may touch its edges).
 *  2. center = activation point clamped to
 *     [workArea.x + R + edgePadding, workArea.right − R − edgePadding] (same for y).
 */
export function placeWheel(activation: Point, workArea: Rect, g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY): WheelPlacement {
  const available = Math.min(workArea.width, workArea.height) - 2 * g.edgePadding;
  const diameter = Math.max(g.minDiameter, Math.min(g.diameter, available));
  const radius = diameter / 2;
  const clampAxis = (value: number, start: number, length: number): number => {
    const lo = start + radius + g.edgePadding;
    const hi = start + length - radius - g.edgePadding;
    if (lo > hi) return start + length / 2;
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

/** Index of the display whose bounds contain the point; falls back to the nearest display. */
export function displayIndexForPoint(point: Point, displays: readonly Rect[]): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  displays.forEach((d, i) => {
    const dx = point.x < d.x ? d.x - point.x : point.x >= d.x + d.width ? point.x - (d.x + d.width - 1) : 0;
    const dy = point.y < d.y ? d.y - point.y : point.y >= d.y + d.height ? point.y - (d.y + d.height - 1) : 0;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  });
  return best;
}

/**
 * Sector arming: after the wheel appears, a sector becomes selectable only once
 * the pointer has moved at least `armDistance` DIP from the activation point
 * (or has passed through the dead zone).
 */
export function isArmed(activation: Point, pointer: Point, passedCenter: boolean, g: WheelGeometry = DEFAULT_WHEEL_GEOMETRY): boolean {
  return passedCenter || Math.hypot(pointer.x - activation.x, pointer.y - activation.y) >= g.armDistance;
}
