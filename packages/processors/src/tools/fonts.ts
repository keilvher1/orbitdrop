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
let candidateOverride: readonly string[] | null = null;

/**
 * Use these families instead of ANNOTATION_FONT_CANDIDATES (null restores the
 * default). For tests and diagnostics: forces the "no Hangul font" situation
 * with an installed font that has no Hangul (e.g. "Courier New").
 */
export function setAnnotationFontCandidates(candidates: readonly string[] | null): void {
  candidateOverride = candidates;
  resolved = null;
  drawableCache.clear();
}

/** One glyph rendered with a CSS font-family list (36 px on a 48×48 transparent canvas). */
function glyphWithCss(canvas: CanvasModule, css: string, text: string): Uint8ClampedArray {
  const ctx = canvas.createCanvas(48, 48).getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.font = `36px ${css}`;
  ctx.textBaseline = 'top';
  ctx.fillText(text, 4, 4);
  return ctx.getImageData(0, 0, 48, 48).data;
}

function glyph(canvas: CanvasModule, family: string, text: string): Uint8ClampedArray {
  return glyphWithCss(canvas, `"${family.replace(/"/g, '')}"`, text);
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
    const candidates = candidateOverride ?? ANNOTATION_FONT_CANDIDATES;
    let family: string | null = null;
    try {
      const canvas = await loadCanvas();
      family = candidates.find((name) => canvas.GlobalFonts.has(name) && rendersHangul(canvas, name)) ?? null;
    } catch {
      family = null;
    }
    if (!candidateOverride) return { family, css: annotationFontFamilyCss(family) };
    const names = [...(family ? [family] : []), ...candidateOverride.filter((n) => n !== family)];
    return { family, css: [...names.map((n) => `"${n.replace(/"/g, '')}"`), 'sans-serif'].join(', ') };
  })();
  return resolved;
}

/**
 * Which characters of annotation text the font stack really draws. Checked
 * per distinct character with the same glyph test as `rendersHangul`: a
 * character counts as missing when it renders nothing or exactly the
 * missing-glyph box (the rendering of U+10FFFD) — which is what @napi-rs/canvas
 * shows for scripts the chosen font lacks (an installed font draws Hangul it
 * does not have as blanks; an unknown family falls back to the default face).
 * ASCII, whitespace, control/format characters (ZWJ…) and combining marks are
 * not checked: they are covered by every face or draw nothing on their own.
 */
export interface TextCoverage {
  /** Distinct characters that cannot be drawn. */
  readonly missing: number;
  /** Text shapes containing at least one of them. */
  readonly shapes: number;
  /** Text shapes in which no visible character can be drawn at all. */
  readonly unreadableShapes: number;
  /** Some missing character is Hangul. */
  readonly hangul: boolean;
}

const drawableCache = new Map<string, boolean>();
const DRAWABLE_CACHE_LIMIT = 8192;

function checkedCharacter(ch: string): boolean {
  return (ch.codePointAt(0) ?? 0) >= 0x80 && !/[\s\p{Cc}\p{Cf}\p{M}]/u.test(ch);
}

export async function checkTextCoverage(texts: readonly string[], css: string): Promise<TextCoverage> {
  const canvas = await loadCanvas();
  const missingGlyph = glyphWithCss(canvas, css, '\u{10FFFD}');
  const drawable = (ch: string): boolean => {
    const key = `${css}\u0000${ch}`;
    let ok = drawableCache.get(key);
    if (ok === undefined) {
      const g = glyphWithCss(canvas, css, ch);
      ok = ink(g) > 0 && !same(g, missingGlyph);
      if (drawableCache.size >= DRAWABLE_CACHE_LIMIT) drawableCache.clear();
      drawableCache.set(key, ok);
    }
    return ok;
  };
  const missing = new Set<string>();
  let shapes = 0;
  let unreadableShapes = 0;
  for (const text of texts) {
    let visible = 0;
    let undrawn = 0;
    for (const ch of text) {
      if (/\s/u.test(ch)) continue;
      if (!checkedCharacter(ch)) {
        if ((ch.codePointAt(0) ?? 0) >= 0x21 && (ch.codePointAt(0) ?? 0) < 0x7f) visible += 1;
        continue;
      }
      visible += 1;
      if (!drawable(ch)) {
        undrawn += 1;
        missing.add(ch);
      }
    }
    if (undrawn > 0) shapes += 1;
    if (visible > 0 && undrawn === visible) unreadableShapes += 1;
  }
  return { missing: missing.size, shapes, unreadableShapes, hangul: [...missing].some((ch) => /\p{Script=Hangul}/u.test(ch)) };
}

/** For EngineProbe.koreanFont (processors-convert's probe may call this). */
export async function detectKoreanFont(): Promise<string | null> {
  return (await resolveAnnotationFont()).family;
}
