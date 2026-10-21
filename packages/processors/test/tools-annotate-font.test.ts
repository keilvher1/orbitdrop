import { GlobalFonts } from '@napi-rs/canvas';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnnotationShape, JobWarning } from '@orbitdrop/contracts';
import { checkTextCoverage, loadCanvas, rendersHangul, resolveAnnotationFont, setAnnotationFontCandidates } from '../src/tools/fonts';
import { inputFor, makeTempDir, preview, removeDir, runToolJob, writeFixture, type Rgba } from './helpers/tools-fixtures';

/**
 * ANNOTATION_FONT_FALLBACK: Korean (or any) text the export's font stack cannot draw is
 * reported by the job and by the preview. The fallback is forced with a font-list
 * override naming an installed font without Hangul (@napi-rs/canvas draws Hangul it does
 * not have as blanks for installed faces), so the check runs on real rendering.
 */

const PUA = '\u{F0123}\u{F0124}'; // supplementary private use: no font draws these

async function latinOnlyFamily(): Promise<string> {
  const canvas = await loadCanvas();
  const preferred = ['Courier New', 'Courier', 'Arial', 'Helvetica', 'Times New Roman', 'Verdana', 'Georgia'];
  const names = [...preferred, ...GlobalFonts.families.map((f) => f.family)];
  const found = names.find((n) => GlobalFonts.has(n) && !rendersHangul(canvas, n));
  if (!found) throw new Error('no installed font without Hangul to force the fallback');
  return found;
}

function textInk(img: Rgba, x0: number, y0: number, x1: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * img.width + x) * 4;
      if (img.data[i]! < 128 && img.data[i + 1]! < 128 && img.data[i + 2]! < 128) n += 1;
    }
  }
  return n;
}

async function rgba(data: string | Uint8Array): Promise<Rgba> {
  const { data: px, info } = await sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: px, width: info.width, height: info.height };
}

const fallback = (warnings: readonly JobWarning[] | undefined) => warnings?.find((w) => w.code === 'ANNOTATION_FONT_FALLBACK');

describe('ANNOTATION_FONT_FALLBACK', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await makeTempDir('annotate-font');
    path = await writeFixture(dir, 'white.png', await sharp({ create: { width: 480, height: 200, channels: 3, background: '#FFFFFF' } }).png().toBuffer());
    setAnnotationFontCandidates(null);
  });
  afterEach(async () => {
    setAnnotationFontCandidates(null);
    await removeDir(dir);
  });

  const korean: AnnotationShape = { id: 'k', type: 'text', x: 20, y: 40, text: '한글 주석', color: '#000000', fontSize: 64, bold: true };

  it('is not reported when the installed Hangul font draws the text', async () => {
    const font = await resolveAnnotationFont();
    expect(font.family).not.toBeNull();
    const result = await runToolJob('tool.annotate', await inputFor(path), { shapes: [korean, { id: 'a', type: 'arrow', x1: 300, y1: 150, x2: 450, y2: 100, color: '#FF0000', strokeWidth: 6 }] });
    expect(fallback(result.warnings)).toBeUndefined();
    const p = await preview('tool.annotate', await inputFor(path), { shapes: [korean] }, 240);
    expect(p.warnings).toBeUndefined();
    expect(textInk(await rgba(result.outputs[0]!.path), 20, 30, 340, 120)).toBeGreaterThan(1500);
  });

  it('is reported (job and preview) when no Hangul-capable font is available — forced by a font-list override', async () => {
    // reference: the same text drawn with the installed Hangul font
    const reference = await runToolJob('tool.annotate', await inputFor(path), { shapes: [korean] });
    const referenceInk = textInk(await rgba(reference.outputs[0]!.path), 20, 30, 340, 120);
    const latin = await latinOnlyFamily();
    setAnnotationFontCandidates([latin]);
    const font = await resolveAnnotationFont();
    expect(font.family).toBeNull();
    expect(font.css.startsWith(`"${latin}"`)).toBe(true);

    const mixed: AnnotationShape = { id: 'm', type: 'text', x: 20, y: 130, text: 'OK 한', color: '#000000', fontSize: 40, bold: false };
    const shapes = [korean, mixed, { id: 'r', type: 'rect' as const, x: 400, y: 20, width: 60, height: 60, color: '#FF0000', strokeWidth: 4 }];
    const result = await runToolJob('tool.annotate', await inputFor(path), { shapes });
    expect(result.outputs).toHaveLength(1); // the export still happens (the rect is drawn)
    const warning = fallback(result.warnings);
    expect(warning).toEqual({
      code: 'ANNOTATION_FONT_FALLBACK',
      // 한, 글, 주, 석 (the mixed shape repeats 한); the mixed shape stays readable thanks to "OK"
      params: { font: 'sans-serif', characters: 4, shapes: 2, unreadable: 1, hangul: 1 },
    });
    // the params carry counts and a font name only, never the text
    expect(Object.values(warning!.params ?? {}).some((v) => typeof v === 'string' && /[가-힣]/.test(v))).toBe(false);

    // …and the export really lacks the Hangul glyphs: blanks or thin missing-glyph boxes instead
    const img = await rgba(result.outputs[0]!.path);
    expect(textInk(img, 20, 30, 340, 120)).toBeLessThan(referenceInk / 2);
    expect(img.data[(50 * img.width + 400) * 4]).toBe(255); // rect outline (red) is there

    const p = await preview('tool.annotate', await inputFor(path), { shapes }, 240);
    expect(fallback(p.warnings)).toEqual(warning);
  });

  it('reports characters no font covers, even with a Hangul font installed', async () => {
    const shapes: AnnotationShape[] = [
      { id: 'p', type: 'text', x: 10, y: 10, text: `${PUA} 한글`, color: '#000000', fontSize: 30, bold: false },
      { id: 'q', type: 'text', x: 10, y: 80, text: PUA, color: '#000000', fontSize: 30, bold: false },
    ];
    const result = await runToolJob('tool.annotate', await inputFor(path), { shapes });
    expect(fallback(result.warnings)?.params).toEqual({ font: (await resolveAnnotationFont()).family, characters: 2, shapes: 2, unreadable: 1, hangul: 0 });
    const p = await preview('tool.annotate', await inputFor(path), { shapes }, 120);
    expect(fallback(p.warnings)?.params).toEqual(fallback(result.warnings)?.params);
  });

  it('ignores ASCII, spaces, combining marks and joiners; non-text shapes never warn', async () => {
    const latin = await latinOnlyFamily();
    setAnnotationFontCandidates([latin]);
    const css = (await resolveAnnotationFont()).css;
    expect(await checkTextCoverage(['Hello, world!', 'é ‍ \t'], css)).toEqual({ missing: 0, shapes: 0, unreadableShapes: 0, hangul: false });
    const coverage = await checkTextCoverage(['한한글', 'ab 글'], css);
    expect(coverage).toEqual({ missing: 2, shapes: 2, unreadableShapes: 1, hangul: true });
    const arrowOnly = await runToolJob('tool.annotate', await inputFor(path), { shapes: [{ id: 'a', type: 'arrow', x1: 10, y1: 10, x2: 100, y2: 100, color: '#000000', strokeWidth: 4 }] });
    expect(arrowOnly.warnings).toEqual([]);
  });
});
