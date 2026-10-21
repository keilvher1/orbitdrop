/**
 * Shared geometry for the radial menu. Native helpers (Swift, C++) and the
 * renderer's fallback wheel implement hit-testing and placement from this spec;
 * tests/fixtures/wheel-golden.json pins the expected results so all
 * implementations behave the same.
 *
 * Coordinate conventions used across OrbitDrop:
 *  - "Global DIP space": top-left origin, y grows downwards, units are
 *    device-independent pixels (macOS points, Windows DIPs). Secondary displays
 *    may have negative x/y.
 *  - Angles are measured in degrees in that space, so positive angles turn
 *    clockwise on screen; 0° points right and -90° points up.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WheelGeometry {
  /** Wheel diameter in DIP. The product range is 320–380. */
  readonly diameter: number;
  /**
   * Smallest diameter the wheel may shrink to on a tiny work area. The
   * effective floor is `min(minDiameter, diameter)`.
   */
  readonly minDiameter: number;
  /** Stroke width of the thin outer ring. */
  readonly ringWidth: number;
  /** Gap between the outer edge of the wheel and the outer edge of the sectors. */
  readonly ringInset: number;
  /** Sector inner radius as a fraction of the outer radius. Inside it is the dead zone. */
  readonly innerRadiusRatio: number;
  /** Constant-width gap between neighbouring sectors, in DIP. */
  readonly sectorGap: number;
  /** Corner radius of each sector, in DIP. */
  readonly sectorCornerRadius: number;
  /** Center capsule size, in DIP. */
  readonly capsuleWidth: number;
  readonly capsuleHeight: number;
  /** Center angle of sector 0. -90 = 12 o'clock. Sectors continue clockwise. */
  readonly startAngleDeg: number;
  /**
   * Margin around the disc in core's reference `placeWheel().windowFrame`
   * (kept for golden-vector parity). Native windows may size themselves
   * differently: the macOS panel is the disc's bounding square plus a caption
   * strip, with a window-server shadow; the Windows window keeps alpha 0
   * outside the disc. What matters for drops is that pixels outside the disc
   * are not hit-testable, so a release beside the ring reaches the app below.
   */
  readonly windowMargin: number;
  /** Minimum distance between the disc edge and the display work-area edge. */
  readonly edgePadding: number;
  /**
   * Distance the pointer must travel from where the wheel appeared before a
   * sector can be selected. Prevents an immediate drop on a sector when the
   * wheel had to be shifted away from a screen edge.
   */
  readonly armDistance: number;
}

export const DEFAULT_WHEEL_GEOMETRY: WheelGeometry = {
  diameter: 360,
  minDiameter: 240,
  ringWidth: 1.5,
  ringInset: 8,
  innerRadiusRatio: 0.36,
  sectorGap: 6,
  sectorCornerRadius: 14,
  capsuleWidth: 104,
  capsuleHeight: 46,
  startAngleDeg: -90,
  windowMargin: 24,
  edgePadding: 8,
  armDistance: 6,
};

export const WHEEL_DIAMETER_RANGE = { min: 320, max: 380 } as const;

/** Result of hit-testing a point relative to the wheel center. */
export type WheelHit =
  | { readonly zone: 'center' }
  | { readonly zone: 'outside' }
  | { readonly zone: 'sector'; readonly index: number };
