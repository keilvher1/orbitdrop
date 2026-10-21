import type { AnnotationShape } from '@orbitdrop/contracts';

/**
 * Minimal 2D context surface shared by the browser CanvasRenderingContext2D and
 * @napi-rs/canvas, so the editor preview and the final render use one drawing
 * routine.
 */
export interface Annotation2DContext {
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fill(): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  strokeStyle: unknown;
  fillStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  font: string;
  textBaseline: string;
}

export interface DrawAnnotationsOptions {
  /** Multiply all coordinates and sizes (preview scale = canvas px per source px). */
  readonly scale: number;
  /** CSS font-family list that can render Hangul. */
  readonly fontFamily: string;
}

/**
 * Drawing rules (all values are in oriented source pixels and multiplied by
 * `options.scale`):
 *  - rect: outline only, stroke centred on the rect edge, square (miter) corners.
 *  - arrow: straight shaft from (x1, y1) to (x2, y2) with a round tail cap and a
 *    filled triangular head whose tip is exactly at (x2, y2).
 *    Head length L = max(ARROW_HEAD_LENGTH_PER_STROKE × strokeWidth, ARROW_HEAD_MIN_LENGTH),
 *    head half-width = L × ARROW_HEAD_HALF_WIDTH_RATIO; on arrows shorter than
 *    L / ARROW_HEAD_MAX_SHARE the head shrinks to ARROW_HEAD_MAX_SHARE of the length.
 *    The shaft stops inside the head so the tip stays sharp.
 *  - text: top-left anchored (textBaseline 'top' at (x, y)); lines split on "\n";
 *    line advance = fontSize × ANNOTATION_LINE_HEIGHT; bold when `bold`.
 * Shapes are drawn in array order (later shapes on top).
 */
export const ARROW_HEAD_LENGTH_PER_STROKE = 4;
export const ARROW_HEAD_MIN_LENGTH = 10;
export const ARROW_HEAD_HALF_WIDTH_RATIO = 0.5;
export const ARROW_HEAD_MAX_SHARE = 0.6;
/** The shaft ends this fraction of the head length before the tip (inside the head). */
const ARROW_SHAFT_END = 0.9;
export const ANNOTATION_LINE_HEIGHT = 1.25;

/**
 * Hangul-capable families in order of preference: macOS, Windows, common Linux/Noto
 * installs. The processors pick the first one the canvas backend has; the renderer can
 * use `annotationFontFamilyCss()` directly (Chromium falls back per glyph).
 */
export const ANNOTATION_FONT_CANDIDATES: readonly string[] = [
  'Apple SD Gothic Neo',
  'AppleGothic',
  'Malgun Gothic',
  'Noto Sans CJK KR',
  'Noto Sans KR',
  'NanumGothic',
  'Nanum Gothic',
];

function quoteFamily(name: string): string {
  return /^[A-Za-z-]+$/.test(name) && !['serif', 'sans-serif', 'monospace'].includes(name) ? name : `"${name.replace(/"/g, '')}"`;
}

/** CSS font-family list: the preferred family first, then the candidates, then sans-serif. */
export function annotationFontFamilyCss(preferred?: string | null): string {
  const names = [...(preferred ? [preferred] : []), ...ANNOTATION_FONT_CANDIDATES.filter((n) => n !== preferred)];
  return [...names.map(quoteFamily), 'sans-serif'].join(', ');
}

/** CSS font shorthand for a text shape at a given scale. */
export function annotationFont(fontSize: number, bold: boolean, scale: number, fontFamily: string): string {
  const px = Math.max(0.5, fontSize * scale);
  return `${bold ? 'bold ' : ''}${Number(px.toFixed(3))}px ${fontFamily}`;
}

export function annotationTextLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

export interface ArrowGeometry {
  /** Where the shaft stroke ends (inside the head). */
  readonly shaftEnd: { readonly x: number; readonly y: number };
  readonly tip: { readonly x: number; readonly y: number };
  readonly left: { readonly x: number; readonly y: number };
  readonly right: { readonly x: number; readonly y: number };
  readonly headLength: number;
  readonly headHalfWidth: number;
}

/** Arrow head geometry in output pixels; null for a zero-length arrow. */
export function arrowGeometry(x1: number, y1: number, x2: number, y2: number, strokeWidth: number, scale: number): ArrowGeometry | null {
  const ax = x1 * scale;
  const ay = y1 * scale;
  const bx = x2 * scale;
  const by = y2 * scale;
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (!(length > 1e-6)) return null;
  const ux = dx / length;
  const uy = dy / length;
  let headLength = Math.max(ARROW_HEAD_LENGTH_PER_STROKE * strokeWidth, ARROW_HEAD_MIN_LENGTH) * scale;
  headLength = Math.min(headLength, length * ARROW_HEAD_MAX_SHARE);
  const headHalfWidth = headLength * ARROW_HEAD_HALF_WIDTH_RATIO;
  const baseX = bx - ux * headLength;
  const baseY = by - uy * headLength;
  return {
    shaftEnd: { x: bx - ux * headLength * ARROW_SHAFT_END, y: by - uy * headLength * ARROW_SHAFT_END },
    tip: { x: bx, y: by },
    left: { x: baseX - uy * headHalfWidth, y: baseY + ux * headHalfWidth },
    right: { x: baseX + uy * headHalfWidth, y: baseY - ux * headHalfWidth },
    headLength,
    headHalfWidth,
  };
}

export function drawAnnotations(ctx: Annotation2DContext, shapes: readonly AnnotationShape[], options: DrawAnnotationsOptions): void {
  const s = options.scale;
  if (!(s > 0) || !Number.isFinite(s)) throw new RangeError('drawAnnotations: scale must be a positive number');
  for (const shape of shapes) {
    ctx.save();
    switch (shape.type) {
      case 'rect': {
        ctx.strokeStyle = shape.color;
        ctx.lineWidth = shape.strokeWidth * s;
        ctx.lineJoin = 'miter';
        ctx.strokeRect(shape.x * s, shape.y * s, shape.width * s, shape.height * s);
        break;
      }
      case 'arrow': {
        const g = arrowGeometry(shape.x1, shape.y1, shape.x2, shape.y2, shape.strokeWidth, s);
        if (!g) break;
        ctx.strokeStyle = shape.color;
        ctx.fillStyle = shape.color;
        ctx.lineWidth = shape.strokeWidth * s;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(shape.x1 * s, shape.y1 * s);
        ctx.lineTo(g.shaftEnd.x, g.shaftEnd.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(g.tip.x, g.tip.y);
        ctx.lineTo(g.left.x, g.left.y);
        ctx.lineTo(g.right.x, g.right.y);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'text': {
        ctx.fillStyle = shape.color;
        ctx.font = annotationFont(shape.fontSize, shape.bold, s, options.fontFamily);
        ctx.textBaseline = 'top';
        const advance = shape.fontSize * ANNOTATION_LINE_HEIGHT * s;
        annotationTextLines(shape.text).forEach((line, i) => {
          if (line.length > 0) ctx.fillText(line, shape.x * s, shape.y * s + i * advance);
        });
        break;
      }
    }
    ctx.restore();
  }
}

export interface AnnotationBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Conservative bounding box (output pixels, × scale) of everything
 * `drawAnnotations` paints, including stroke widths, arrow heads and text. Text
 * width is measured with `ctx` when given, else estimated generously. Lets the
 * processors render the overlay only where it is needed. Null for no shapes.
 */
export function annotationBounds(
  shapes: readonly AnnotationShape[],
  options: DrawAnnotationsOptions,
  ctx?: Pick<Annotation2DContext, 'font' | 'measureText'>,
): AnnotationBounds | null {
  const s = options.scale;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const add = (x0: number, y0: number, x1: number, y1: number): void => {
    minX = Math.min(minX, x0, x1);
    minY = Math.min(minY, y0, y1);
    maxX = Math.max(maxX, x0, x1);
    maxY = Math.max(maxY, y0, y1);
  };
  for (const shape of shapes) {
    switch (shape.type) {
      case 'rect': {
        // Miter joins of a centred stroke reach half the stroke width beyond the edge (90° corners).
        const half = (shape.strokeWidth * s) / 2 + 1;
        add(shape.x * s - half, shape.y * s - half, (shape.x + shape.width) * s + half, (shape.y + shape.height) * s + half);
        break;
      }
      case 'arrow': {
        const g = arrowGeometry(shape.x1, shape.y1, shape.x2, shape.y2, shape.strokeWidth, s);
        const half = (shape.strokeWidth * s) / 2 + 1;
        add(shape.x1 * s - half, shape.y1 * s - half, shape.x1 * s + half, shape.y1 * s + half);
        if (g) {
          for (const p of [g.tip, g.left, g.right, g.shaftEnd]) add(p.x - 1, p.y - 1, p.x + half, p.y + half);
          add(g.shaftEnd.x - half, g.shaftEnd.y - half, g.shaftEnd.x + half, g.shaftEnd.y + half);
        }
        break;
      }
      case 'text': {
        const lines = annotationTextLines(shape.text);
        const fontPx = shape.fontSize * s;
        let width = 0;
        if (ctx) {
          const previous = ctx.font;
          ctx.font = annotationFont(shape.fontSize, shape.bold, s, options.fontFamily);
          for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
          ctx.font = previous;
        } else {
          for (const line of lines) width = Math.max(width, [...line].length * fontPx * 1.2);
        }
        // Glyphs (italic overhang, accents, Hangul ascenders) may poke slightly outside the advance box.
        const pad = fontPx * 0.3 + 2;
        const height = ((lines.length - 1) * ANNOTATION_LINE_HEIGHT + 1.3) * fontPx;
        add(shape.x * s - pad, shape.y * s - pad, shape.x * s + width + pad, shape.y * s + height + pad);
        break;
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  const x = Math.floor(minX);
  const y = Math.floor(minY);
  return { x, y, width: Math.ceil(maxX) - x, height: Math.ceil(maxY) - y };
}
