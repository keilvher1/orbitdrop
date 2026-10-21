import { describe, expect, it } from 'vitest';
import {
  applyAspect,
  clampRect,
  editorMapping,
  fitSize,
  initialCropRect,
  maxSizeForRatio,
  moveRect,
  nudgeRect,
  parseDimension,
  rectFromPoints,
  resizeRect,
  setRectDimension,
  sizeLimits,
  sourceRectToView,
  sourceToView,
  viewRectToSource,
  viewToSource,
  type Rect,
  type Size,
} from '../../src/renderer/src/views/editor/crop/cropMath';

const inside = (r: Rect, b: Size) => r.x >= 0 && r.y >= 0 && r.x + r.width <= b.width && r.y + r.height <= b.height;
const integers = (r: Rect) => [r.x, r.y, r.width, r.height].every(Number.isInteger);

describe('preview ↔ oriented source mapping', () => {
  it('maps displayed CSS px to oriented source px and back', () => {
    const m = editorMapping({ width: 4032, height: 3024 }, { width: 464, height: 420 });
    expect(m.view).toEqual({ width: 464, height: 348 });
    expect(viewToSource({ x: 232, y: 174 }, m)).toEqual({ x: 2016, y: 1512 });
    expect(viewToSource({ x: 464, y: 348 }, m)).toEqual({ x: 4032, y: 3024 });
    const back = sourceToView({ x: 1008, y: 756 }, m);
    expect(back.x).toBeCloseTo(116, 9);
    expect(back.y).toBeCloseTo(87, 9);
  });

  it('uses the oriented size for EXIF-rotated photos (stored 4032×3024, orientation 6 → 3024×4032)', () => {
    // Preview bitmap from main is already oriented: 1200×1600.
    const oriented = { width: 3024, height: 4032 };
    const m = editorMapping(oriented, { width: 464, height: 420 });
    expect(m.view).toEqual({ width: 315, height: 420 });
    const centre = viewToSource({ x: 157.5, y: 210 }, m);
    expect(centre.x).toBeCloseTo(1512, 6);
    expect(centre.y).toBeCloseTo(2016, 6);
    // The bottom-right corner of the view is the oriented corner, not the stored one.
    expect(viewToSource({ x: 315, y: 420 }, m)).toEqual({ x: 3024, y: 4032 });
  });

  it('maps the preview bitmap space too (EditorContext.source), independent of display scale / DPR', () => {
    const viaBitmap = viewToSource({ x: 800, y: 600 }, { source: { width: 4032, height: 3024 }, view: { width: 1600, height: 1200 } });
    const viaCss = viewToSource({ x: 232, y: 174 }, { source: { width: 4032, height: 3024 }, view: { width: 464, height: 348 } });
    expect(viaBitmap).toEqual(viaCss);
  });

  it('keeps edges exact when the preview aspect is rounded', () => {
    const m = editorMapping({ width: 4000, height: 3001 }, { width: 464, height: 420 });
    expect(viewRectToSource({ x: 0, y: 0, width: m.view.width, height: m.view.height }, m)).toEqual({ x: 0, y: 0, width: 4000, height: 3001 });
  });

  it('converts view rects to integer source rects inside the image', () => {
    const m = { source: { width: 4032, height: 3024 }, view: { width: 464, height: 348 } };
    const r = viewRectToSource({ x: -10, y: 20.3, width: 600, height: 100.7 }, m);
    expect(integers(r)).toBe(true);
    expect(inside(r, m.source)).toBe(true);
    const v = sourceRectToView({ x: 2016, y: 1512, width: 1008, height: 756 }, m);
    expect(v.x).toBeCloseTo(232, 9);
    expect(v.width).toBeCloseTo(116, 9);
  });

  it('fits content into a box keeping the aspect', () => {
    expect(fitSize({ width: 2550, height: 3300 }, { width: 464, height: 420 })).toEqual({ width: 325, height: 420 });
    expect(fitSize({ width: 100, height: 50 }, { width: 464, height: 420 })).toEqual({ width: 464, height: 232 });
  });
});

describe('rect clamping', () => {
  const b = { width: 4032, height: 3024 };
  it('clamps position and size into the image, rounds to integers, keeps ≥ 1 px', () => {
    expect(clampRect({ x: -50, y: -5, width: 5000, height: 10.6 }, b)).toEqual({ x: 0, y: 0, width: 4032, height: 11 });
    expect(clampRect({ x: 4000, y: 3000, width: 100, height: 100 }, b)).toEqual({ x: 3932, y: 2924, width: 100, height: 100 });
    expect(clampRect({ x: 10, y: 10, width: 0, height: -3 }, b)).toEqual({ x: 10, y: 10, width: 1, height: 1 });
  });
});

describe('aspect presets', () => {
  it('starts with the whole image (free) or the largest centred rect of the ratio', () => {
    expect(initialCropRect('free', { width: 2550, height: 3300 })).toEqual({ x: 0, y: 0, width: 2550, height: 3300 });
    expect(initialCropRect('1:1', { width: 2550, height: 3300 })).toEqual({ x: 0, y: 375, width: 2550, height: 2550 });
    expect(initialCropRect('16:9', { width: 4032, height: 3024 })).toEqual({ x: 0, y: 378, width: 4032, height: 2268 });
    expect(initialCropRect('9:16', { width: 4032, height: 3024 })).toEqual({ x: 1166, y: 0, width: 1701, height: 3024 });
  });

  it('switching the ratio fits it inside the current selection, keeping its centre', () => {
    const b = { width: 4032, height: 3024 };
    expect(applyAspect({ x: 100, y: 200, width: 1000, height: 500 }, '1:1', b)).toEqual({ x: 350, y: 200, width: 500, height: 500 });
    const wide = applyAspect({ x: 0, y: 0, width: 4032, height: 3024 }, '4:3', b);
    expect(wide).toEqual({ x: 0, y: 0, width: 4032, height: 3024 });
    expect(applyAspect({ x: 5, y: 6, width: 70, height: 80 }, 'free', b)).toEqual({ x: 5, y: 6, width: 70, height: 80 });
  });

  it('largest size for a ratio never exceeds the limit after rounding', () => {
    for (const limit of [
      { width: 1001, height: 563 },
      { width: 17, height: 9 },
      { width: 4032, height: 3024 },
      { width: 1, height: 1000 },
    ]) {
      for (const ratio of [1, 16 / 9, 9 / 16, 4 / 3, 3 / 4]) {
        const s = maxSizeForRatio(ratio, limit);
        expect(s.width).toBeLessThanOrEqual(limit.width);
        expect(s.height).toBeLessThanOrEqual(limit.height);
        expect(s.width).toBeGreaterThanOrEqual(1);
        expect(s.height).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe('dragging', () => {
  const b = { width: 1000, height: 800 };
  const start = { x: 100, y: 100, width: 400, height: 300 };

  it('moves and stops at the image edges', () => {
    expect(moveRect(start, 50.4, -20.6, b)).toEqual({ x: 150, y: 79, width: 400, height: 300 });
    expect(moveRect(start, 5000, 5000, b)).toEqual({ x: 600, y: 500, width: 400, height: 300 });
    expect(moveRect(start, -5000, -5000, b)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it('free resize: corners and edges follow the pointer, never cross the opposite edge or leave the image', () => {
    expect(resizeRect(start, 'se', 100, 50, 'free', b)).toEqual({ x: 100, y: 100, width: 500, height: 350 });
    expect(resizeRect(start, 'se', 5000, 5000, 'free', b)).toEqual({ x: 100, y: 100, width: 900, height: 700 });
    expect(resizeRect(start, 'nw', 1000, 1000, 'free', b)).toEqual({ x: 499, y: 399, width: 1, height: 1 });
    expect(resizeRect(start, 'w', -500, 0, 'free', b)).toEqual({ x: 0, y: 100, width: 500, height: 300 });
    expect(resizeRect(start, 'n', 0, -30, 'free', b)).toEqual({ x: 100, y: 70, width: 400, height: 330 });
    expect(resizeRect(start, 'e', 0, 999, 'free', b)).toEqual({ x: 100, y: 100, width: 400, height: 300 });
  });

  it('fixed ratio: corner resize keeps the ratio and the opposite corner, and fits the image', () => {
    const square = { x: 100, y: 100, width: 300, height: 300 };
    expect(resizeRect(square, 'se', 100, 20, '1:1', b)).toEqual({ x: 100, y: 100, width: 400, height: 400 });
    // Shrinking along x only also works (the axis moved further wins).
    expect(resizeRect(square, 'se', -100, 0, '1:1', b)).toEqual({ x: 100, y: 100, width: 200, height: 200 });
    // Past the bottom edge: the largest square that fits from the anchor.
    expect(resizeRect(square, 'se', 2000, 2000, '1:1', b)).toEqual({ x: 100, y: 100, width: 700, height: 700 });
    // NW keeps the bottom-right corner fixed.
    const nw = resizeRect(square, 'nw', -50, -50, '1:1', b);
    expect(nw.x + nw.width).toBe(400);
    expect(nw.y + nw.height).toBe(400);
    expect(nw.width).toBe(350);
    const wide = resizeRect({ x: 0, y: 0, width: 160, height: 90 }, 'se', 160, 0, '16:9', b);
    expect(wide).toEqual({ x: 0, y: 0, width: 320, height: 180 });
  });

  it('fixed ratio: edge resize changes both sides and stays inside the image', () => {
    const r = resizeRect({ x: 100, y: 50, width: 400, height: 300 }, 'e', 200, 0, '4:3', b);
    expect(r.width / r.height).toBeCloseTo(4 / 3, 2);
    expect(r.x).toBe(100);
    expect(inside(r, b)).toBe(true);
    const tall = resizeRect({ x: 100, y: 100, width: 300, height: 400 }, 's', 0, 5000, '3:4', b);
    expect(inside(tall, b)).toBe(true);
    expect(tall.height).toBe(700);
    expect(tall.width).toBe(525);
  });

  it('draws a new selection from an anchor in any direction', () => {
    expect(rectFromPoints({ x: 500, y: 400 }, { x: 300, y: 100 }, 'free', b)).toEqual({ x: 300, y: 100, width: 200, height: 300 });
    expect(rectFromPoints({ x: 500, y: 400 }, { x: 300, y: 350 }, '1:1', b)).toEqual({ x: 300, y: 200, width: 200, height: 200 });
    expect(rectFromPoints({ x: 900, y: 700 }, { x: 5000, y: 5000 }, 'free', b)).toEqual({ x: 900, y: 700, width: 100, height: 100 });
  });

  it('every operation returns integer rects inside the image', () => {
    const ops = [
      resizeRect(start, 'ne', 33.3, -77.7, '16:9', b),
      resizeRect(start, 'sw', -333.3, 777.7, '9:16', b),
      resizeRect(start, 'w', 13.37, 0, '4:3', b),
      rectFromPoints({ x: 10.5, y: 20.2 }, { x: 999.9, y: 0.1 }, '3:4', b),
      moveRect(start, 0.5, 0.5, b),
    ];
    for (const r of ops) {
      expect(integers(r)).toBe(true);
      expect(inside(r, b)).toBe(true);
      expect(r.width).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('W/H fields', () => {
  const b = { width: 4032, height: 2000 };

  it('accepts whole numbers from 1 to the source size', () => {
    expect(parseDimension('2550', 'width', 'free', b)).toEqual({ ok: true, value: 2550 });
    expect(parseDimension(' 1,024 ', 'width', 'free', b)).toEqual({ ok: true, value: 1024 });
    expect(parseDimension('12.5', 'width', 'free', b)).toEqual({ ok: false, error: { kind: 'notInteger' } });
    expect(parseDimension('-3', 'width', 'free', b)).toEqual({ ok: false, error: { kind: 'notInteger' } });
    expect(parseDimension('', 'height', 'free', b)).toEqual({ ok: false, error: { kind: 'notInteger' } });
    expect(parseDimension('0', 'height', 'free', b)).toEqual({ ok: false, error: { kind: 'range', max: 2000 } });
    expect(parseDimension('4033', 'width', 'free', b)).toEqual({ ok: false, error: { kind: 'range', max: 4032 } });
  });

  it('with a fixed ratio, rejects sizes whose other side would not fit (no upscaling)', () => {
    const max = sizeLimits('16:9', b);
    expect(max).toEqual({ width: 3555, height: 2000 });
    expect(parseDimension('4000', 'width', '16:9', b)).toEqual({ ok: false, error: { kind: 'ratio', max: 3555 } });
    expect(parseDimension('3555', 'width', '16:9', b)).toEqual({ ok: true, value: 3555 });
  });

  it('typing W or H updates the selection both ways around its centre', () => {
    const r = { x: 1000, y: 500, width: 800, height: 600 };
    expect(setRectDimension(r, 'width', 1200, 'free', b)).toEqual({ x: 800, y: 500, width: 1200, height: 600 });
    expect(setRectDimension(r, 'width', 1200, '4:3', b)).toEqual({ x: 800, y: 350, width: 1200, height: 900 });
    expect(setRectDimension(r, 'height', 300, '1:1', b)).toEqual({ x: 1250, y: 650, width: 300, height: 300 });
  });

  it('typed sizes never exceed the source and keep the rect inside', () => {
    const r = setRectDimension({ x: 3900, y: 10, width: 100, height: 100 }, 'width', 99999, 'free', b);
    expect(r).toEqual({ x: 0, y: 10, width: 4032, height: 100 });
  });
});

describe('keyboard nudging', () => {
  const b = { width: 1000, height: 800 };
  const r = { x: 100, y: 100, width: 200, height: 100 };
  it('moves by the step and stops at the edges', () => {
    expect(nudgeRect(r, 'ArrowRight', 10, false, 'free', b)).toEqual({ x: 110, y: 100, width: 200, height: 100 });
    expect(nudgeRect(r, 'ArrowUp', 500, false, 'free', b)).toEqual({ x: 100, y: 0, width: 200, height: 100 });
  });

  it('with a portrait ratio (9:16, 3:4), Option/Alt+↓/↑ change the size on every press', () => {
    const big = { width: 400, height: 600 };
    let r = { x: 10, y: 10, width: 90, height: 160 };
    for (let i = 0; i < 10; i += 1) {
      const next = nudgeRect(r, 'ArrowDown', 1, true, '9:16', big);
      expect(next.width).toBeGreaterThan(r.width);
      expect(next.height).toBeGreaterThan(r.height);
      r = next;
    }
    expect(r).toEqual({ x: 10, y: 10, width: 100, height: 178 });
    const shrunk = nudgeRect(r, 'ArrowUp', 1, true, '9:16', big);
    expect(shrunk.width).toBe(99);
    expect(nudgeRect({ x: 10, y: 10, width: 90, height: 120 }, 'ArrowDown', 1, true, '3:4', big)).toEqual({ x: 10, y: 10, width: 91, height: 121 });
    expect(nudgeRect({ x: 10, y: 10, width: 90, height: 120 }, 'ArrowUp', 1, true, '3:4', big)).toEqual({ x: 10, y: 10, width: 89, height: 119 });
    // At the image edge nothing grows past it.
    const edge = { x: 0, y: 0, width: 225, height: 400 };
    expect(nudgeRect(edge, 'ArrowDown', 1, true, '9:16', { width: 225, height: 400 })).toEqual(edge);
  });

  it('resizes the right/bottom edge with the modifier, keeping a fixed ratio', () => {
    expect(nudgeRect(r, 'ArrowRight', 10, true, 'free', b)).toEqual({ x: 100, y: 100, width: 210, height: 100 });
    expect(nudgeRect(r, 'ArrowDown', 10, true, 'free', b)).toEqual({ x: 100, y: 100, width: 200, height: 110 });
    const sq = { x: 100, y: 100, width: 200, height: 200 };
    expect(nudgeRect(sq, 'ArrowRight', 10, true, '1:1', b)).toEqual({ x: 100, y: 100, width: 210, height: 210 });
    expect(nudgeRect(sq, 'ArrowUp', 10, true, '1:1', b)).toEqual({ x: 100, y: 100, width: 190, height: 190 });
  });
});
