import { describe, expect, it } from 'vitest';
import { OUTPUT_RATIOS, type CompositionLayout, type OutputRatio } from '@orbitdrop/contracts';
import {
  MIN_CONTENT_FRACTION,
  computeCompositionLayout,
  computeCompositionLayoutDetails,
  previewScaleFor,
  ratioParts,
  scaleCompositionLayout,
  shadowFromSlider,
} from '../src';

const spec = (over: Partial<{ padding: number; cornerRadius: number; shadow: number; ratio: OutputRatio; maxEdge: number }> = {}) => ({
  padding: 0,
  cornerRadius: 0,
  shadow: 0,
  ratio: 'auto' as OutputRatio,
  maxEdge: 2400,
  ...over,
});

/** Invariants every layout must satisfy. */
function checkInvariants(l: CompositionLayout, w0: number, h0: number, maxEdge: number, ratio: OutputRatio): void {
  const { canvas, content, margins } = l;
  for (const v of [canvas.width, canvas.height, content.x, content.y, content.width, content.height]) expect(Number.isInteger(v)).toBe(true);
  expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(maxEdge);
  // never upscaled
  expect(content.width).toBeLessThanOrEqual(w0);
  expect(content.height).toBeLessThanOrEqual(h0);
  expect(l.contentScale).toBeLessThanOrEqual(1);
  // aspect preserved to within one pixel
  expect(Math.abs(content.width - (content.height * w0) / h0)).toBeLessThanOrEqual(1 + w0 / h0);
  // inside the canvas, centred (odd remainder to the right/bottom)
  expect(margins.left + content.width + margins.right).toBe(canvas.width);
  expect(margins.top + content.height + margins.bottom).toBe(canvas.height);
  expect(margins.left).toBe(content.x);
  expect(margins.top).toBe(content.y);
  expect(margins.right - margins.left).toBeGreaterThanOrEqual(0);
  expect(margins.right - margins.left).toBeLessThanOrEqual(1);
  expect(margins.bottom - margins.top).toBeGreaterThanOrEqual(0);
  expect(margins.bottom - margins.top).toBeLessThanOrEqual(1);
  // corner radius ≤ half the short side
  expect(l.cornerRadius).toBeLessThanOrEqual(Math.min(content.width, content.height) / 2);
  // shadow fits in the margins (never clipped)
  if (l.shadow) {
    expect(margins.top).toBeGreaterThanOrEqual(l.shadow.extent.top);
    expect(margins.bottom).toBeGreaterThanOrEqual(l.shadow.extent.bottom);
    expect(margins.left).toBeGreaterThanOrEqual(l.shadow.extent.left);
    expect(margins.right).toBeGreaterThanOrEqual(l.shadow.extent.right);
  }
  const parts = ratioParts(ratio);
  if (parts) {
    const [a, b] = parts;
    // exact ratio to within half a pixel on the derived side
    expect(Math.abs(canvas.width * b - canvas.height * a) / Math.max(a, b)).toBeLessThanOrEqual(0.5 + 1e-9);
  }
}

describe('computeCompositionLayout', () => {
  it('auto: canvas = content + padding on every side, image untouched', () => {
    const l = computeCompositionLayout(1000, 500, spec({ padding: 100 }));
    expect(l.canvas).toEqual({ width: 1200, height: 700 });
    expect(l.content).toEqual({ x: 100, y: 100, width: 1000, height: 500 });
    expect(l.contentScale).toBe(1);
    expect(l.margins).toEqual({ top: 100, right: 100, bottom: 100, left: 100 });
    expect(l.shadow).toBeNull();
    expect(l.paddingExpandedByRatio).toBe(false);
    expect(l.paddingExpandedByShadow).toBe(false);
  });

  it('never upscales a small image (canvas stays small)', () => {
    const l = computeCompositionLayout(50, 40, spec({ padding: 10, ratio: 'auto' }));
    expect(l.canvas).toEqual({ width: 70, height: 60 });
    expect(l.content).toEqual({ x: 10, y: 10, width: 50, height: 40 });
    expect(l.contentScale).toBe(1);
  });

  it('maxEdge caps the canvas while padding stays in output pixels', () => {
    const l = computeCompositionLayout(3000, 2000, spec({ padding: 100, maxEdge: 2400 }));
    expect(l.canvas.width).toBe(2400);
    expect(l.content.width).toBe(2200);
    expect(l.content.height).toBe(1466);
    expect(l.canvas.height).toBe(1666);
    expect(l.margins.left).toBe(100);
    expect(l.margins.top).toBe(100);
    expect(l.contentScale).toBeCloseTo(2200 / 3000, 10);
    // the reference recording: 2550² crop, padding 609 → content shrinks to 1182
    const ref = computeCompositionLayout(2550, 2550, spec({ padding: 609, cornerRadius: 184, shadow: 24 }));
    expect(ref.canvas).toEqual({ width: 2400, height: 2400 });
    expect(ref.content).toEqual({ x: 609, y: 609, width: 1182, height: 1182 });
    expect(ref.cornerRadius).toBe(184);
  });

  it('1:1 contains content + padding and grows the short direction', () => {
    const l = computeCompositionLayout(1000, 500, spec({ padding: 100, ratio: '1:1' }));
    expect(l.canvas).toEqual({ width: 1200, height: 1200 });
    expect(l.content).toEqual({ x: 100, y: 350, width: 1000, height: 500 });
    expect(l.margins).toEqual({ top: 350, right: 100, bottom: 350, left: 100 });
    expect(l.paddingExpandedByRatio).toBe(true);
    // already square → nothing to expand
    const sq = computeCompositionLayout(800, 800, spec({ padding: 50, ratio: '1:1' }));
    expect(sq.canvas).toEqual({ width: 900, height: 900 });
    expect(sq.paddingExpandedByRatio).toBe(false);
  });

  it('16:9 grows the width of a square image and rounds the derived side', () => {
    const l = computeCompositionLayout(1000, 1000, spec({ padding: 50, ratio: '16:9' }));
    expect(l.canvas).toEqual({ width: 1956, height: 1100 });
    expect(l.content).toEqual({ x: 478, y: 50, width: 1000, height: 1000 });
    expect(l.margins.top).toBe(50);
    expect(l.paddingExpandedByRatio).toBe(true);
    // a very wide image: width-bound at maxEdge, height derived (1350 = 2400·9/16)
    const wide = computeCompositionLayout(4000, 1000, spec({ ratio: '16:9' }));
    expect(wide.canvas).toEqual({ width: 2400, height: 1350 });
    expect(wide.content).toEqual({ x: 0, y: 375, width: 2400, height: 600 });
    expect(wide.contentScale).toBeCloseTo(0.6, 10);
  });

  it('4:5 (portrait): the height is the long edge limited by maxEdge', () => {
    const l = computeCompositionLayout(1000, 500, spec({ padding: 100, ratio: '4:5' }));
    expect(l.canvas).toEqual({ width: 1200, height: 1500 });
    expect(l.content.y).toBe(500);
    expect(l.paddingExpandedByRatio).toBe(true);
    const big = computeCompositionLayout(4000, 5000, spec({ ratio: '4:5' }));
    expect(big.canvas).toEqual({ width: 1920, height: 2400 });
    expect(big.content).toEqual({ x: 0, y: 0, width: 1920, height: 2400 });
    expect(big.paddingExpandedByRatio).toBe(false);
  });

  it('clamps the corner radius to half of the content short side', () => {
    expect(computeCompositionLayout(400, 200, spec({ cornerRadius: 500 })).cornerRadius).toBe(100);
    expect(computeCompositionLayout(401, 201, spec({ cornerRadius: 500 })).cornerRadius).toBe(100);
    expect(computeCompositionLayout(400, 200, spec({ cornerRadius: 30 })).cornerRadius).toBe(30);
    // clamped against the *scaled* content
    const scaled = computeCompositionLayout(4000, 2000, spec({ cornerRadius: 4000, maxEdge: 1000 }));
    expect(scaled.content.height).toBe(500);
    expect(scaled.cornerRadius).toBe(250);
  });

  it('derives shadow parameters from the slider', () => {
    expect(shadowFromSlider(0)).toBeNull();
    const s = shadowFromSlider(40)!;
    expect(s.blurSigma).toBe(10);
    expect(s.offsetY).toBe(10);
    expect(s.opacity).toBeGreaterThan(0);
    expect(s.opacity).toBeLessThan(1);
    expect(s.extent).toEqual({ top: 20, right: 30, bottom: 40, left: 30 });
    const tiny = shadowFromSlider(1)!;
    expect(tiny.extent).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
    const odd = shadowFromSlider(7)!;
    expect(odd.extent).toEqual({ top: 4, right: 6, bottom: 7, left: 6 });
  });

  it('grows margins so the shadow is never clipped and keeps the content centred', () => {
    const l = computeCompositionLayout(400, 300, spec({ padding: 10, shadow: 40 }));
    expect(l.shadow?.extent).toEqual({ top: 20, right: 30, bottom: 40, left: 30 });
    expect(l.margins).toEqual({ top: 40, right: 30, bottom: 40, left: 30 });
    expect(l.canvas).toEqual({ width: 460, height: 380 });
    expect(l.paddingExpandedByShadow).toBe(true);
    const roomy = computeCompositionLayout(400, 300, spec({ padding: 100, shadow: 40 }));
    expect(roomy.margins).toEqual({ top: 100, right: 100, bottom: 100, left: 100 });
    expect(roomy.paddingExpandedByShadow).toBe(false);
  });

  it('reduces padding (and shadow) sensibly when padding alone exceeds maxEdge', () => {
    const d = computeCompositionLayoutDetails(1000, 1000, spec({ padding: 4000, maxEdge: 2400 }));
    expect(d.paddingReducedByMaxEdge).toBe(true);
    expect(d.effectivePadding).toBe(960);
    expect(d.layout.canvas).toEqual({ width: 2400, height: 2400 });
    expect(d.layout.content.width).toBe(Math.round(2400 * MIN_CONTENT_FRACTION));
    checkInvariants(d.layout, 1000, 1000, 2400, 'auto');

    // a small image keeps its natural size; only the padding gives way
    const small = computeCompositionLayoutDetails(100, 100, spec({ padding: 1160, maxEdge: 2400 }));
    expect(small.paddingReducedByMaxEdge).toBe(true);
    expect(small.layout.content.width).toBe(100);
    expect(small.effectivePadding).toBe(1150);
    expect(small.layout.canvas.width).toBe(2400);

    // padding that fits is never reduced even if the content becomes small
    const fits = computeCompositionLayoutDetails(100, 100, spec({ padding: 1150, maxEdge: 2400 }));
    expect(fits.paddingReducedByMaxEdge).toBe(false);
    expect(fits.layout.canvas.width).toBe(2400);

    // shadow larger than the minimum canvas
    const shadowy = computeCompositionLayoutDetails(500, 500, spec({ shadow: 400, maxEdge: 256 }));
    expect(shadowy.paddingReducedByMaxEdge).toBe(true);
    expect(shadowy.effectiveShadow).toBeLessThan(400);
    checkInvariants(shadowy.layout, 500, 500, 256, 'auto');
    expect(shadowy.layout.content.width).toBeGreaterThanOrEqual(Math.floor(256 * MIN_CONTENT_FRACTION) - 1);
  });

  it('holds its invariants for many random inputs', () => {
    let seed = 42;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 3000; i += 1) {
      const w0 = 1 + rand(i % 7 === 0 ? 20000 : 3000);
      const h0 = 1 + rand(i % 11 === 0 ? 20000 : 3000);
      const ratio = OUTPUT_RATIOS[rand(OUTPUT_RATIOS.length)]!;
      const s = spec({ padding: rand(i % 5 === 0 ? 4001 : 300), cornerRadius: rand(800), shadow: rand(i % 3 === 0 ? 401 : 60), ratio, maxEdge: 256 + rand(7745) });
      const d = computeCompositionLayoutDetails(w0, h0, s);
      checkInvariants(d.layout, w0, h0, s.maxEdge, ratio);
      if (!d.paddingReducedByMaxEdge) {
        expect(Math.min(d.layout.margins.left, d.layout.margins.top)).toBeGreaterThanOrEqual(s.padding);
        expect(d.effectivePadding).toBe(s.padding);
      }
      expect(d.layout.content.width).toBeGreaterThanOrEqual(1);
    }
  });

  it('rejects an empty content size', () => {
    expect(() => computeCompositionLayout(0, 10, spec())).toThrow();
    expect(() => computeCompositionLayout(10, Number.NaN, spec())).toThrow();
  });
});

describe('scaleCompositionLayout', () => {
  const final = computeCompositionLayout(2550, 2550, spec({ padding: 609, cornerRadius: 184, shadow: 24 }));

  it('scales every value uniformly for previews', () => {
    const k = previewScaleFor(final, 600);
    expect(k).toBe(0.25);
    const p = scaleCompositionLayout(final, k);
    expect(p.canvas).toEqual({ width: 600, height: 600 });
    expect(p.content).toEqual({ x: 152, y: 152, width: 296, height: 296 });
    expect(p.margins.left + p.content.width + p.margins.right).toBe(600);
    expect(p.cornerRadius).toBeCloseTo(46, 10);
    expect(p.shadow?.blurSigma).toBeCloseTo(1.5, 10);
    expect(p.shadow?.offsetY).toBeCloseTo(1.5, 10);
    expect(p.shadow?.opacity).toBe(final.shadow?.opacity);
    expect(p.contentScale).toBeCloseTo(final.contentScale * 0.25, 10);
    expect(p.paddingExpandedByRatio).toBe(final.paddingExpandedByRatio);
  });

  it('keeps margins + content = canvas for arbitrary k and returns the layout unchanged for k ≥ 1', () => {
    const l = computeCompositionLayout(1333, 777, spec({ padding: 37, ratio: '16:9', shadow: 13, cornerRadius: 50 }));
    for (const k of [0.9, 0.5, 0.333, 0.1, 0.01, 0.0005]) {
      const p = scaleCompositionLayout(l, k);
      expect(p.margins.left + p.content.width + p.margins.right).toBe(p.canvas.width);
      expect(p.margins.top + p.content.height + p.margins.bottom).toBe(p.canvas.height);
      expect(p.content.width).toBeGreaterThanOrEqual(1);
      expect(p.cornerRadius).toBeLessThanOrEqual(Math.min(p.content.width, p.content.height) / 2);
    }
    expect(scaleCompositionLayout(l, 1)).toBe(l);
    expect(scaleCompositionLayout(l, 2)).toBe(l);
    expect(() => scaleCompositionLayout(l, 0)).toThrow();
    expect(previewScaleFor(computeCompositionLayout(100, 100, spec()), 600)).toBe(1);
  });
});
