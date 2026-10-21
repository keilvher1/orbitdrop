import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrbitError } from '@orbitdrop/contracts';
import { runConvert } from '../src/convert';
import { docxImageSize } from '../src/convert/to-docx';
import { docxParagraphs, fixtures, inputFor, listFiles, makeCtx, makeFixtureDir, makeJob, readZip, staticFixture, tempFilesIn, type FixtureDir } from './helpers/convert-fixtures';

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OrbitError);
  expect((error as OrbitError).code).toBe(code);
}

async function openDocx(path: string) {
  const zip = readZip(await readFile(path));
  const documentXml = zip.get('word/document.xml')?.toString('utf8');
  expect(documentXml, 'word/document.xml').toBeDefined();
  expect(zip.has('[Content_Types].xml')).toBe(true);
  return { zip, documentXml: documentXml!, paragraphs: docxParagraphs(documentXml!) };
}

describe('PDF → DOCX, text-centric (P2)', () => {
  let fx: FixtureDir;
  let TEXT: Awaited<ReturnType<typeof fixtures>>['TEXT'];

  beforeAll(async () => {
    fx = await makeFixtureDir(['report.pdf', 'scanned.pdf', 'partial-text.pdf']);
    TEXT = (await fixtures()).TEXT;
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('writes the text as re-flowed paragraphs with a page break per PDF page and warns DOCX_TEXT_ONLY', async () => {
    const result = await runConvert(makeJob('convert.docx', [await fx.input('report.pdf')]), makeCtx().ctx);
    const out = result.outputs[0]!;
    expect(out).toMatchObject({ path: join(fx.dir, 'report.docx'), format: 'docx', pages: 3 });
    expect(result.warnings).toEqual([{ code: 'DOCX_TEXT_ONLY' }]);
    const { paragraphs } = await openDocx(out.path);
    const expected = [1, 2, 3].flatMap((n) => [
      { text: TEXT.reportHeading(n, 3), pageBreakBefore: n > 1 },
      { text: TEXT.reportParagraph1.join(' '), pageBreakBefore: false },
      { text: TEXT.reportParagraph2.join(' '), pageBreakBefore: false },
    ]);
    expect(paragraphs.filter((p) => p.text !== '' || p.pageBreakBefore)).toEqual(expected);
    expect(await tempFilesIn(fx.dir)).toEqual([]);
  });

  it('refuses image-only PDFs with PDF_NO_TEXT, keeps empty pages of partially scanned ones', async () => {
    const before = await listFiles(fx.dir);
    await rejectsWith(runConvert(makeJob('convert.docx', [await fx.input('scanned.pdf')]), makeCtx().ctx), 'PDF_NO_TEXT');
    expect(await listFiles(fx.dir)).toEqual(before);

    const partial = await runConvert(makeJob('convert.docx', [await fx.input('partial-text.pdf')]), makeCtx().ctx);
    expect(partial.warnings).toEqual([{ code: 'DOCX_TEXT_ONLY' }, { code: 'PDF_PAGES_WITHOUT_TEXT', params: { pages: '2', count: 1 } }]);
    const { paragraphs } = await openDocx(partial.outputs[0]!.path);
    expect(paragraphs).toEqual([
      { text: TEXT.partial(1), pageBreakBefore: false },
      { text: '', pageBreakBefore: true },
      { text: TEXT.partial(3), pageBreakBefore: true },
    ]);
  });

  it('keeps Korean text', async () => {
    const korean = staticFixture('korean-text.pdf');
    expect(korean).not.toBeNull();
    const sub = await makeFixtureDir([]);
    try {
      const copy = join(sub.dir, '보고서.pdf');
      await writeFile(copy, await readFile(korean!));
      const result = await runConvert(makeJob('convert.docx', [await inputFor(copy)]), makeCtx().ctx);
      expect(result.outputs[0]!.path).toBe(join(sub.dir, '보고서.docx'));
      const { paragraphs } = await openDocx(result.outputs[0]!.path);
      expect(paragraphs.map((p) => p.text)).toEqual(['안녕하세요 OrbitDrop', '한글 텍스트 추출 테스트', '두 번째 페이지입니다']);
    } finally {
      await sub.cleanup();
    }
  });
});

describe('image → DOCX (image embedded, no OCR)', () => {
  let fx: FixtureDir;

  beforeAll(async () => {
    fx = await makeFixtureDir(['photo.jpg', 'transparent.png', 'exif-orientation-6.jpg']);
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('embeds the JPEG as a picture at its physical size', async () => {
    const result = await runConvert(makeJob('convert.docx', [await fx.input('photo.jpg')]), makeCtx().ctx);
    const out = result.outputs[0]!;
    expect(out).toMatchObject({ path: join(fx.dir, 'photo.docx'), format: 'docx', pages: 1 });
    const { zip, documentXml } = await openDocx(out.path);
    const media = [...zip.keys()].filter((k) => k.startsWith('word/media/') && !k.endsWith('/'));
    expect(media).toHaveLength(1);
    const image = await sharp(zip.get(media[0]!)!).metadata();
    expect([image.format, image.width, image.height]).toEqual(['jpeg', 320, 240]);
    // 320×240 px at 72 DPI = 4.44 × 3.33 in → 427 × 320 CSS px → EMU (9525 per px).
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(documentXml);
    expect(extent?.slice(1).map(Number)).toEqual([427 * 9525, 320 * 9525]);
    expect(result.warnings).toContainEqual({ code: 'METADATA_REMOVED', params: { kinds: 'exif' } });
    expect(result.warnings[0]).toEqual({ code: 'DOCX_IMAGE_ONLY' });
  });

  it('embeds other formats as PNG (alpha kept) and applies EXIF orientation', async () => {
    const png = await runConvert(makeJob('convert.docx', [await fx.input('transparent.png')]), makeCtx().ctx);
    const pngZip = (await openDocx(png.outputs[0]!.path)).zip;
    const pngMedia = [...pngZip.entries()].find(([k]) => k.startsWith('word/media/') && !k.endsWith('/'))![1];
    expect(await sharp(pngMedia).metadata()).toMatchObject({ format: 'png', width: 64, height: 48, hasAlpha: true });

    const rotated = await runConvert(makeJob('convert.docx', [await fx.input('exif-orientation-6.jpg')]), makeCtx().ctx);
    const rotZip = (await openDocx(rotated.outputs[0]!.path)).zip;
    const rotMedia = [...rotZip.entries()].find(([k]) => k.startsWith('word/media/') && !k.endsWith('/'))![1];
    expect(await sharp(rotMedia).metadata()).toMatchObject({ width: 30, height: 60 });
  });

  it('scales large images down to the A4 text width, never enlarges small ones', () => {
    expect(docxImageSize(6000, 3000, 72)).toEqual({ width: 602, height: 301 });
    expect(docxImageSize(100, 50, 96)).toEqual({ width: 100, height: 50 });
    const tall = docxImageSize(1000, 10_000, 72);
    expect(tall.height).toBeLessThanOrEqual(931);
  });
});
