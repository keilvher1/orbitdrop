import { describe, expect, it } from 'vitest';
import { DEFAULT_WHEEL_GEOMETRY, type Rect, type WheelGeometry } from '@orbitdrop/contracts';
import {
  displayIndexForPoint,
  displaysFromAppKitScreens,
  displaysFromWin32Monitors,
  dipRectToPhysicalOn,
  hitTestFromAppKit,
  hitTestFromPhysical,
  hitTestPlacedWheel,
  hitTestWheel,
  innerRadius,
  isArmed,
  normalizeDeg,
  outerRadius,
  physicalPointToDipOn,
  placeWheel,
  placeWheelFromAppKit,
  placeWheelFromPhysical,
  placeWheelOnDisplays,
  sectorCenterDeg,
  sectorOuterRadius,
  sectorSpan,
  sectorStartDeg,
} from '../src';

const G = DEFAULT_WHEEL_GEOMETRY;
const at = (r: number, deg: number) => ({ dx: r * Math.cos((deg * Math.PI) / 180), dy: r * Math.sin((deg * Math.PI) / 180) });

describe('angles and radii', () => {
  it('normalizes into [0, 360)', () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(-90)).toBe(270);
    expect(normalizeDeg(725)).toBe(5);
    expect(normalizeDeg(-725)).toBe(355);
  });

  it('derives radii from the diameter and the geometry', () => {
    expect(outerRadius(360)).toBe(180);
    expect(innerRadius(360)).toBeCloseTo(64.8, 12);
    expect(sectorOuterRadius(360)).toBe(172);
    expect(sectorSpan(8)).toBe(45);
    expect(sectorCenterDeg(0, 8)).toBe(-90);
    expect(sectorCenterDeg(2, 8)).toBe(0);
    expect(sectorStartDeg(0, 4)).toBe(-135);
    expect(sectorStartDeg(1, 4)).toBe(-45);
  });
});

describe('hitTestWheel', () => {
  const g: WheelGeometry = { ...G, innerRadiusRatio: 0.5 }; // d = 200 → inner radius exactly 50

  it('treats the dead-zone radius as inclusive and the outer radius as inclusive', () => {
    expect(hitTestWheel(50, 0, 4, 200, g)).toEqual({ zone: 'center' });
    expect(hitTestWheel(50.0001, 0, 4, 200, g)).toEqual({ zone: 'sector', index: 1 });
    expect(hitTestWheel(100, 0, 4, 200, g)).toEqual({ zone: 'sector', index: 1 });
    expect(hitTestWheel(100.0001, 0, 4, 200, g)).toEqual({ zone: 'outside' });
    expect(hitTestWheel(0, 0, 4, 200, g)).toEqual({ zone: 'center' });
  });

  it('counts the thin outer ring and the sector gaps as part of the sectors', () => {
    const between = (sectorOuterRadius(360) + outerRadius(360)) / 2;
    expect(hitTestWheel(0, -between, 7, 360)).toEqual({ zone: 'sector', index: 0 });
    // On the boundary ray between sector 0 and 1 of an 8-sector wheel (inside the visual gap), slightly clockwise.
    const p = at(120, sectorStartDeg(1, 8) + 0.5);
    expect(hitTestWheel(p.dx, p.dy, 8, 360)).toEqual({ zone: 'sector', index: 1 });
  });

  it('uses half-open sectors: a boundary angle belongs to the clockwise sector', () => {
    // n = 2: sector 0 covers [-180°, 0°), sector 1 covers [0°, 180°) — exact in floating point.
    expect(hitTestWheel(120, 0, 2, 360)).toEqual({ zone: 'sector', index: 1 });
    expect(hitTestWheel(-120, 0, 2, 360)).toEqual({ zone: 'sector', index: 0 });
    expect(hitTestWheel(-120, -0, 2, 360)).toEqual({ zone: 'sector', index: 0 });
  });

  it('starts at 12 o’clock and goes clockwise for every sector count', () => {
    for (let n = 1; n <= 12; n += 1) {
      for (let i = 0; i < n; i += 1) {
        const p = at(120, sectorCenterDeg(i, n));
        expect(hitTestWheel(p.dx, p.dy, n, 360)).toEqual({ zone: 'sector', index: i });
      }
    }
    expect(hitTestWheel(0, -120, 4, 360)).toEqual({ zone: 'sector', index: 0 });
    expect(hitTestWheel(120, 0, 4, 360)).toEqual({ zone: 'sector', index: 1 });
    expect(hitTestWheel(0, 120, 4, 360)).toEqual({ zone: 'sector', index: 2 });
    expect(hitTestWheel(-120, 0, 4, 360)).toEqual({ zone: 'sector', index: 3 });
  });

  it('gives every sector an equal, contiguous wedge (0.1° sweep)', () => {
    for (let n = 1; n <= 12; n += 1) {
      const counts = new Array<number>(n).fill(0);
      let previous = -1;
      let changes = 0;
      for (let k = 0; k < 3600; k += 1) {
        const deg = -90 - 180 / n + 0.05 + k / 10; // start just after the boundary before sector 0
        const p = at(120, deg);
        const hit = hitTestWheel(p.dx, p.dy, n, 360);
        expect(hit.zone).toBe('sector');
        const index = hit.zone === 'sector' ? hit.index : -1;
        counts[index]! += 1;
        if (index !== previous) {
          changes += 1;
          if (previous >= 0) expect(index).toBe((previous + 1) % n);
          previous = index;
        }
      }
      expect(changes).toBe(n);
      for (const c of counts) expect(Math.abs(c - 3600 / n)).toBeLessThanOrEqual(1);
    }
  });

  it('respects a custom start angle', () => {
    const g0 = { ...G, startAngleDeg: 0 };
    expect(hitTestWheel(120, 0, 4, 360, g0)).toEqual({ zone: 'sector', index: 0 });
    expect(hitTestWheel(0, 120, 4, 360, g0)).toEqual({ zone: 'sector', index: 1 });
  });

  it('handles empty, invalid and fractional sector counts and non-finite input', () => {
    expect(hitTestWheel(0, -120, 0, 360)).toEqual({ zone: 'outside' });
    expect(hitTestWheel(0, -120, -3, 360)).toEqual({ zone: 'outside' });
    expect(hitTestWheel(0, -120, Number.NaN, 360)).toEqual({ zone: 'outside' });
    expect(hitTestWheel(0, 0, 0, 360)).toEqual({ zone: 'center' });
    expect(hitTestWheel(-120, 0, 4.9, 360)).toEqual({ zone: 'sector', index: 3 });
    expect(hitTestWheel(Number.NaN, 0, 4, 360)).toEqual({ zone: 'outside' });
    expect(hitTestWheel(Number.POSITIVE_INFINITY, 0, 4, 360)).toEqual({ zone: 'outside' });
    expect(hitTestWheel(1e308, 1e308, 4, 360)).toEqual({ zone: 'outside' });
  });

  it('hit-tests global pointers against a placed wheel', () => {
    const placement = placeWheel({ x: -500, y: 300 }, { x: -1920, y: 0, width: 1920, height: 1040 });
    expect(hitTestPlacedWheel({ x: -500, y: 300 }, placement, 8)).toEqual({ zone: 'center' });
    expect(hitTestPlacedWheel({ x: -500, y: 180 }, placement, 8)).toEqual({ zone: 'sector', index: 0 });
    expect(hitTestPlacedWheel({ x: -500, y: 100 }, placement, 8)).toEqual({ zone: 'outside' });
  });
});

describe('placeWheel', () => {
  const work: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
  const R = G.diameter / 2 + G.edgePadding; // 188

  it('keeps the activation point when the wheel fits around it', () => {
    const p = placeWheel({ x: 960.5, y: 500.25 }, work);
    expect(p).toEqual({
      center: { x: 960.5, y: 500.25 },
      diameter: 360,
      windowFrame: { x: 960.5 - 204, y: 500.25 - 204, width: 408, height: 408 },
      shifted: false,
    });
  });

  it('moves away from every edge and corner', () => {
    const cases: [number, number, number, number][] = [
      [3, 500, R, 500],
      [1917, 500, 1920 - R, 500],
      [960, 3, 960, R],
      [960, 1037, 960, 1040 - R],
      [3, 3, R, R],
      [1917, 3, 1920 - R, R],
      [3, 1037, R, 1040 - R],
      [1917, 1037, 1920 - R, 1040 - R],
      [960, 1075, 960, 1040 - R], // pointer on the taskbar, below the work area
      [-300, -300, R, R], // pointer on another display
    ];
    for (const [x, y, cx, cy] of cases) {
      const p = placeWheel({ x, y }, work);
      expect(p.center).toEqual({ x: cx, y: cy });
      expect(p.shifted).toBe(true);
      expect(p.diameter).toBe(360);
    }
    expect(placeWheel({ x: R, y: 500 }, work).shifted).toBe(false);
  });

  it('works on secondary displays with negative origins and fractional work areas', () => {
    const left = { x: -1536, y: -200, width: 1536, height: 825.6 };
    const p = placeWheel({ x: -1, y: 625 }, left);
    expect(p.center.x).toBe(-R);
    expect(p.center.y).toBeCloseTo(-200 + 825.6 - R, 9);
    expect(p.shifted).toBe(true);
  });

  it('shrinks on a small work area, never below minDiameter, and centers when even that does not fit', () => {
    const small = placeWheel({ x: 120, y: 120 }, { x: 100, y: 100, width: 300, height: 300 });
    expect(small.diameter).toBe(300 - 2 * G.edgePadding);
    expect(small.center).toEqual({ x: 250, y: 250 });
    const tiny = placeWheel({ x: 0, y: 0 }, { x: -250, y: -250, width: 200, height: 200 });
    expect(tiny.diameter).toBe(G.minDiameter);
    expect(tiny.center).toEqual({ x: -150, y: -150 });
    expect(tiny.shifted).toBe(true);
    const wideShort = placeWheel({ x: 5, y: 5 }, { x: 0, y: 0, width: 1000, height: 250 });
    expect(wideShort.diameter).toBe(G.minDiameter);
    expect(wideShort.center).toEqual({ x: 120 + G.edgePadding, y: 125 });
    const exact = placeWheel({ x: 0, y: 1000 }, { x: 10, y: 20, width: 376, height: 376 });
    expect(exact.diameter).toBe(360);
    expect(exact.center).toEqual({ x: 198, y: 208 });
    const empty = placeWheel({ x: 7, y: 7 }, { x: 10, y: 10, width: 0, height: 0 });
    expect(empty.center).toEqual({ x: 10, y: 10 });
    expect(empty.diameter).toBe(G.minDiameter);
  });

  it('uses a configured diameter below minDiameter as is, and caps a huge one by the work area', () => {
    expect(placeWheel({ x: 500, y: 500 }, work, { ...G, diameter: 200 }).diameter).toBe(200);
    expect(placeWheel({ x: 500, y: 500 }, { x: 0, y: 0, width: 700, height: 500 }, { ...G, diameter: 600 }).diameter).toBe(500 - 16);
  });

  it('frames the disc plus the shadow margin', () => {
    const p = placeWheel({ x: 500, y: 500 }, work, { ...G, diameter: 320, windowMargin: 30 });
    expect(p.windowFrame).toEqual({ x: 500 - 190, y: 500 - 190, width: 380, height: 380 });
  });
});

describe('display lookup', () => {
  const displays: Rect[] = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 1280, height: 1024 },
    { x: -1440, y: -900, width: 1440, height: 900 },
  ];

  it('uses half-open containment and falls back to the nearest display', () => {
    expect(displayIndexForPoint({ x: 1920, y: 10 }, displays)).toBe(1);
    expect(displayIndexForPoint({ x: 1919.5, y: 10 }, displays)).toBe(0);
    expect(displayIndexForPoint({ x: 3200, y: 10 }, displays)).toBe(1);
    expect(displayIndexForPoint({ x: 2500, y: 1050 }, displays)).toBe(1);
    expect(displayIndexForPoint({ x: -10, y: -10 }, displays)).toBe(2);
    expect(displayIndexForPoint({ x: 0, y: 0 }, [])).toBe(-1);
  });

  it('places the wheel on the display under the activation point', () => {
    const withWork = displays.map((bounds) => ({ bounds, workArea: { ...bounds, height: bounds.height - 40 } }));
    const placed = placeWheelOnDisplays({ x: 1925, y: 1000 }, withWork)!;
    expect(placed.displayIndex).toBe(1);
    expect(placed.placement.center).toEqual({ x: 1920 + 188, y: 1024 - 40 - 188 });
    expect(placeWheelOnDisplays({ x: 0, y: 0 }, [])).toBeNull();
  });
});

describe('isArmed', () => {
  it('arms after armDistance (inclusive) or after passing through the dead zone', () => {
    const a = { x: 10, y: 10 };
    expect(isArmed(a, a, false)).toBe(false);
    expect(isArmed(a, { x: 16, y: 10 }, false)).toBe(true);
    expect(isArmed(a, { x: 15.999, y: 10 }, false)).toBe(false);
    expect(isArmed(a, { x: 10, y: 10 }, true)).toBe(true);
    expect(isArmed(a, { x: 10, y: 10 }, false, { ...G, armDistance: 0 })).toBe(true);
    expect(isArmed(a, { x: Number.NaN, y: 10 }, false)).toBe(false);
  });
});

describe('platform pipelines', () => {
  it('macOS: AppKit activation → global placement → AppKit window frame', () => {
    const screens = [
      { frame: { x: 0, y: 0, width: 1512, height: 982 }, visibleFrame: { x: 0, y: 0, width: 1512, height: 945 }, backingScaleFactor: 2 },
      { frame: { x: -524, y: 982, width: 2560, height: 1440 }, visibleFrame: { x: -524, y: 982, width: 2560, height: 1415 }, backingScaleFactor: 1 },
    ];
    // Top-left corner of the external display (AppKit y near its maxY = 2422).
    const placed = placeWheelFromAppKit({ x: -520, y: 2420 }, screens)!;
    expect(placed.displayIndex).toBe(1);
    expect(placed.activation).toEqual({ x: -520, y: -1438 });
    // Work area starts 25 pt below the display top (menu bar); padding 8; radius 180.
    expect(placed.placement.center).toEqual({ x: -524 + 188, y: -1415 + 188 });
    const frame = placed.windowFrameAppKit;
    expect(frame.width).toBe(408);
    // The AppKit frame's top edge equals the global top edge flipped.
    expect(frame.y + frame.height).toBe(982 - placed.placement.windowFrame.y);
    const displays = displaysFromAppKitScreens(screens);
    expect(displays[1]!.workArea.y).toBe(-1415);
    // Pointer straight above the center in AppKit (y up) is sector 0.
    const above = { x: placed.placement.center.x, y: 982 - placed.placement.center.y + 120 };
    expect(hitTestFromAppKit(above, screens[0]!.frame, placed.placement, 7)).toEqual({ zone: 'sector', index: 0 });
    expect(placeWheelFromAppKit({ x: 0, y: 0 }, [])).toBeNull();
  });

  it('Windows: physical activation → DIP placement → enclosing physical window frame on mixed DPI', () => {
    const displays = displaysFromWin32Monitors([
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, dpi: 96, primary: true },
      { bounds: { x: -3840, y: 0, width: 3840, height: 2160 }, workArea: { x: -3840, y: 0, width: 3840, height: 2088 }, dpi: 144 },
    ]);
    const placed = placeWheelFromPhysical({ x: -3838, y: 2150 }, displays)!;
    expect(placed.displayIndex).toBe(1);
    expect(placed.activation.x).toBeCloseTo(-2560 + 2 / 1.5, 9);
    expect(placed.placement.center).toEqual({ x: -2560 + 188, y: 1392 - 188 });
    const exact = dipRectToPhysicalOn(displays[1]!, placed.placement.windowFrame);
    const frame = placed.windowFramePhysical;
    expect(Number.isInteger(frame.x) && Number.isInteger(frame.width)).toBe(true);
    expect(frame.x).toBeLessThanOrEqual(exact.x);
    expect(frame.x + frame.width).toBeGreaterThanOrEqual(exact.x + exact.width);
    expect(frame.width).toBe(612);
    expect(physicalPointToDipOn(displays[1]!, placed.centerPhysical).x).toBeCloseTo(placed.placement.center.x, 9);
    // 120 DIP above the center = 180 physical pixels on the 150 % monitor.
    const pointer = { x: Math.round(placed.centerPhysical.x), y: Math.round(placed.centerPhysical.y - 180) };
    expect(hitTestFromPhysical(pointer, displays[1]!, placed.placement, 7)).toEqual({ zone: 'sector', index: 0 });
    expect(placeWheelFromPhysical({ x: 0, y: 0 }, [])).toBeNull();
  });
});

describe('placeWheel with invalid input', () => {
  it('centers on the work area when the activation point is not finite', () => {
    const p = placeWheel({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, { x: -1920, y: 0, width: 1920, height: 1040 });
    expect(p.center).toEqual({ x: -960, y: 520 });
    expect(p.shifted).toBe(true);
  });
});
