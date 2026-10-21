import type { AnnotationShape } from '@orbitdrop/contracts';
import { ANNOTATION_LINE_HEIGHT, annotationBounds, annotationFont, annotationTextLines, arrowGeometry, type Annotation2DContext } from '@orbitdrop/core';
import { sourcePerView, viewToSource, type Point, type Rect, type Size, type ViewMapping } from '../crop/cropMath';

/**
 * Annotate editor model. Pure functions, no React.
 *
 * Shapes are stored exactly as AnnotateOptions expects them: integer pixels of
 * the ORIENTED source image (EXIF orientation applied). The editor canvas is a
 * scaled view of that image (`ViewMapping`); pointer positions are converted
 * with `viewToSource`. Stroke width and font size are picked in on-screen
 * (view) pixels and stored in source pixels (`round(ui × sourcePerView)`), so
 * the saved image looks like the preview at any image size.
 */

export type AnnotationTool = 'select' | 'text' | 'arrow' | 'rect';
export const ANNOTATION_TOOLS: readonly AnnotationTool[] = ['select', 'text', 'arrow', 'rect'];

/** Limits from AnnotationShapeSchema / AnnotateOptionsSchema (contracts/options.ts). */
export const ANNOTATION_LIMITS = {
  strokeWidth: { min: 1, max: 400 },
  fontSize: { min: 6, max: 2000 },
  coord: 100_000,
  textLength: 2000,
  maxShapes: 500,
} as const;

export const SHAPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ------------------------------------------------------------------ history

export interface History<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
}

/** Undo steps kept; older ones are dropped. */
export const HISTORY_LIMIT = 100;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** New undo step. A new step always clears the redo stack. Committing the same value is a no-op. */
export function commitHistory<T>(history: History<T>, next: T, limit: number = HISTORY_LIMIT): History<T> {
  if (Object.is(next, history.present)) return history;
  const past = [...history.past, history.present];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, present: next, future: [] };
}

/** Change the present without a new undo step (coalesces a slider drag or repeated nudges into one step). */
export function replacePresent<T>(history: History<T>, next: T): History<T> {
  if (Object.is(next, history.present)) return history;
  return { past: history.past, present: next, future: [] };
}

export function undo<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1] as T;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future as [T, ...T[]];
  return { past: [...history.past, history.present], present: next, future: rest };
}

export function canUndo(history: History<unknown>): boolean {
  return history.past.length > 0;
}

export function canRedo(history: History<unknown>): boolean {
  return history.future.length > 0;
}

// ---------------------------------------------------------------------- ids

let idCounter = 0;

/** Opaque id matching the contracts Id pattern (letters and digits only). */
export function newShapeId(prefix = 'a'): string {
  idCounter = (idCounter + 1) % 0x7fffffff;
  const random = Math.floor(Math.random() * 0x7fffffff).toString(36);
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${random}`.slice(0, 64);
}

// -------------------------------------------------------------------- units

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** On-screen stroke width → stored source px (clamped to the schema). */
export function strokeToSource(ui: number, m: ViewMapping): number {
  return clamp(Math.round(ui * sourcePerView(m)), ANNOTATION_LIMITS.strokeWidth.min, ANNOTATION_LIMITS.strokeWidth.max);
}

/** On-screen font size → stored source px (clamped to the schema). */
export function fontSizeToSource(ui: number, m: ViewMapping): number {
  return clamp(Math.round(ui * sourcePerView(m)), ANNOTATION_LIMITS.fontSize.min, ANNOTATION_LIMITS.fontSize.max);
}

/** Stored source px → on-screen px. */
export function sourceToUi(value: number, m: ViewMapping): number {
  return value / sourcePerView(m);
}

function clampCoord(value: number): number {
  return clamp(Math.round(value), -ANNOTATION_LIMITS.coord, ANNOTATION_LIMITS.coord);
}

function clampToImage(p: Point, source: Size): Point {
  return { x: clamp(p.x, 0, source.width), y: clamp(p.y, 0, source.height) };
}

/** Style in source px. */
export interface ShapeStyle {
  readonly color: string;
  readonly strokeWidth: number;
  readonly fontSize: number;
}

// ----------------------------------------------------------------- creation

/** Rectangle from a drag in view coordinates (clamped to the image, at least 1×1 source px). */
export function rectFromDrag(startView: Point, endView: Point, m: ViewMapping, style: ShapeStyle, id: string = newShapeId('r')): AnnotationShape {
  const a = clampToImage(viewToSource(startView, m), m.source);
  const b = clampToImage(viewToSource(endView, m), m.source);
  const x0 = Math.round(Math.min(a.x, b.x));
  const y0 = Math.round(Math.min(a.y, b.y));
  const x1 = Math.round(Math.max(a.x, b.x));
  const y1 = Math.round(Math.max(a.y, b.y));
  return {
    id,
    type: 'rect',
    x: x0,
    y: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
    color: style.color,
    strokeWidth: clamp(Math.round(style.strokeWidth), ANNOTATION_LIMITS.strokeWidth.min, ANNOTATION_LIMITS.strokeWidth.max),
  };
}

/** Arrow from the drag start (tail) to the drag end (tip); null when it has no length in source px. */
export function arrowFromDrag(startView: Point, endView: Point, m: ViewMapping, style: ShapeStyle, id: string = newShapeId('w')): AnnotationShape | null {
  const a = clampToImage(viewToSource(startView, m), m.source);
  const b = clampToImage(viewToSource(endView, m), m.source);
  const x1 = Math.round(a.x);
  const y1 = Math.round(a.y);
  const x2 = Math.round(b.x);
  const y2 = Math.round(b.y);
  if (x1 === x2 && y1 === y2) return null;
  return {
    id,
    type: 'arrow',
    x1,
    y1,
    x2,
    y2,
    color: style.color,
    strokeWidth: clamp(Math.round(style.strokeWidth), ANNOTATION_LIMITS.strokeWidth.min, ANNOTATION_LIMITS.strokeWidth.max),
  };
}

/** Normalise typed text: unify newlines, drop trailing whitespace, cap the length. '' means "no text". */
export function normalizeText(text: string): string {
  const unified = text.replace(/\r\n?/g, '\n').replace(/\s+$/u, '');
  if (unified.trim().length === 0) return '';
  return [...unified].slice(0, ANNOTATION_LIMITS.textLength).join('');
}

/** Text whose top-left corner is at the clicked view point; null for empty text. */
export function textShapeAt(view: Point, text: string, m: ViewMapping, style: ShapeStyle, id: string = newShapeId('t')): AnnotationShape | null {
  const value = normalizeText(text);
  if (value === '') return null;
  const p = clampToImage(viewToSource(view, m), m.source);
  return {
    id,
    type: 'text',
    x: Math.round(p.x),
    y: Math.round(p.y),
    text: value,
    color: style.color,
    fontSize: clamp(Math.round(style.fontSize), ANNOTATION_LIMITS.fontSize.min, ANNOTATION_LIMITS.fontSize.max),
    bold: true,
  };
}

// ----------------------------------------------------------- modification

/** Translate a shape by a source-px delta (rounded to whole pixels). */
export function moveShape(shape: AnnotationShape, dx: number, dy: number): AnnotationShape {
  const rx = Math.round(dx);
  const ry = Math.round(dy);
  if (rx === 0 && ry === 0) return shape;
  switch (shape.type) {
    case 'rect':
    case 'text':
      return { ...shape, x: clampCoord(shape.x + rx), y: clampCoord(shape.y + ry) };
    case 'arrow':
      return { ...shape, x1: clampCoord(shape.x1 + rx), y1: clampCoord(shape.y1 + ry), x2: clampCoord(shape.x2 + rx), y2: clampCoord(shape.y2 + ry) };
    default:
      return shape;
  }
}

/** Apply style fields that make sense for the shape type (colour for all, stroke for rect/arrow, font size for text). */
export function withStyle(shape: AnnotationShape, style: Partial<ShapeStyle>): AnnotationShape {
  let next: AnnotationShape = shape;
  if (style.color !== undefined && style.color !== shape.color) next = { ...next, color: style.color };
  if (style.strokeWidth !== undefined && next.type !== 'text') {
    const strokeWidth = clamp(Math.round(style.strokeWidth), ANNOTATION_LIMITS.strokeWidth.min, ANNOTATION_LIMITS.strokeWidth.max);
    if (strokeWidth !== next.strokeWidth) next = { ...next, strokeWidth };
  }
  if (style.fontSize !== undefined && next.type === 'text') {
    const fontSize = clamp(Math.round(style.fontSize), ANNOTATION_LIMITS.fontSize.min, ANNOTATION_LIMITS.fontSize.max);
    if (fontSize !== next.fontSize) next = { ...next, fontSize };
  }
  return next;
}

/** Append a shape (ignored once the schema maximum of 500 shapes is reached). */
export function addShape(shapes: readonly AnnotationShape[], shape: AnnotationShape): readonly AnnotationShape[] {
  if (shapes.length >= ANNOTATION_LIMITS.maxShapes) return shapes;
  return [...shapes, shape];
}

/** Replace the shape with the same id via `update`; returns the same array when nothing changed. */
export function updateShape(
  shapes: readonly AnnotationShape[],
  id: string,
  update: (shape: AnnotationShape) => AnnotationShape,
): readonly AnnotationShape[] {
  let changed = false;
  const next = shapes.map((shape) => {
    if (shape.id !== id) return shape;
    const updated = update(shape);
    if (updated !== shape) changed = true;
    return updated;
  });
  return changed ? next : shapes;
}

export function removeShape(shapes: readonly AnnotationShape[], id: string): readonly AnnotationShape[] {
  const next = shapes.filter((shape) => shape.id !== id);
  return next.length === shapes.length ? shapes : next;
}

// ------------------------------------------------------- bounds & hit tests

/** Measuring context (a 2D canvas context): same surface the core uses. */
export type TextMeasurer = Pick<Annotation2DContext, 'font' | 'measureText'>;

/** Rough advance width of a line in em (bold system font) when no canvas is available. */
export function estimateLineEm(line: string): number {
  let em = 0;
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x3040 && code <= 0x9fff) || (code >= 0x1100 && code <= 0x11ff)) em += 1;
    else if (ch === ' ') em += 0.3;
    else em += 0.62;
  }
  return em;
}

/** Tight box of a text shape in source px (advance widths, line advance × line count). */
export function textBox(shape: Extract<AnnotationShape, { type: 'text' }>, fontFamily: string, measurer?: TextMeasurer): Rect {
  const lines = annotationTextLines(shape.text);
  let width = 0;
  if (measurer) {
    const previous = measurer.font;
    measurer.font = annotationFont(shape.fontSize, shape.bold, 1, fontFamily);
    for (const line of lines) width = Math.max(width, measurer.measureText(line).width);
    measurer.font = previous;
  } else {
    for (const line of lines) width = Math.max(width, estimateLineEm(line) * shape.fontSize);
  }
  const height = ((lines.length - 1) * ANNOTATION_LINE_HEIGHT + 1) * shape.fontSize;
  return { x: shape.x, y: shape.y, width: Math.max(1, width), height };
}

/** Everything the shape paints (stroke, arrow head, glyph overhang), in source px. Used for the selection outline. */
export function shapeBounds(shape: AnnotationShape, fontFamily: string, measurer?: TextMeasurer): Rect | null {
  return annotationBounds([shape], { scale: 1, fontFamily }, measurer);
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Whether a source-px point hits the shape. Rect: inside or within
 * `tolerance` of the outline (half the stroke counts as outline). Arrow: within
 * `tolerance` of the shaft, or of the head near the tip. Text: inside its box
 * grown by `tolerance`.
 */
export function hitTestShape(shape: AnnotationShape, p: Point, tolerance: number, fontFamily: string, measurer?: TextMeasurer): boolean {
  switch (shape.type) {
    case 'rect': {
      const grow = tolerance + shape.strokeWidth / 2;
      return p.x >= shape.x - grow && p.x <= shape.x + shape.width + grow && p.y >= shape.y - grow && p.y <= shape.y + shape.height + grow;
    }
    case 'arrow': {
      const a = { x: shape.x1, y: shape.y1 };
      const b = { x: shape.x2, y: shape.y2 };
      if (distanceToSegment(p, a, b) <= tolerance + shape.strokeWidth / 2) return true;
      const head = arrowGeometry(shape.x1, shape.y1, shape.x2, shape.y2, shape.strokeWidth, 1);
      if (head === null) return false;
      return Math.hypot(p.x - b.x, p.y - b.y) <= head.headLength + tolerance && distanceToSegment(p, a, b) <= head.headHalfWidth + tolerance;
    }
    case 'text': {
      const box = textBox(shape, fontFamily, measurer);
      return p.x >= box.x - tolerance && p.x <= box.x + box.width + tolerance && p.y >= box.y - tolerance && p.y <= box.y + box.height + tolerance;
    }
    default:
      return false;
  }
}

/** Topmost shape (drawn last) under the point, or null. */
export function hitTestShapes(
  shapes: readonly AnnotationShape[],
  p: Point,
  tolerance: number,
  fontFamily: string,
  measurer?: TextMeasurer,
): AnnotationShape | null {
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    const shape = shapes[i];
    if (shape !== undefined && hitTestShape(shape, p, tolerance, fontFamily, measurer)) return shape;
  }
  return null;
}
