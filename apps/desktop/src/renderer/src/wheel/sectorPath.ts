import type { Point } from '@orbitdrop/contracts';

/**
 * SVG outline of one wheel sector: an annular sector with a constant-width gap
 * to its neighbours and rounded corners.
 *
 * Space: SVG user units centred on the wheel (0, 0), y grows downwards, angles
 * in degrees with positive = clockwise on screen — the same conventions as
 * packages/contracts/src/geometry.ts, so sector i here is sector i of
 * `hitTestWheel` (core) and of the native helpers.
 *
 * Construction
 * ------------
 *  1. Sector i of n spans the wedge [θc − S/2, θc + S/2] with S = 360°/n and
 *     θc = startAngleDeg + i·S.
 *  2. Constant-width gap: instead of trimming an angle (which would make the
 *     gap a wedge that widens outwards), each radial boundary line is offset by
 *     h = gap/2 towards the sector's interior. Neighbouring sectors are offset
 *     from the same boundary in opposite directions, so the space between them
 *     is a parallel strip of width `gap` at every radius.
 *  3. The sector is the region bounded by the outer circle (radius R), the
 *     inner circle (radius r) and the two offset lines.
 *  4. Each of the four corners is replaced by a fillet arc of radius c that is
 *     tangent to both boundaries meeting there. With u the unit direction of
 *     the boundary ray and n the unit normal pointing into the sector:
 *       outer corner: centre C = a·u + (h + c)·n, |C| = R − c
 *                     → a = √((R − c)² − (h + c)²)
 *                     tangent on the circle  T = C · R / (R − c)
 *                     tangent on the line    L = a·u + h·n
 *       inner corner: centre C = b·u + (h + c)·n, |C| = r + c
 *                     → b = √((r + c)² − (h + c)²)
 *                     tangent on the circle  T = C · r / (r + c)
 *                     tangent on the line    L = b·u + h·n
 *  5. c is clamped so the fillets fit: c ≤ (R − r)/2 (radial thickness),
 *     h + c ≤ (r + c)·sin(S/2) (inner corners must not cross the sector's
 *     centre line) and h + c ≤ (R − c)·sin(S/2) (same at the outer edge).
 *
 * Path order (clockwise on screen, so every corner turns clockwise and all
 * fillets use sweep-flag 1): start edge inner→outer, outer-start fillet, outer
 * arc clockwise, outer-end fillet, end edge outer→inner, inner-end fillet,
 * inner arc counter-clockwise (sweep 0), inner-start fillet, close.
 */

export interface SectorShapeInput {
  readonly index: number;
  readonly count: number;
  readonly innerRadius: number;
  readonly outerRadius: number;
  /** Constant width of the gap between neighbouring sectors. */
  readonly gap: number;
  readonly cornerRadius: number;
  /** Centre angle of sector 0 (−90 = 12 o'clock). */
  readonly startAngleDeg: number;
}

export interface SectorCorners {
  /** Start edge (θc − S/2): tangent points on the edge line near the inner / outer circle. */
  readonly startLineInner: Point;
  readonly startLineOuter: Point;
  readonly startArcOuter: Point;
  readonly startArcInner: Point;
  readonly endLineInner: Point;
  readonly endLineOuter: Point;
  readonly endArcOuter: Point;
  readonly endArcInner: Point;
}

export interface SectorShape {
  readonly path: string;
  readonly centerAngleDeg: number;
  readonly startAngleDeg: number;
  readonly endAngleDeg: number;
  /** Where the label/icon block is centred. */
  readonly labelPoint: Point;
  /** Corner radius actually used after clamping. */
  readonly cornerRadius: number;
  /** Key points of the outline (absent for a single full ring). */
  readonly corners: SectorCorners | null;
}

const DEG = Math.PI / 180;

export function polar(radius: number, angleDeg: number): Point {
  return { x: radius * Math.cos(angleDeg * DEG), y: radius * Math.sin(angleDeg * DEG) };
}

function fmt(value: number): string {
  // 3 decimals keeps paths compact and stable in snapshots.
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function pt(p: Point): string {
  return `${fmt(p.x)} ${fmt(p.y)}`;
}

/** Largest corner radius that fits a sector of half-angle `halfSpanDeg`. */
export function maxCornerRadius(innerRadius: number, outerRadius: number, gap: number, halfSpanDeg: number): number {
  const h = gap / 2;
  let limit = Math.max(0, (outerRadius - innerRadius) / 2 - 0.01);
  if (halfSpanDeg < 90) {
    const s = Math.sin(halfSpanDeg * DEG);
    const inner = (innerRadius * s - h) / (1 - s);
    const outer = (outerRadius * s - h) / (1 + s);
    limit = Math.min(limit, inner, outer);
  }
  return Math.max(0, limit);
}

/** Full ring (used when a menu has a single sector): outer circle + inner hole, fill-rule evenodd. */
export function annulusPath(innerRadius: number, outerRadius: number): string {
  const R = fmt(outerRadius);
  const r = fmt(innerRadius);
  return [
    `M ${fmt(outerRadius)} 0`,
    `A ${R} ${R} 0 1 1 ${fmt(-outerRadius)} 0`,
    `A ${R} ${R} 0 1 1 ${fmt(outerRadius)} 0`,
    'Z',
    `M ${fmt(innerRadius)} 0`,
    `A ${r} ${r} 0 1 0 ${fmt(-innerRadius)} 0`,
    `A ${r} ${r} 0 1 0 ${fmt(innerRadius)} 0`,
    'Z',
  ].join(' ');
}

export function sectorShape(input: SectorShapeInput): SectorShape {
  const { index, count, innerRadius: r, outerRadius: R, gap, startAngleDeg } = input;
  const span = 360 / count;
  const centerAngleDeg = startAngleDeg + index * span;
  const startDeg = centerAngleDeg - span / 2;
  const endDeg = centerAngleDeg + span / 2;
  const labelPoint = polar((r + R) / 2, centerAngleDeg);

  if (count <= 1) {
    return {
      path: annulusPath(r, R),
      centerAngleDeg,
      startAngleDeg: startDeg,
      endAngleDeg: endDeg,
      labelPoint: polar((r + R) / 2, startAngleDeg),
      cornerRadius: 0,
      corners: null,
    };
  }

  const h = gap / 2;
  const c = Math.min(Math.max(0, input.cornerRadius), maxCornerRadius(r, R, gap, span / 2));

  // Unit vectors along the two boundary rays and their inward normals.
  const us = { x: Math.cos(startDeg * DEG), y: Math.sin(startDeg * DEG) };
  const ns = { x: -us.y, y: us.x }; // towards increasing angle (into the sector)
  const ue = { x: Math.cos(endDeg * DEG), y: Math.sin(endDeg * DEG) };
  const ne = { x: ue.y, y: -ue.x }; // towards decreasing angle (into the sector)

  const along = (u: Point, n: Point, a: number, off: number): Point => ({ x: a * u.x + off * n.x, y: a * u.y + off * n.y });
  const a = Math.sqrt(Math.max(0, (R - c) ** 2 - (h + c) ** 2));
  const b = Math.sqrt(Math.max(0, (r + c) ** 2 - (h + c) ** 2));

  const outerCentre = (u: Point, n: Point) => along(u, n, a, h + c);
  const innerCentre = (u: Point, n: Point) => along(u, n, b, h + c);
  const scale = (p: Point, k: number): Point => ({ x: p.x * k, y: p.y * k });

  const corners: SectorCorners = {
    startLineInner: along(us, ns, b, h),
    startLineOuter: along(us, ns, a, h),
    startArcOuter: scale(outerCentre(us, ns), R / (R - c)),
    startArcInner: scale(innerCentre(us, ns), r / (r + c)),
    endLineInner: along(ue, ne, b, h),
    endLineOuter: along(ue, ne, a, h),
    endArcOuter: scale(outerCentre(ue, ne), R / (R - c)),
    endArcInner: scale(innerCentre(ue, ne), r / (r + c)),
  };

  // Angular extent of the outer/inner arcs decides the large-arc flags.
  const deltaOuter = Math.asin(Math.min(1, (h + c) / (R - c))) / DEG;
  const deltaInner = Math.asin(Math.min(1, (h + c) / (r + c))) / DEG;
  const outerLarge = span - 2 * deltaOuter > 180 ? 1 : 0;
  const innerLarge = span - 2 * deltaInner > 180 ? 1 : 0;
  const cr = fmt(c);

  const path = [
    `M ${pt(corners.startLineInner)}`,
    `L ${pt(corners.startLineOuter)}`,
    c > 0 ? `A ${cr} ${cr} 0 0 1 ${pt(corners.startArcOuter)}` : '',
    `A ${fmt(R)} ${fmt(R)} 0 ${outerLarge} 1 ${pt(corners.endArcOuter)}`,
    c > 0 ? `A ${cr} ${cr} 0 0 1 ${pt(corners.endLineOuter)}` : '',
    `L ${pt(corners.endLineInner)}`,
    c > 0 ? `A ${cr} ${cr} 0 0 1 ${pt(corners.endArcInner)}` : '',
    `A ${fmt(r)} ${fmt(r)} 0 ${innerLarge} 0 ${pt(corners.startArcInner)}`,
    c > 0 ? `A ${cr} ${cr} 0 0 1 ${pt(corners.startLineInner)}` : '',
    'Z',
  ]
    .filter((part) => part !== '')
    .join(' ');

  return { path, centerAngleDeg, startAngleDeg: startDeg, endAngleDeg: endDeg, labelPoint, cornerRadius: c, corners };
}

/** Rounded rectangle path centred on (0, 0). */
export function capsulePath(width: number, height: number): string {
  const rx = height / 2;
  const x = -width / 2;
  const y = -height / 2;
  return `M ${fmt(x + rx)} ${fmt(y)} H ${fmt(x + width - rx)} A ${fmt(rx)} ${fmt(rx)} 0 0 1 ${fmt(x + width - rx)} ${fmt(y + height)} H ${fmt(x + rx)} A ${fmt(rx)} ${fmt(rx)} 0 0 1 ${fmt(x + rx)} ${fmt(y)} Z`;
}
