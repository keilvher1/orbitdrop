import { GlobalFonts, createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type { AnnotationShape } from '@orbitdrop/contracts';
import {
  ANNOTATION_FONT_CANDIDATES,
  ANNOTATION_LINE_HEIGHT,
  annotationBounds,
  annotationFont,
  annotationFontFamilyCss,
  arrowGeometry,
  drawAnnotations,
  type Annotation2DContext,
} from '../src';

// Both canvas implementations must satisfy the shared drawing surface (compile-time check).
const browserCtx = null as unknown as CanvasRenderingContext2D;
const napiCtx = null as unknown as SKRSContext2D;
const surfaces: Annotation2DContext[] = [browserCtx, napiCtx];
void surfaces;

const family = ANNOTATION_FONT_CANDIDATES.find((f) => GlobalFonts.has(f)) ?? null;
const fontFamily = annotationFontFamilyCss(family);

function render(width: number, height: number, shapes: AnnotationShape[], scale = 1): { ctx: SKRSContext2D; alpha: (x: number, y: number) => number; rgba: (x: number, y: number) => number[] } {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  drawAnnotations(ctx, shapes, { scale, fontFamily });
  const data = ctx.getImageData(0, 0, width, height).data;
  return {
    ctx,
    alpha: (x, y) => data[(y * width + x) * 4 + 3]!,
    rgba: (x, y) => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4)),
  };
}

function inkBox(width: number, height: number, alpha: (x: number, y: number) => number): { minX: number; minY: number; maxX: number; maxY: number; count: number } {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alpha(x, y) > 0) {
        count += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { minX, minY, maxX, maxY, count };
}

describe('drawAnnotations', () => {
  it('draws rect outlines centred on the edge, scaled', () => {
    const shape: AnnotationShape = { id: 'r', type: 'rect', x: 10, y: 10, width: 50, height: 30, color: '#FF0000', strokeWidth: 4 };
    const r = render(100, 100, [shape]);
    expect(r.rgba(10, 25)).toEqual([255, 0, 0, 255]);
    expect(r.rgba(60, 25)).toEqual([255, 0, 0, 255]);
    expect(r.rgba(35, 10)).toEqual([255, 0, 0, 255]);
    expect(r.alpha(35, 25)).toBe(0); // outline only
    expect(r.alpha(5, 5)).toBe(0);
    expect(r.alpha(13, 25)).toBe(0); // stroke 4 → covers x 8..12
    const s = render(200, 200, [shape], 2);
    expect(s.rgba(20, 50)).toEqual([255, 0, 0, 255]);
    expect(s.rgba(120, 50)).toEqual([255, 0, 0, 255]);
    expect(s.alpha(26, 50)).toBe(0); // stroke 8 → covers x 16..24
  });

  it('draws arrows with a filled head sized from the stroke width and the tip on the end point', () => {
    const shape: AnnotationShape = { id: 'a', type: 'arrow', x1: 10, y1: 50, x2: 90, y2: 50, color: '#0000FF', strokeWidth: 4 };
    const g = arrowGeometry(10, 50, 90, 50, 4, 1)!;
    expect(g.headLength).toBe(16);
    expect(g.headHalfWidth).toBe(8);
    expect(g.tip).toEqual({ x: 90, y: 50 });
    const r = render(100, 100, [shape]);
    expect(r.rgba(40, 50)).toEqual([0, 0, 255, 255]); // shaft
    expect(r.alpha(40, 53)).toBe(0); // shaft is 4 px wide
    expect(r.alpha(76, 54)).toBe(255); // head is 16 px wide at its base (x = 74), well beyond the shaft
    expect(r.alpha(86, 50)).toBe(255); // filled up to the tip…
    expect(r.alpha(89, 50)).toBeGreaterThan(0); // …which is antialiased at x = 90
    expect(r.alpha(93, 50)).toBe(0); // nothing beyond the tip
    expect(r.alpha(5, 50)).toBe(0); // round tail cap reaches 2 px only
    expect(r.alpha(9, 50)).toBeGreaterThan(0);
    // short arrows shrink their head, zero-length arrows draw nothing
    expect(arrowGeometry(0, 0, 10, 0, 10, 1)!.headLength).toBeCloseTo(6, 10);
    expect(arrowGeometry(5, 5, 5, 5, 3, 1)).toBeNull();
    const none = render(20, 20, [{ id: 'z', type: 'arrow', x1: 5, y1: 5, x2: 5, y2: 5, color: '#000000', strokeWidth: 3 }]);
    expect(inkBox(20, 20, none.alpha).count).toBe(0);
  });

  it('renders Korean text top-left anchored with multi-line advance and bold', () => {
    expect(family).not.toBeNull();
    const text: AnnotationShape = { id: 't', type: 'text', x: 20, y: 30, text: '한글\n테스트', color: '#000000', fontSize: 40, bold: true };
    const r = render(400, 200, [text]);
    const box = inkBox(400, 200, r.alpha);
    expect(box.count).toBeGreaterThan(500);
    expect(box.minX).toBeGreaterThanOrEqual(18);
    expect(box.minX).toBeLessThanOrEqual(30);
    expect(box.minY).toBeGreaterThanOrEqual(26);
    expect(box.minY).toBeLessThanOrEqual(40);
    // second line starts one line advance (1.25 × 40 = 50 px) lower
    const firstLine = inkBox(400, 200, (x, y) => (y < 30 + 40 * ANNOTATION_LINE_HEIGHT ? r.alpha(x, y) : 0));
    const secondLine = inkBox(400, 200, (x, y) => (y >= 30 + 40 * ANNOTATION_LINE_HEIGHT ? r.alpha(x, y) : 0));
    expect(firstLine.count).toBeGreaterThan(200);
    expect(secondLine.count).toBeGreaterThan(200);
    expect(secondLine.minY - firstLine.minY).toBeGreaterThanOrEqual(45);
    expect(secondLine.minY - firstLine.minY).toBeLessThanOrEqual(55);
    // Distinct Hangul syllables give distinct glyph shapes (not identical "tofu" boxes).
    const ga = render(80, 80, [{ id: 'g1', type: 'text', x: 10, y: 10, text: '한', color: '#000000', fontSize: 48, bold: false }]);
    const geul = render(80, 80, [{ id: 'g2', type: 'text', x: 10, y: 10, text: '글', color: '#000000', fontSize: 48, bold: false }]);
    let differing = 0;
    for (let y = 0; y < 80; y += 1) for (let x = 0; x < 80; x += 1) if ((ga.alpha(x, y) > 128) !== (geul.alpha(x, y) > 128)) differing += 1;
    expect(differing).toBeGreaterThan(150);
    // bold has more ink than regular
    const regular = render(400, 200, [{ ...text, bold: false } as AnnotationShape]);
    expect(box.count).toBeGreaterThan(inkBox(400, 200, regular.alpha).count);
  });

  it('font helpers produce CSS the canvas accepts', () => {
    expect(annotationFont(20, true, 1.5, '"A B", sans-serif')).toBe('bold 30px "A B", sans-serif');
    expect(annotationFont(20, false, 1, 'x')).toBe('20px x');
    expect(annotationFontFamilyCss('Malgun Gothic').startsWith('"Malgun Gothic", "Apple SD Gothic Neo"')).toBe(true);
    expect(annotationFontFamilyCss(null).endsWith('sans-serif')).toBe(true);
  });

  it('annotationBounds contains every painted pixel', () => {
    const shapes: AnnotationShape[] = [
      { id: 'r', type: 'rect', x: 40, y: 40, width: 100, height: 60, color: '#FF0000', strokeWidth: 12 },
      { id: 'a', type: 'arrow', x1: 300, y1: 200, x2: 180, y2: 60, color: '#00AA00', strokeWidth: 9 },
      { id: 't', type: 'text', x: 60, y: 220, text: '주석 Annotation\n둘째 줄', color: '#0000FF', fontSize: 30, bold: true },
    ];
    for (const scale of [1, 0.5]) {
      const w = 420 * scale;
      const h = 340 * scale;
      const r = render(w, h, shapes, scale);
      const ink = inkBox(w, h, r.alpha);
      const b = annotationBounds(shapes, { scale, fontFamily }, r.ctx)!;
      expect(ink.minX).toBeGreaterThanOrEqual(b.x);
      expect(ink.minY).toBeGreaterThanOrEqual(b.y);
      expect(ink.maxX).toBeLessThan(b.x + b.width);
      expect(ink.maxY).toBeLessThan(b.y + b.height);
    }
    expect(annotationBounds([], { scale: 1, fontFamily })).toBeNull();
  });

  it('rejects a non-positive scale', () => {
    const ctx = createCanvas(4, 4).getContext('2d');
    expect(() => drawAnnotations(ctx, [], { scale: 0, fontFamily })).toThrow(RangeError);
  });
});
