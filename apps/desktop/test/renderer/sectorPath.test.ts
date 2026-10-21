import { DEFAULT_WHEEL_GEOMETRY, type Point } from '@orbitdrop/contracts';
import { hitTestWheel, innerRadius, sectorOuterRadius } from '@orbitdrop/core';
import { describe, expect, it } from 'vitest';
import { maxCornerRadius, polar, sectorShape } from '../../src/renderer/src/wheel/sectorPath';

const g = DEFAULT_WHEEL_GEOMETRY;
const D = 360;
const R = sectorOuterRadius(D, g);
const r = innerRadius(D, g);

/** Signed distance of p from the line through the origin at angle deg (positive towards increasing angle). */
function distFromRay(p: Point, deg: number): number {
  const a = (deg * Math.PI) / 180;
  return -p.x * Math.sin(a) + p.y * Math.cos(a);
}

const radius = (p: Point) => Math.hypot(p.x, p.y);

describe('sectorShape', () => {
  it.each([3, 4, 7, 8, 9, 12])('keeps a constant gap of %i-sector wheels on both edges', (count) => {
    for (let index = 0; index < count; index += 1) {
      const s = sectorShape({ index, count, innerRadius: r, outerRadius: R, gap: g.sectorGap, cornerRadius: g.sectorCornerRadius, startAngleDeg: g.startAngleDeg });
      const c = s.corners!;
      // Start edge points are gap/2 inside the start boundary, end edge points gap/2 inside the end boundary.
      expect(distFromRay(c.startLineInner, s.startAngleDeg)).toBeCloseTo(g.sectorGap / 2, 6);
      expect(distFromRay(c.startLineOuter, s.startAngleDeg)).toBeCloseTo(g.sectorGap / 2, 6);
      expect(-distFromRay(c.endLineInner, s.endAngleDeg)).toBeCloseTo(g.sectorGap / 2, 6);
      expect(-distFromRay(c.endLineOuter, s.endAngleDeg)).toBeCloseTo(g.sectorGap / 2, 6);
      // Arc tangent points lie on the outer and inner circles.
      expect(radius(c.startArcOuter)).toBeCloseTo(R, 6);
      expect(radius(c.endArcOuter)).toBeCloseTo(R, 6);
      expect(radius(c.startArcInner)).toBeCloseTo(r, 6);
      expect(radius(c.endArcInner)).toBeCloseTo(r, 6);
    }
  });

  it('neighbouring sectors are exactly one gap apart (parallel strip)', () => {
    const count = 7;
    const a = sectorShape({ index: 0, count, innerRadius: r, outerRadius: R, gap: 6, cornerRadius: 14, startAngleDeg: -90 }).corners!;
    const b = sectorShape({ index: 1, count, innerRadius: r, outerRadius: R, gap: 6, cornerRadius: 14, startAngleDeg: -90 }).corners!;
    const boundary = -90 + 360 / count / 2;
    expect(distFromRay(b.startLineOuter, boundary) - distFromRay(a.endLineOuter, boundary)).toBeCloseTo(6, 6);
    expect(distFromRay(b.startLineInner, boundary) - distFromRay(a.endLineInner, boundary)).toBeCloseTo(6, 6);
  });

  it('fillets are tangent: corner points are at distance c from the fillet centre', () => {
    const s = sectorShape({ index: 2, count: 8, innerRadius: r, outerRadius: R, gap: 6, cornerRadius: 14, startAngleDeg: -90 });
    const c = s.corners!;
    const k = s.cornerRadius;
    // Outer-start fillet centre: on the ray through startArcOuter at radius R - k.
    const centre = { x: (c.startArcOuter.x * (R - k)) / R, y: (c.startArcOuter.y * (R - k)) / R };
    expect(Math.hypot(centre.x - c.startLineOuter.x, centre.y - c.startLineOuter.y)).toBeCloseTo(k, 6);
    const innerCentre = { x: (c.endArcInner.x * (r + k)) / r, y: (c.endArcInner.y * (r + k)) / r };
    expect(Math.hypot(innerCentre.x - c.endLineInner.x, innerCentre.y - c.endLineInner.y)).toBeCloseTo(k, 6);
  });

  it('clamps the corner radius so fillets fit thin or narrow sectors', () => {
    expect(maxCornerRadius(60, 70, 6, 20)).toBeLessThanOrEqual(5);
    const s = sectorShape({ index: 0, count: 12, innerRadius: 30, outerRadius: 172, gap: 6, cornerRadius: 40, startAngleDeg: -90 });
    expect(s.cornerRadius).toBeLessThan(40);
    expect(s.path).not.toContain('NaN');
  });

  it('builds a closed path with four fillet arcs, an outer arc (sweep 1) and an inner arc (sweep 0)', () => {
    const s = sectorShape({ index: 0, count: 4, innerRadius: r, outerRadius: R, gap: 6, cornerRadius: 14, startAngleDeg: -90 });
    expect(s.path.startsWith('M ')).toBe(true);
    expect(s.path.endsWith('Z')).toBe(true);
    const arcs = [...s.path.matchAll(/A ([\d.]+) [\d.]+ 0 (\d) (\d)/g)].map((m) => ({ r: Number(m[1]), large: m[2], sweep: m[3] }));
    expect(arcs).toHaveLength(6);
    expect(arcs.filter((a) => a.r === 14).every((a) => a.sweep === '1')).toBe(true);
    expect(arcs.find((a) => a.r === R)?.sweep).toBe('1');
    expect(arcs.find((a) => a.r === r)?.sweep).toBe('0');
  });

  it('a single sector is a full ring', () => {
    const s = sectorShape({ index: 0, count: 1, innerRadius: r, outerRadius: R, gap: 6, cornerRadius: 14, startAngleDeg: -90 });
    expect(s.corners).toBeNull();
    expect(s.path.match(/M /g)).toHaveLength(2);
  });

  it('places sector i where core hitTestWheel reports sector i (same geometry as the native helpers)', () => {
    for (const count of [4, 7, 9]) {
      for (let index = 0; index < count; index += 1) {
        const s = sectorShape({ index, count, innerRadius: r, outerRadius: R, gap: 6, cornerRadius: 14, startAngleDeg: g.startAngleDeg });
        const p = s.labelPoint;
        expect(hitTestWheel(p.x, p.y, count, D, g)).toEqual({ zone: 'sector', index });
        // Points just inside both edges belong to this sector too.
        const nearStart = polar((r + R) / 2, s.startAngleDeg + 1);
        const nearEnd = polar((r + R) / 2, s.endAngleDeg - 1);
        expect(hitTestWheel(nearStart.x, nearStart.y, count, D, g)).toEqual({ zone: 'sector', index });
        expect(hitTestWheel(nearEnd.x, nearEnd.y, count, D, g)).toEqual({ zone: 'sector', index });
      }
    }
  });

  it('sector 0 is centred at 12 o\'clock and the order is clockwise', () => {
    const s0 = sectorShape({ index: 0, count: 4, innerRadius: r, outerRadius: R, gap: 6, cornerRadius: 14, startAngleDeg: -90 });
    const s1 = sectorShape({ index: 1, count: 4, innerRadius: r, outerRadius: R, gap: 6, cornerRadius: 14, startAngleDeg: -90 });
    expect(s0.labelPoint.x).toBeCloseTo(0, 6);
    expect(s0.labelPoint.y).toBeLessThan(0); // above the centre (y down)
    expect(s1.labelPoint.x).toBeGreaterThan(0); // 3 o'clock
    expect(s1.labelPoint.y).toBeCloseTo(0, 6);
  });
});
