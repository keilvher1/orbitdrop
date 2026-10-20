import type { AnnotationShape } from '@orbitdrop/contracts';

/**
 * Minimal 2D context surface shared by the browser CanvasRenderingContext2D and
 * @napi-rs/canvas, so the editor preview and the final render use one drawing
 * routine. Stub with the final signature; implemented by processors-edit.
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

export function drawAnnotations(_ctx: Annotation2DContext, _shapes: readonly AnnotationShape[], _options: DrawAnnotationsOptions): void {
  throw new Error('drawAnnotations not implemented yet');
}
