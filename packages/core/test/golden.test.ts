import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WHEEL_GEOMETRY, type Rect, type WheelHit } from '@orbitdrop/contracts';
import { displaysFromWin32Monitors, distanceBetweenRects, dipPointToPhysicalOn, globalPointToAppKit, intersectRects } from '../src';
import { GOLDEN_FORMAT_VERSION, GOLDEN_RELATIVE_PATH, assertRobustHitPoint, generateWheelGolden, serializeGolden } from '../src/golden/wheel-golden';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const goldenPath = join(repoRoot, GOLDEN_RELATIVE_PATH);
const committedText = readFileSync(goldenPath, 'utf8').replace(/\r\n/g, '\n');
const golden = JSON.parse(committedText) as ReturnType<typeof generateWheelGolden>;
const G = DEFAULT_WHEEL_GEOMETRY;

type Case = { n: number; d: number; dx: number; dy: number; zone: WheelHit['zone']; index?: number; kind: string };
const hitCases = golden.hitTest.cases as Case[];

/** float32 port with a different operation order (what a careless native port might do). */
function hitFloat32(dx: number, dy: number, n: number, d: number): WheelHit {
  const f = Math.fround;
  const x = f(dx);
  const y = f(dy);
  const r = f(Math.sqrt(f(f(x * x) + f(y * y))));
  if (r <= f(f(f(d) * f(G.innerRadiusRatio)) / 2)) return { zone: 'center' };
  if (r > f(f(d) / 2)) return { zone: 'outside' };
  if (n < 1) return { zone: 'outside' };
  const angle = f(f(Math.atan2(y, x)) * f(180 / Math.PI));
  const span = f(360 / n);
  let rel = f(f(f(angle - f(G.startAngleDeg)) + f(span / 2)) % 360);
  if (rel < 0) rel = f(rel + 360);
  return { zone: 'sector', index: Math.min(n - 1, Math.floor(f(rel / span))) };
}

/**
 * y-up port (AppKit style): the pointer offset is given with y growing upwards,
 * angles are counter-clockwise radians, sectors are found by walking boundaries.
 */
function hitYUpRadians(dxUp: number, dyUp: number, n: number, d: number): WheelHit {
  const r = Math.sqrt(dxUp * dxUp + dyUp * dyUp);
  if (2 * r <= d * G.innerRadiusRatio) return { zone: 'center' };
  if (2 * r > d) return { zone: 'outside' };
  if (n < 1) return { zone: 'outside' };
  const twoPi = 2 * Math.PI;
  // Clockwise angle from the start direction, measured in y-up space.
  const startUp = (-G.startAngleDeg * Math.PI) / 180;
  const span = twoPi / n;
  let cw = startUp - Math.atan2(dyUp, dxUp) + span / 2;
  cw = ((cw % twoPi) + twoPi) % twoPi;
  let index = 0;
  while (index < n - 1 && cw >= (index + 1) * span) index += 1;
  return { zone: 'sector', index };
}

function sameHit(c: Case, hit: WheelHit): boolean {
  return hit.zone === c.zone && (hit.zone !== 'sector' || hit.index === c.index);
}

describe('wheel-golden.json', () => {
  it('matches the reference implementation byte for byte (run `node scripts/gen-golden.mjs` after intended changes)', () => {
    const regenerated = serializeGolden(generateWheelGolden());
    if (regenerated !== committedText) {
      // Find the first differing line to make the failure readable.
      const a = regenerated.split('\n');
      const b = committedText.split('\n');
      const line = a.findIndex((l, i) => l !== b[i]);
      expect.fail(`${GOLDEN_RELATIVE_PATH} drifted at line ${line + 1}:\n  committed:   ${b[line]}\n  regenerated: ${a[line]}\nRun: node scripts/gen-golden.mjs`);
    }
    expect(golden.formatVersion).toBe(GOLDEN_FORMAT_VERSION);
    expect(golden.geometry).toEqual(G);
  });

  it('documents its schema for native consumers', () => {
    expect(golden.$comment.join(' ')).toContain('y DOWN');
    for (const key of ['hitTest', 'hitTestNonFinite', 'placement', 'arming', 'selection', 'fileCount', 'coords.mac', 'coords.win', 'coords.displayForPoint', 'coords.clamp', 'coords.rounding']) {
      expect(golden.schema).toHaveProperty([key]);
    }
  });

  it('covers sector counts 0–12 on every diameter, both sides of every boundary', () => {
    for (const d of [240, 320, 360, 380]) {
      for (let n = 0; n <= 12; n += 1) {
        const subset = hitCases.filter((c) => c.d === d && c.n === n);
        expect(subset.some((c) => c.zone === 'center')).toBe(true);
        expect(subset.some((c) => c.zone === 'outside')).toBe(true);
        if (n === 0) {
          expect(subset.every((c) => c.zone !== 'sector')).toBe(true);
          continue;
        }
        const radii = [4, 7, 8, 9].includes(n) ? 3 : 1;
        expect(subset.filter((c) => c.kind === 'boundaryAfter')).toHaveLength(n * radii);
        expect(subset.filter((c) => c.kind === 'boundaryBefore')).toHaveLength(n * radii);
        for (let i = 0; i < n; i += 1) expect(subset.some((c) => c.zone === 'sector' && c.index === i)).toBe(true);
      }
    }
  });

  it('keeps every hit-test point ≥ 0.01° and ≥ 0.01 DIP away from boundaries and radius limits', () => {
    for (const c of hitCases) expect(() => assertRobustHitPoint(c.dx, c.dy, c.n, c.d)).not.toThrow();
  });

  it('is reproduced by a float32 port and by a y-up / radians port', () => {
    const failures: string[] = [];
    for (const c of hitCases) {
      if (!sameHit(c, hitFloat32(c.dx, c.dy, c.n, c.d))) failures.push(`float32 ${JSON.stringify(c)}`);
      if (!sameHit(c, hitYUpRadians(c.dx, -c.dy, c.n, c.d))) failures.push(`y-up ${JSON.stringify(c)}`);
    }
    expect(failures).toEqual([]);
  });

  it('placement expectations satisfy the placement invariants', () => {
    for (const c of golden.placement.cases as {
      diameter: number;
      activation: { x: number; y: number };
      workArea: Rect;
      expect: { center: { x: number; y: number }; diameter: number; windowFrame: Rect; shifted: boolean };
    }[]) {
      const { center, diameter, windowFrame, shifted } = c.expect;
      const configured = c.diameter;
      const smallest = Math.min(G.minDiameter, configured);
      expect(diameter).toBeLessThanOrEqual(configured);
      expect(diameter).toBeGreaterThanOrEqual(smallest);
      const fits = diameter + 2 * G.edgePadding <= Math.min(c.workArea.width, c.workArea.height) + 1e-9;
      if (fits) {
        expect(center.x - diameter / 2).toBeGreaterThanOrEqual(c.workArea.x + G.edgePadding - 1e-9);
        expect(center.y - diameter / 2).toBeGreaterThanOrEqual(c.workArea.y + G.edgePadding - 1e-9);
        expect(center.x + diameter / 2).toBeLessThanOrEqual(c.workArea.x + c.workArea.width - G.edgePadding + 1e-9);
        expect(center.y + diameter / 2).toBeLessThanOrEqual(c.workArea.y + c.workArea.height - G.edgePadding + 1e-9);
      }
      expect(windowFrame.width).toBeCloseTo(diameter + 2 * G.windowMargin, 9);
      expect(windowFrame.x + windowFrame.width / 2).toBeCloseTo(center.x, 9);
      expect(windowFrame.y + windowFrame.height / 2).toBeCloseTo(center.y, 9);
      expect(shifted).toBe(center.x !== c.activation.x || center.y !== c.activation.y);
    }
  });

  it('arming expectations follow the distance rule', () => {
    for (const c of golden.arming.cases as { armDistance: number; activation: { x: number; y: number }; pointer: { x: number; y: number }; passedCenter: boolean; expect: boolean }[]) {
      const distance = Math.hypot(c.pointer.x - c.activation.x, c.pointer.y - c.activation.y);
      expect(c.expect).toBe(c.passedCenter || distance >= c.armDistance);
    }
  });

  it('selection maps leave HEIC out without a decoder and PDF out without PDF.js', () => {
    const maps = golden.selection.extensionMaps as Record<string, Record<string, string>>;
    expect(maps.darwin).not.toHaveProperty(['.heic']);
    for (const c of golden.selection.cases) expect(Object.keys(maps)).toContain(c.map);
    expect(maps.darwinImageIO).toHaveProperty(['.heic'], 'image/heic');
    expect(maps.noPdf).not.toHaveProperty(['.pdf']);
    expect(maps.darwin).toHaveProperty(['.bmp'], 'image/bmp');
    for (const key of Object.keys(maps.darwin!)) expect(key).toMatch(/^\.[a-z0-9]{1,8}$/);
    const nfd = golden.selection.cases.find((c) => c.note === 'Korean NFD name')!;
    expect(nfd.paths[0]).not.toBe(nfd.paths[0]!.normalize('NFC'));
  });

  it('Windows layouts: no overlaps in DIP, every monitor stays attached, conversions round-trip', () => {
    for (const layout of golden.coords.win) {
      const displays = displaysFromWin32Monitors(layout.monitors);
      expect(displays.map((d) => ({ bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, primary: d.primary }))).toEqual(layout.displays);
      for (let i = 0; i < displays.length; i += 1) {
        for (let j = i + 1; j < displays.length; j += 1) expect(intersectRects(displays[i]!.bounds, displays[j]!.bounds)).toBeNull();
        if (displays.length > 1 && layout.name !== 'gap-fallback') {
          const touches = displays.some((other, j) => j !== i && distanceBetweenRects(other.bounds, displays[i]!.bounds) === 0);
          expect(touches).toBe(true);
        }
      }
      for (const c of layout.physicalToDip) {
        const back = dipPointToPhysicalOn(displays[c.displayIndex]!, c.dip);
        expect(back.x).toBeCloseTo(c.physical.x, 9);
        expect(back.y).toBeCloseTo(c.physical.y, 9);
      }
    }
  });

  it('macOS layouts round-trip between AppKit and global coordinates', () => {
    for (const layout of golden.coords.mac) {
      const primary = layout.screens[0]!.frame;
      for (const c of layout.points) expect(globalPointToAppKit(c.global, primary)).toEqual(c.appKit);
    }
  });

  it('contains no null values except "no menu" selection results', () => {
    const nulls: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === null) nulls.push(path);
      else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    };
    walk(golden, '$');
    expect(nulls.every((p) => /^\$\.selection\.cases\[\d+\]\.expect$/.test(p))).toBe(true);
  });
});

describe('wheel-golden.json non-finite cases', () => {
  it('encodes NaN/Infinity as strings and expects "outside"', async () => {
    const { hitTestWheel } = await import('../src');
    for (const c of golden.hitTestNonFinite.cases) {
      const decode = (v: number | string) => (typeof v === 'number' ? v : Number(v));
      expect(hitTestWheel(decode(c.dx), decode(c.dy), c.n, c.d)).toEqual({ zone: 'outside' });
      expect(c.zone).toBe('outside');
    }
    expect(golden.hitTestNonFinite.cases.length).toBeGreaterThanOrEqual(5);
  });
});
