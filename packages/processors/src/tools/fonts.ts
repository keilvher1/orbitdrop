import { OrbitError } from '@orbitdrop/contracts';
import { ANNOTATION_FONT_CANDIDATES, annotationFontFamilyCss } from '@orbitdrop/core';

/**
 * @napi-rs/canvas is loaded lazily: if its native binary is missing or broken
 * only Annotate fails (ENGINE_UNAVAILABLE); every other tool keeps working.
 */
export type CanvasModule = typeof import('@napi-rs/canvas');

let canvasModule: Promise<CanvasModule> | null = null;

export function loadCanvas(): Promise<CanvasModule> {
  canvasModule ??= import('@napi-rs/canvas').catch((error: unknown) => {
    canvasModule = null;
    throw new OrbitError('ENGINE_UNAVAILABLE', 'Drawing engine unavailable', { cause: error, detail: error instanceof Error ? error.message.slice(0, 200) : undefined });
  });
  return canvasModule;
}

/**
 * Hangul-capable font for annotation text. @napi-rs/canvas loads the system
 * fonts (macOS: Apple SD Gothic Neo / AppleGothic; Windows: Malgun Gothic).
 * The first installed candidate that really draws Hangul — '한' and '글' both
 * have ink, differ from each other and from the missing-glyph box — is used
 * and put first in the CSS family list.
 */
export interface AnnotationFont {
  /** Family found in the canvas backend, or null if none of the candidates renders Hangul. */
  readonly family: string | null;
  /** CSS font-family list passed to drawAnnotations (preferred family first, sans-serif last). */
  readonly css: string;
}

let resolved: Promise<AnnotationFont> | null = null;

function glyph(canvas: CanvasModule, family: string, text: string): Uint8ClampedArray {
  const ctx = canvas.createCanvas(48, 48).getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.font = `36px "${family}"`;
  ctx.textBaseline = 'top';
  ctx.fillText(text, 4, 4);
  return ctx.getImageData(0, 0, 48, 48).data;
}

function ink(rgba: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! > 128) n += 1;
  return n;
}

function same(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function rendersHangul(canvas: CanvasModule, family: string): boolean {
  const han = glyph(canvas, family, '한');
  const geul = glyph(canvas, family, '글');
  const missing = glyph(canvas, family, '\u{10FFFD}');
  return ink(han) > 20 && ink(geul) > 20 && !same(han, geul) && !same(han, missing);
}

export function resolveAnnotationFont(): Promise<AnnotationFont> {
  resolved ??= (async () => {
    let family: string | null = null;
    try {
      const canvas = await loadCanvas();
      family = ANNOTATION_FONT_CANDIDATES.find((name) => canvas.GlobalFonts.has(name) && rendersHangul(canvas, name)) ?? null;
    } catch {
      family = null;
    }
    return { family, css: annotationFontFamilyCss(family) };
  })();
  return resolved;
}

/** For EngineProbe.koreanFont (processors-convert's probe may call this). */
export async function detectKoreanFont(): Promise<string | null> {
  return (await resolveAnnotationFont()).family;
}
