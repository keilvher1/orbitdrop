import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrbitError } from '@orbitdrop/contracts';
import { runConvert } from '../src/convert';
import { assembleText } from '../src/convert/pdf-to-text';
import { groupLines, linesToParagraphs, linesToText, type PositionedText } from '../src/pdf/text';
import { fixtures, inputFor, listFiles, makeCtx, makeFixtureDir, makeJob, sha256, staticFixture, tempFilesIn, type FixtureDir } from './helpers/convert-fixtures';

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OrbitError);
  expect((error as OrbitError).code).toBe(code);
}

describe('PDF → TXT (P1)', () => {
  let fx: FixtureDir;
  let TEXT: Awaited<ReturnType<typeof fixtures>>['TEXT'];

  beforeAll(async () => {
    fx = await makeFixtureDir(['report.pdf', 'Page 001.pdf', 'scanned.pdf', 'partial-text.pdf', 'many-pages.pdf', 'corrupt.pdf', 'korean-cmap.pdf']);
    TEXT = (await fixtures()).TEXT;
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('extracts every page in reading order with "--- Page N ---" markers (default)', async () => {
    const input = await fx.input('report.pdf');
    const before = await sha256(input.path);
    const { ctx, progress } = makeCtx();
    const result = await runConvert(makeJob('convert.txt', [input]), ctx);
    const out = result.outputs[0]!;
    expect(out).toMatchObject({ path: join(fx.dir, 'report.txt'), format: 'txt', pages: 3 });
    const text = await readFile(out.path, 'utf8');
    const page = (n: number): string =>
      [`--- Page ${n} ---`, TEXT.reportHeading(n, 3), '', ...TEXT.reportParagraph1, '', ...TEXT.reportParagraph2, ''].join('\n');
    expect(text).toBe([page(1), page(2), page(3)].join('\n'));
    expect(out.bytes).toBe(Buffer.byteLength(text));
    expect(result.warnings).toEqual([]);
    expect(await sha256(input.path)).toBe(before);
    expect(await tempFilesIn(fx.dir)).toEqual([]);
    expect(progress.filter((p) => p.kind === 'determinate').at(-1)).toEqual({ kind: 'determinate', done: 3, total: 3, unit: 'page' });
  });

  it('separates pages with form feeds or blank lines on request', async () => {
    const input = await fx.input('report.pdf');
    const ff = await readFile((await runConvert(makeJob('convert.txt', [input], { pageSeparator: 'formfeed' }), makeCtx().ctx)).outputs[0]!.path, 'utf8');
    const parts = ff.split('\f');
    expect(parts).toHaveLength(3);
    parts.forEach((part, i) => expect(part.startsWith(TEXT.reportHeading(i + 1, 3))).toBe(true));
    expect(ff).not.toContain('--- Page');

    const blank = await readFile((await runConvert(makeJob('convert.txt', [input], { pageSeparator: 'blank' }), makeCtx().ctx)).outputs[0]!.path, 'utf8');
    expect(blank).toContain(`${TEXT.reportParagraph2[0]}\n\n${TEXT.reportHeading(2, 3)}`);
    expect(blank).not.toContain('\f');
  });

  it('refuses scanned (image-only) PDFs with PDF_NO_TEXT and writes no empty file', async () => {
    const before = await listFiles(fx.dir);
    await rejectsWith(runConvert(makeJob('convert.txt', [await fx.input('scanned.pdf')]), makeCtx().ctx), 'PDF_NO_TEXT');
    expect(await listFiles(fx.dir)).toEqual(before);
  });

  it('warns PDF_PAGES_WITHOUT_TEXT with the page numbers when only some pages are image-only', async () => {
    const result = await runConvert(makeJob('convert.txt', [await fx.input('partial-text.pdf')]), makeCtx().ctx);
    expect(result.warnings).toEqual([{ code: 'PDF_PAGES_WITHOUT_TEXT', params: { pages: '2', count: 1 } }]);
    const text = await readFile(result.outputs[0]!.path, 'utf8');
    expect(text).toBe(`--- Page 1 ---\n${TEXT.partial(1)}\n\n--- Page 2 ---\n\n--- Page 3 ---\n${TEXT.partial(3)}\n`);
  });

  it('extracts Korean text (embedded-font PDF made with CoreText) as UTF-8', async () => {
    const korean = staticFixture('korean-text.pdf');
    expect(korean, 'tests/fixtures/static/korean-text.pdf is committed').not.toBeNull();
    const sub = await makeFixtureDir([]);
    try {
      const copy = join(sub.dir, '한글 보고서.pdf');
      await writeFile(copy, await readFile(korean!));
      const result = await runConvert(makeJob('convert.txt', [await inputFor(copy)]), makeCtx().ctx);
      expect(result.outputs[0]!.path).toBe(join(sub.dir, '한글 보고서.txt'));
      const text = await readFile(result.outputs[0]!.path, 'utf8');
      expect(text).toBe('--- Page 1 ---\n안녕하세요 OrbitDrop\n한글 텍스트 추출 테스트\n\n--- Page 2 ---\n두 번째 페이지입니다\n');
    } finally {
      await sub.cleanup();
    }
  });

  it('decodes text of a non-embedded CJK font through PDF.js\' bundled CMaps (UniKS-UCS2-H)', async () => {
    const result = await runConvert(makeJob('convert.txt', [await fx.input('korean-cmap.pdf')]), makeCtx().ctx);
    expect(await readFile(result.outputs[0]!.path, 'utf8')).toBe(`--- Page 1 ---\n${TEXT.koreanCmap}\n`);
  });

  it('maps encrypted, corrupt and over-long PDFs to PDF_ENCRYPTED / PDF_CORRUPT / TOO_MANY_PAGES', async () => {
    const encrypted = staticFixture('encrypted.pdf');
    expect(encrypted).not.toBeNull();
    await rejectsWith(runConvert(makeJob('convert.txt', [await inputFor(encrypted!)]), makeCtx().ctx), 'PDF_ENCRYPTED');
    await rejectsWith(runConvert(makeJob('convert.txt', [await fx.input('corrupt.pdf')]), makeCtx().ctx), 'PDF_CORRUPT');
    await rejectsWith(runConvert(makeJob('convert.txt', [await fx.input('many-pages.pdf')], {}, { limits: { maxPdfPages: 3 } }), makeCtx().ctx), 'TOO_MANY_PAGES');
  });

  it('stops on cancellation without writing', async () => {
    const before = await listFiles(fx.dir);
    const { ctx } = makeCtx((p, controller) => {
      if (p.kind === 'determinate' && p.done === 2) controller.abort();
    });
    await rejectsWith(runConvert(makeJob('convert.txt', [await fx.input('many-pages.pdf')]), ctx), 'CANCELLED');
    expect(await listFiles(fx.dir)).toEqual(before);
  });

  it('assembleText joins pages for each separator', () => {
    expect(assembleText(['a', 'b'], 'marker')).toBe('--- Page 1 ---\na\n\n--- Page 2 ---\nb\n');
    expect(assembleText(['a', 'b'], 'formfeed')).toBe('a\n\fb\n');
    expect(assembleText(['a', '', 'c'], 'blank')).toBe('a\n\n\nc\n');
  });
});

describe('text layout', () => {
  const run = (str: string, x: number, y: number, width: number, size = 10, hasEOL = false): PositionedText => ({ str, x, y, width, size, hasEOL });

  it('joins runs on one baseline, inserting a space only across real gaps', () => {
    const lines = groupLines([run('Hello', 10, 700, 25), run('World', 40, 700, 25), run('!', 65, 700, 3)]);
    expect(lines.map((l) => l.text)).toEqual(['Hello World!']);
  });

  it('breaks lines on EOL markers and on baseline changes, keeps superscripts on the line', () => {
    const lines = groupLines([
      run('First', 10, 700, 25),
      run('', 35, 700, 0, 10, true),
      run('Second', 10, 686, 30),
      run('2', 41, 690, 4, 6),
      run('Third', 10, 672, 25),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['First', 'Second2', 'Third']);
  });

  it('starts a new line when text jumps back to the left on the same baseline', () => {
    const lines = groupLines([run('right column', 300, 500, 60), run('left column', 10, 500, 55)]);
    expect(lines.map((l) => l.text)).toEqual(['right column', 'left column']);
  });

  it('adds blank lines between paragraphs and on column jumps (TXT)', () => {
    const lines = groupLines([run('A1', 10, 700, 400), run('A2', 10, 688, 400), run('B1', 10, 650, 100), run('C1', 300, 700, 100)]);
    expect(linesToText(lines)).toBe('A1\nA2\n\nB1\n\nC1');
  });

  it('re-flows wrapped lines into paragraphs for DOCX, but not short lines', () => {
    const lines = groupLines([
      run('Heading', 10, 720, 60, 16),
      run('A long line that wraps', 10, 690, 400),
      run('onto the next line', 10, 678, 380),
      run('and ends here.', 10, 666, 90),
      run('Item one', 10, 640, 50),
      run('Item two', 10, 628, 50),
      run('漢字の', 10, 600, 400),
      run('続き', 10, 588, 40),
    ]);
    expect(linesToParagraphs(lines)).toEqual(['Heading', 'A long line that wraps onto the next line and ends here.', 'Item one', 'Item two', '漢字の続き']);
  });
});
