import { describe, expect, it } from 'vitest';
import type { Rect } from '@orbitdrop/contracts';
import {
  appKitPointToGlobal,
  appKitRectToGlobal,
  clampRectIntoArea,
  dipPointToPhysicalOn,
  dipRectToPhysicalOn,
  dipToPhysicalPoint,
  dipToPhysicalRect,
  displayForPoint,
  displayIndexAtPoint,
  displayIndexForRect,
  displaysFromAppKitScreens,
  displaysFromWin32Monitors,
  distanceBetweenRects,
  distanceToRect,
  fitRectIntoArea,
  globalPointToAppKit,
  globalRectToAppKit,
  insetRect,
  intersectRects,
  physicalPointToDipOn,
  physicalRectToDipOn,
  physicalToDipPoint,
  physicalToDipRect,
  rectCenter,
  rectCenteredAt,
  rectContainsPoint,
  roundHalfUp,
  roundRect,
  scaleFactorForDpi,
  screenToVirtualScreenOffset,
  unionRects,
  virtualScreenBounds,
  virtualScreenOffsetToScreen,
  type Win32Monitor,
} from '../src';

/** Deterministic pseudo-random numbers (no flaky tests). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('rect helpers', () => {
  const r: Rect = { x: -10, y: 20, width: 100, height: 50 };

  it('contains points half-open', () => {
    expect(rectContainsPoint(r, { x: -10, y: 20 })).toBe(true);
    expect(rectContainsPoint(r, { x: 89.999, y: 69.999 })).toBe(true);
    expect(rectContainsPoint(r, { x: 90, y: 30 })).toBe(false);
    expect(rectContainsPoint(r, { x: 0, y: 70 })).toBe(false);
    expect(rectContainsPoint({ x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0 })).toBe(false);
  });

  it('measures distances to closed rectangles', () => {
    expect(distanceToRect(r, { x: 0, y: 30 })).toBe(0);
    expect(distanceToRect(r, { x: 90, y: 70 })).toBe(0);
    expect(distanceToRect(r, { x: 93, y: 74 })).toBe(5);
    expect(distanceBetweenRects(r, { x: 90, y: 70, width: 5, height: 5 })).toBe(0);
    expect(distanceBetweenRects(r, { x: 93, y: 74, width: 5, height: 5 })).toBe(5);
  });

  it('intersects, unions, insets and centers', () => {
    expect(intersectRects(r, { x: 80, y: 60, width: 20, height: 20 })).toEqual({ x: 80, y: 60, width: 10, height: 10 });
    expect(intersectRects(r, { x: 90, y: 20, width: 5, height: 5 })).toBeNull();
    expect(unionRects([r, { x: 200, y: -5, width: 1, height: 1 }])).toEqual({ x: -10, y: -5, width: 211, height: 75 });
    expect(unionRects([])).toBeNull();
    expect(insetRect(r, 10)).toEqual({ x: 0, y: 30, width: 80, height: 30 });
    expect(insetRect(r, -5)).toEqual({ x: -15, y: 15, width: 110, height: 60 });
    expect(insetRect(r, 40)).toEqual({ x: 30, y: 45, width: 20, height: 0 });
    expect(rectCenter(r)).toEqual({ x: 40, y: 45 });
    expect(rectCenteredAt({ x: 0, y: 0 }, { width: 10, height: 4 })).toEqual({ x: -5, y: -2, width: 10, height: 4 });
  });

  it('clamps a window frame into a work area (moving, never resizing)', () => {
    const area = { x: -1920, y: 0, width: 1920, height: 1040 };
    expect(clampRectIntoArea({ x: -500, y: 100, width: 480, height: 600 }, area)).toEqual({ x: -500, y: 100, width: 480, height: 600 });
    expect(clampRectIntoArea({ x: -2000, y: -50, width: 480, height: 600 }, area)).toEqual({ x: -1920, y: 0, width: 480, height: 600 });
    expect(clampRectIntoArea({ x: -100, y: 900, width: 480, height: 600 }, area)).toEqual({ x: -480, y: 440, width: 480, height: 600 });
    expect(clampRectIntoArea({ x: 0, y: 0, width: 2000, height: 600 }, area)).toEqual({ x: -1960, y: 0, width: 2000, height: 600 });
  });

  it('fits a too-large window into the work area', () => {
    const area = { x: 0, y: 25, width: 1440, height: 875 };
    expect(fitRectIntoArea({ x: 1000, y: 500, width: 2000, height: 600 }, area)).toEqual({ x: 0, y: 300, width: 1440, height: 600 });
    expect(fitRectIntoArea({ x: 100, y: 100, width: 300, height: 2000 }, area)).toEqual({ x: 100, y: 25, width: 300, height: 875 });
  });
});

describe('display lookup', () => {
  const displays = [
    { id: 'a', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1, primary: true, extra: 1 },
    { id: 'b', bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, workArea: { x: 1920, y: 0, width: 1280, height: 1024 }, scaleFactor: 2, primary: false, extra: 2 },
  ];

  it('returns the containing display (first in list order for overlaps), else the nearest', () => {
    expect(displayForPoint({ x: 1920, y: 5 }, displays)?.id).toBe('b');
    expect(displayForPoint({ x: 3300, y: 2000 }, displays)?.id).toBe('b');
    expect(displayForPoint({ x: -50, y: 2000 }, displays)?.id).toBe('a');
    expect(displayForPoint({ x: 0, y: 0 }, [])).toBeUndefined();
    const overlapping = [{ bounds: { x: 0, y: 0, width: 100, height: 100 } }, { bounds: { x: 50, y: 50, width: 100, height: 100 } }];
    expect(displayIndexAtPoint({ x: 60, y: 60 }, overlapping)).toBe(0);
    const tie = [{ bounds: { x: 0, y: 0, width: 10, height: 10 } }, { bounds: { x: 20, y: 0, width: 10, height: 10 } }];
    expect(displayIndexAtPoint({ x: 15, y: 5 }, tie)).toBe(0);
  });

  it('assigns a rectangle to the display it overlaps most', () => {
    expect(displayIndexForRect({ x: 1800, y: 100, width: 300, height: 300 }, displays)).toBe(1);
    expect(displayIndexForRect({ x: 1700, y: 100, width: 300, height: 300 }, displays)).toBe(0);
    expect(displayIndexForRect({ x: 5000, y: 100, width: 10, height: 10 }, displays)).toBe(1);
    expect(displayIndexForRect({ x: 0, y: 0, width: 1, height: 1 }, [])).toBe(-1);
  });
});

describe('rounding', () => {
  it('rounds halves up (towards +infinity)', () => {
    expect([-2.5, -1.5, -0.5, 0.5, 1.5, 2.5].map(roundHalfUp)).toEqual([-2, -1, 0, 1, 2, 3]);
    expect(roundHalfUp(2.4999)).toBe(2);
    expect(roundHalfUp(-2.5001)).toBe(-3);
  });

  it('rounds rectangles by edges', () => {
    const r = { x: 0.5, y: -0.5, width: 10, height: 2.2 };
    expect(roundRect(r, 'none')).toBe(r);
    expect(roundRect(r, 'nearest')).toEqual({ x: 1, y: 0, width: 10, height: 2 });
    expect(roundRect(r, 'enclosing')).toEqual({ x: 0, y: -1, width: 11, height: 3 });
    // Values within 1e-6 of an integer snap instead of growing the rectangle.
    expect(roundRect({ x: 1.0000001, y: 2.9999999, width: 3.9999998, height: 1.0000002 }, 'enclosing')).toEqual({ x: 1, y: 3, width: 4, height: 1 });
  });
});

describe('macOS (AppKit) conversion', () => {
  const primary = { x: 0, y: 0, width: 1512, height: 982 };

  it('flips y around the primary screen height and back', () => {
    expect(appKitPointToGlobal({ x: 10, y: 982 }, primary)).toEqual({ x: 10, y: 0 });
    expect(appKitPointToGlobal({ x: 10, y: 0 }, primary)).toEqual({ x: 10, y: 982 });
    expect(appKitPointToGlobal({ x: -300, y: 2400 }, primary)).toEqual({ x: -300, y: -1418 });
    const random = rng(1);
    for (let i = 0; i < 200; i += 1) {
      const p = { x: (random() - 0.5) * 8000, y: (random() - 0.5) * 8000 };
      const back = globalPointToAppKit(appKitPointToGlobal(p, primary), primary);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
      const rect = { x: p.x, y: p.y, width: random() * 500, height: random() * 500 };
      const r2 = globalRectToAppKit(appKitRectToGlobal(rect, primary), primary);
      expect(r2.y).toBeCloseTo(rect.y, 9);
    }
  });

  it('converts a rectangle by its top edge', () => {
    // Menu bar strip at the top of the primary screen.
    expect(appKitRectToGlobal({ x: 0, y: 945, width: 1512, height: 37 }, primary)).toEqual({ x: 0, y: 0, width: 1512, height: 37 });
  });

  it('builds displays in NSScreen order with work areas excluding menu bar and Dock', () => {
    const displays = displaysFromAppKitScreens([
      { frame: primary, visibleFrame: { x: 0, y: 60, width: 1512, height: 885 }, backingScaleFactor: 2 },
      { id: 'ext', frame: { x: 1512, y: -300, width: 1920, height: 1080 }, visibleFrame: { x: 1512, y: -300, width: 1920, height: 1055 }, backingScaleFactor: 1 },
    ]);
    expect(displays[0]).toMatchObject({ id: 'screen-0', primary: true, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1512, height: 982 } });
    expect(displays[0]!.workArea).toEqual({ x: 0, y: 37, width: 1512, height: 885 });
    expect(displays[1]).toMatchObject({ id: 'ext', primary: false, bounds: { x: 1512, y: 202, width: 1920, height: 1080 } });
    expect(displays[1]!.workArea).toEqual({ x: 1512, y: 227, width: 1920, height: 1055 });
    expect(displaysFromAppKitScreens([])).toEqual([]);
  });
});

describe('Windows (physical pixels, per-monitor DPI)', () => {
  const mixed: Win32Monitor[] = [
    { bounds: { x: -1920, y: -120, width: 1920, height: 1200 }, workArea: { x: -1920, y: -120, width: 1920, height: 1160 }, dpi: 96 },
    { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1392 }, dpi: 120, primary: true },
    { bounds: { x: 2560, y: -200, width: 3840, height: 2160 }, workArea: { x: 2560, y: -200, width: 3840, height: 2064 }, dpi: 192 },
  ];

  it('maps every monitor by physical / scale when all share one DPI', () => {
    const displays = displaysFromWin32Monitors([
      { bounds: { x: 0, y: 0, width: 2880, height: 1800 }, workArea: { x: 0, y: 0, width: 2880, height: 1728 }, dpi: 144 },
      { bounds: { x: -2880, y: 300, width: 2880, height: 1800 }, workArea: { x: -2880, y: 300, width: 2880, height: 1728 }, dpi: 144 },
      { bounds: { x: 0, y: -1800, width: 2880, height: 1800 }, workArea: { x: 0, y: -1800, width: 2880, height: 1728 }, dpi: 144 },
    ]);
    expect(displays.map((d) => d.bounds)).toEqual([
      { x: 0, y: 0, width: 1920, height: 1200 },
      { x: -1920, y: 200, width: 1920, height: 1200 },
      { x: 0, y: -1200, width: 1920, height: 1200 },
    ]);
    expect(displays.map((d) => d.primary)).toEqual([true, false, false]);
  });

  it('keeps mixed-DPI monitors touching (aligned starts, aligned ends, overlap anchor)', () => {
    const displays = displaysFromWin32Monitors(mixed);
    expect(displays[1]!.bounds).toEqual({ x: 0, y: 0, width: 2048, height: 1152 });
    expect(displays[0]!.bounds).toEqual({ x: -1920, y: -120, width: 1920, height: 1200 });
    expect(displays[2]!.bounds).toEqual({ x: 2048, y: -100, width: 1920, height: 1080 });
    expect(displays[1]!.workArea.height).toBeCloseTo(1113.6, 9);
    for (const d of displays) expect(distanceBetweenRects(d.bounds, displays[1]!.bounds)).toBe(0);
    const bottomAligned = displaysFromWin32Monitors([
      { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1440 }, dpi: 120 },
      { bounds: { x: -1920, y: 360, width: 1920, height: 1080 }, workArea: { x: -1920, y: 360, width: 1920, height: 1080 }, dpi: 96 },
    ]);
    const a = bottomAligned[0]!.bounds;
    const b = bottomAligned[1]!.bounds;
    expect(b.y + b.height).toBe(a.y + a.height);
    expect(b.x + b.width).toBe(a.x);
  });

  it('does not depend on the order in which monitors are listed', () => {
    const reference = displaysFromWin32Monitors(mixed);
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
      [2, 0, 1],
    ];
    for (const order of orders) {
      const displays = displaysFromWin32Monitors(order.map((i) => mixed[i]!));
      order.forEach((original, position) => expect(displays[position]!.bounds).toEqual(reference[original]!.bounds));
    }
  });

  it('chooses the primary by flag, else the monitor at (0, 0), else the first', () => {
    const unflagged = mixed.map(({ primary: _p, ...m }) => m);
    expect(displaysFromWin32Monitors(unflagged).map((d) => d.primary)).toEqual([false, true, false]);
    const nowhere = [{ bounds: { x: 100, y: 100, width: 800, height: 600 }, workArea: { x: 100, y: 100, width: 800, height: 600 }, dpi: 96 }];
    expect(displaysFromWin32Monitors(nowhere)[0]).toMatchObject({ primary: true, bounds: { x: 100, y: 100 } });
    expect(displaysFromWin32Monitors([])).toEqual([]);
  });

  it('places disconnected monitors relative to the nearest placed one and tolerates invalid DPI', () => {
    const displays = displaysFromWin32Monitors([
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, dpi: 192 },
      { bounds: { x: 4000, y: 0, width: 1000, height: 1000 }, workArea: { x: 4000, y: 0, width: 1000, height: 1000 }, dpi: 0 },
    ]);
    expect(displays[1]!.bounds).toEqual({ x: 2000, y: 0, width: 1000, height: 1000 });
    expect(displays[1]!.scaleFactor).toBe(1);
    expect(scaleFactorForDpi(Number.NaN)).toBe(1);
    expect(scaleFactorForDpi(144)).toBe(1.5);
  });

  it('round-trips physical ↔ DIP for points on every monitor and resolves shared edges to the right/lower monitor', () => {
    const displays = displaysFromWin32Monitors(mixed);
    const random = rng(7);
    for (let i = 0; i < 300; i += 1) {
      const m = mixed[i % mixed.length]!;
      const p = { x: Math.floor(m.bounds.x + random() * m.bounds.width), y: Math.floor(m.bounds.y + random() * m.bounds.height) };
      const dip = physicalToDipPoint(p, displays)!;
      expect(dip.displayIndex).toBe(i % mixed.length);
      const back = dipToPhysicalPoint(dip.value, displays)!;
      expect(back.displayIndex).toBe(dip.displayIndex);
      expect(back.value.x).toBeCloseTo(p.x, 9);
      expect(back.value.y).toBeCloseTo(p.y, 9);
    }
    expect(physicalToDipPoint({ x: 0, y: 10 }, displays)!.displayIndex).toBe(1);
    expect(physicalToDipPoint({ x: -1, y: 10 }, displays)!.displayIndex).toBe(0);
    expect(physicalToDipPoint({ x: 2560, y: 10 }, displays)!.value).toEqual({ x: 2048, y: 5 });
    expect(physicalToDipPoint({ x: 0, y: 0 }, [])).toBeNull();
    expect(dipToPhysicalPoint({ x: 0, y: 0 }, [])).toBeNull();
  });

  it('converts rectangles with the monitor they overlap most, with optional pixel rounding', () => {
    const displays = displaysFromWin32Monitors(mixed);
    const physical = { x: 2600, y: 0, width: 400, height: 200 };
    const dip = physicalToDipRect(physical, displays)!;
    expect(dip).toEqual({ value: { x: 2068, y: 0, width: 200, height: 100 }, displayIndex: 2 });
    expect(physicalRectToDipOn(displays[2]!, physical)).toEqual(dip.value);
    expect(dipToPhysicalRect(dip.value, displays)!.value).toEqual(physical);
    const fractional = { x: 10.1, y: 20.3, width: 100, height: 50 };
    expect(dipRectToPhysicalOn(displays[1]!, fractional, 'enclosing')).toEqual({ x: 12, y: 25, width: 126, height: 63 });
    expect(dipRectToPhysicalOn(displays[1]!, fractional, 'nearest')).toEqual({ x: 13, y: 25, width: 125, height: 63 });
    expect(physicalPointToDipOn(displays[1]!, dipPointToPhysicalOn(displays[1]!, { x: 10.1, y: 20.3 })).x).toBeCloseTo(10.1, 12);
    expect(physicalToDipRect(physical, [])).toBeNull();
  });

  it('computes the virtual screen and converts to and from its origin', () => {
    const vs = virtualScreenBounds(mixed)!;
    expect(vs).toEqual({ x: -1920, y: -200, width: 8320, height: 2160 });
    expect(screenToVirtualScreenOffset({ x: -1920, y: -200 }, vs)).toEqual({ x: 0, y: 0 });
    expect(virtualScreenOffsetToScreen({ x: 1920, y: 200 }, vs)).toEqual({ x: 0, y: 0 });
    expect(virtualScreenBounds([])).toBeNull();
  });
});
