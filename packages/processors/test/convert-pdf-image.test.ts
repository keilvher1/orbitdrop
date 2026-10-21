import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrbitError, type JobProgress } from '@orbitdrop/contracts';
import { runConvert } from '../src/convert';
import { OutputLedger } from '../src/convert/common';
import { fitScale } from '../src/convert/pdf-to-image';
import { inputFor, listFiles, makeCtx, makeFixtureDir, makeJob, sha256, staticFixture, tempFilesIn, type FixtureDir } from './helpers/convert-fixtures';

async function pixels(path: string) {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): [number, number, number] => {
    const o = (y * info.width + x) * info.channels;
    return [data[o]!, data[o + 1]!, data[o + 2]!];
  };
  let dark = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i]! < 96 && data[i + 1]! < 96 && data[i + 2]! < 96) dark += 1;
  return { info, at, dark };
}

async function expectOrbitError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OrbitError);
  expect((error as OrbitError).code).toBe(code);
}

function determinate(progress: JobProgress[]) {
  return progress.filter((p): p is Extract<JobProgress, { kind: 'determinate' }> => p.kind === 'determinate');
}

describe('PDF → JPEG/PNG (P0-A)', () => {
  let fx: FixtureDir;

  beforeAll(async () => {
    fx = await makeFixtureDir(['Page 001.pdf', 'report.pdf', 'rotated.pdf', 'mixed-sizes.pdf', 'many-pages.pdf', 'corrupt.pdf', 'korean-cmap.pdf']);
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('converts a one-page PDF to "Page 001.jpg" at 300 DPI (US Letter → 2550×3300) with real rendered text', async () => {
    const input = await fx.input('Page 001.pdf');
    const before = await sha256(input.path);
    const { ctx, progress } = makeCtx();
    const result = await runConvert(makeJob('convert.jpeg', [input]), ctx);

    expect(result.outputs).toHaveLength(1);
    const out = result.outputs[0]!;
    expect(out.path).toBe(join(fx.dir, 'Page 001.jpg'));
    expect(out).toMatchObject({ format: 'jpeg', width: 2550, height: 3300 });
    const meta = await sharp(out.path).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 2550, height: 3300, density: 300 });
    expect(out.bytes).toBe((await import('node:fs')).statSync(out.path).size);

    const px = await pixels(out.path);
    expect(px.at(5, 5)).toEqual(expect.arrayContaining([expect.any(Number)]));
    expect(Math.min(...px.at(5, 5))).toBeGreaterThan(245); // white page background
    expect(px.dark).toBeGreaterThan(2000); // the text was really drawn (standard font data loaded)

    expect(await sha256(input.path)).toBe(before);
    expect(await tempFilesIn(fx.dir)).toEqual([]);
    const pages = determinate(progress);
    expect(pages.at(0)).toEqual({ kind: 'determinate', done: 0, total: 1, unit: 'page' });
    expect(pages.at(-1)).toEqual({ kind: 'determinate', done: 1, total: 1, unit: 'page' });
    expect(result.warnings).toEqual([]);
  });

  it('writes one PNG per page named report-p001…p003 at 150 DPI (option), opaque RGB with density', async () => {
    const input = await fx.input('report.pdf');
    const { ctx, progress } = makeCtx();
    const result = await runConvert(makeJob('convert.png', [input], { dpi: 150 }), ctx);
    expect(result.outputs.map((o) => o.path)).toEqual(['report-p001.png', 'report-p002.png', 'report-p003.png'].map((n) => join(fx.dir, n)));
    for (const out of result.outputs) {
      const meta = await sharp(out.path).metadata();
      expect(meta).toMatchObject({ format: 'png', width: 1275, height: 1650, channels: 3, hasAlpha: false, density: 150 });
      expect((await pixels(out.path)).dark).toBeGreaterThan(300);
    }
    const done = determinate(progress).map((p) => p.done);
    expect(done).toEqual([...done].sort((a, b) => a - b));
    expect(done.at(-1)).toBe(3);
  });

  it('uses settings.pdfDpi when the job has no dpi option (150 vs 300)', async () => {
    const input = await fx.input('Page 001.pdf');
    const low = await runConvert(makeJob('convert.jpeg', [input], {}, { settings: { pdfDpi: 150 } }), makeCtx().ctx);
    expect(await sharp(low.outputs[0]!.path).metadata()).toMatchObject({ width: 1275, height: 1650, density: 150 });
    // A second conversion of the same file never overwrites the first result.
    expect(low.outputs[0]!.path).toBe(join(fx.dir, 'Page 001 (2).jpg'));
  });

  it('honours /Rotate: 90° turns the page landscape and moves the top-left mark to the top-right; 180° to the bottom-right', async () => {
    const input = await fx.input('rotated.pdf');
    const result = await runConvert(makeJob('convert.png', [input]), makeCtx().ctx);
    expect(result.outputs.map((o) => [o.width, o.height])).toEqual([
      [3300, 2550],
      [2550, 3300],
    ]);
    const r90 = await pixels(result.outputs[0]!.path);
    expect([r90.info.width, r90.info.height]).toEqual([3300, 2550]);
    expect(Math.max(...r90.at(3300 - 150, 150))).toBeLessThan(40); // mark: top-right
    expect(Math.min(...r90.at(150, 150))).toBeGreaterThan(230); // top-left is white
    const r180 = await pixels(result.outputs[1]!.path);
    expect(Math.max(...r180.at(2550 - 150, 3300 - 150))).toBeLessThan(40); // mark: bottom-right
    expect(Math.min(...r180.at(150, 150))).toBeGreaterThan(230);
  });

  it('keeps per-page sizes (Letter, A4, A5 landscape)', async () => {
    const input = await fx.input('mixed-sizes.pdf');
    const result = await runConvert(makeJob('convert.jpeg', [input]), makeCtx().ctx);
    const sizes = await Promise.all(result.outputs.map(async (o) => sharp(o.path).metadata()));
    expect(sizes.map((m) => [m.width, m.height])).toEqual([
      [2550, 3300],
      [2480, 3508],
      [2480, 1748],
    ]);
  });

  it('never overwrites: an existing "report-p002.png" stays untouched and the new page gets " (2)"', async () => {
    const sub = await makeFixtureDir(['report.pdf']);
    try {
      const squatter = join(sub.dir, 'report-p002.png');
      await writeFile(squatter, 'not an image, but the user’s file');
      const before = await sha256(squatter);
      const result = await runConvert(makeJob('convert.png', [await sub.input('report.pdf')], { dpi: 150 }), makeCtx().ctx);
      expect(result.outputs.map((o) => o.path)).toEqual(['report-p001.png', 'report-p002 (2).png', 'report-p003.png'].map((n) => join(sub.dir, n)));
      expect(await sha256(squatter)).toBe(before);
    } finally {
      await sub.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('fails fast with OUTPUT_DIR_NOT_WRITABLE before rendering when the folder is read-only or missing', async () => {
    const { chmod, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const locked = await mkdtemp(join(tmpdir(), 'orbitdrop-convert-ro-'));
    try {
      await chmod(locked, 0o555);
      const { ctx, progress } = makeCtx();
      await expectOrbitError(runConvert(makeJob('convert.jpeg', [await fx.input('report.pdf')], {}, { outputDir: locked }), ctx), 'OUTPUT_DIR_NOT_WRITABLE');
      expect(determinate(progress)).toEqual([]);
      await expectOrbitError(runConvert(makeJob('convert.jpeg', [await fx.input('report.pdf')], {}, { outputDir: join(locked, 'missing') }), makeCtx().ctx), 'OUTPUT_DIR_NOT_WRITABLE');
    } finally {
      await chmod(locked, 0o755);
      await rm(locked, { recursive: true, force: true });
    }
  });

  it('rejects encrypted PDFs with PDF_ENCRYPTED', async () => {
    const encrypted = staticFixture('encrypted.pdf');
    expect(encrypted, 'tests/fixtures/static/encrypted.pdf is committed').not.toBeNull();
    const sub = await makeFixtureDir([]);
    try {
      const copy = join(sub.dir, 'secret.pdf');
      await writeFile(copy, await (await import('node:fs/promises')).readFile(encrypted!));
      await expectOrbitError(runConvert(makeJob('convert.jpeg', [await inputFor(copy)]), makeCtx().ctx), 'PDF_ENCRYPTED');
      expect(await listFiles(sub.dir)).toEqual(['secret.pdf']);
    } finally {
      await sub.cleanup();
    }
  });

  it('rejects corrupt PDFs with PDF_CORRUPT and writes nothing', async () => {
    const before = await listFiles(fx.dir);
    await expectOrbitError(runConvert(makeJob('convert.jpeg', [await fx.input('corrupt.pdf')]), makeCtx().ctx), 'PDF_CORRUPT');
    expect(await listFiles(fx.dir)).toEqual(before);
  });

  it('rejects PDFs above limits.maxPdfPages with TOO_MANY_PAGES before rendering', async () => {
    const before = await listFiles(fx.dir);
    const { ctx, progress } = makeCtx();
    await expectOrbitError(runConvert(makeJob('convert.jpeg', [await fx.input('many-pages.pdf')], {}, { limits: { maxPdfPages: 5 } }), ctx), 'TOO_MANY_PAGES');
    expect(determinate(progress)).toEqual([]);
    expect(await listFiles(fx.dir)).toEqual(before);
  });

  it('cancelling mid-document removes the pages already written (no half result, no temp files)', async () => {
    const sub = await makeFixtureDir(['many-pages.pdf']);
    try {
      const { ctx, progress } = makeCtx((p, controller) => {
        if (p.kind === 'determinate' && p.done >= 3) controller.abort();
      });
      const job = makeJob('convert.jpeg', [await sub.input('many-pages.pdf')], { dpi: 150 }, { limits: { pdfPageConcurrency: 2 } });
      await expectOrbitError(runConvert(job, ctx), 'CANCELLED');
      expect(determinate(progress).some((p) => p.done >= 3)).toBe(true);
      expect(await listFiles(sub.dir)).toEqual(['many-pages.pdf']);
    } finally {
      await sub.cleanup();
    }
  });

  it('renders a page that exceeds maxOutputPixels at a lower DPI and says so (DOWNSCALED)', async () => {
    const sub = await makeFixtureDir(['Page 001.pdf']);
    try {
      const result = await runConvert(makeJob('convert.png', [await sub.input('Page 001.pdf')], {}, { limits: { maxOutputPixels: 2_000_000 } }), makeCtx().ctx);
      const out = result.outputs[0]!;
      const meta = await sharp(out.path).metadata();
      expect(meta.width! * meta.height!).toBeLessThanOrEqual(2_000_000);
      expect(meta.width! / meta.height!).toBeCloseTo(612 / 792, 2);
      const warning = result.warnings.find((w) => w.code === 'DOWNSCALED');
      expect(warning?.params).toMatchObject({ pages: '1', count: 1, requestedDpi: 300 });
      const dpi = Number(warning?.params?.dpi);
      expect(dpi).toBeLessThan(300);
      expect(Math.round(meta.density!)).toBe(Math.round(dpi));
    } finally {
      await sub.cleanup();
    }
  });

  it('decodes JPEG 2000 images (PDF.js openjpeg wasm loaded from the local package)', async () => {
    const jpx = staticFixture('jpx-image.pdf');
    expect(jpx, 'tests/fixtures/static/jpx-image.pdf is committed').not.toBeNull();
    const sub = await makeFixtureDir([]);
    try {
      const copy = join(sub.dir, 'jpx.pdf');
      await writeFile(copy, await (await import('node:fs/promises')).readFile(jpx!));
      const result = await runConvert(makeJob('convert.png', [await inputFor(copy)], { dpi: 150 }), makeCtx().ctx);
      const px = await pixels(result.outputs[0]!.path);
      // Image placed at x 146–466 pt, y 276–516 pt (PDF space) → 304–971 px, 575–1075 px at 150 DPI.
      const left = px.at(450, 825);
      const right = px.at(850, 825);
      expect(left[0]).toBeGreaterThan(180);
      expect(left[2]).toBeLessThan(80);
      expect(right[2]).toBeGreaterThan(180);
      expect(right[0]).toBeLessThan(80);
      expect(Math.min(...px.at(100, 100))).toBeGreaterThan(245);
    } finally {
      await sub.cleanup();
    }
  });

  it.skipIf(process.platform !== 'darwin')('renders a non-embedded Korean CID font with the system fallback font', async () => {
    const result = await runConvert(makeJob('convert.png', [await fx.input('korean-cmap.pdf')], { dpi: 150 }), makeCtx().ctx);
    expect((await pixels(result.outputs[0]!.path)).dark).toBeGreaterThan(300);
  });

  it('renders Korean text from an embedded-font PDF (static fixture)', async () => {
    const korean = staticFixture('korean-text.pdf');
    expect(korean, 'tests/fixtures/static/korean-text.pdf is committed').not.toBeNull();
    const sub = await makeFixtureDir([]);
    try {
      const copy = join(sub.dir, '한글 문서.pdf');
      await writeFile(copy, await (await import('node:fs/promises')).readFile(korean!));
      const result = await runConvert(makeJob('convert.png', [await inputFor(copy)], { dpi: 150 }), makeCtx().ctx);
      expect(result.outputs.map((o) => o.path)).toEqual([join(sub.dir, '한글 문서-p001.png'), join(sub.dir, '한글 문서-p002.png')]);
      expect(result.outputs.map((o) => [o.width, o.height])).toEqual([
        [1240, 1754],
        [1240, 1754],
      ]);
      expect((await pixels(result.outputs[0]!.path)).dark).toBeGreaterThan(500);
      expect((await pixels(result.outputs[1]!.path)).dark).toBeGreaterThan(200);
    } finally {
      await sub.cleanup();
    }
  });
});

describe('fitScale', () => {
  it('keeps the scale when the page fits and lowers it to fit the pixel and side limits', () => {
    expect(fitScale(2550, 3300, 300 / 72, 150_000_000)).toEqual({ scale: 300 / 72, downscaled: false });
    const px = fitScale(20_000, 20_000, 300 / 72, 100_000_000);
    expect(px.downscaled).toBe(true);
    expect(20_000 * (px.scale / (300 / 72)) * 20_000 * (px.scale / (300 / 72))).toBeLessThanOrEqual(100_000_000);
    const side = fitScale(100_000, 1_000, 1, 1e12);
    expect(side.downscaled).toBe(true);
    expect(100_000 * side.scale).toBeLessThanOrEqual(65_000);
  });
});

describe('OutputLedger rollback', () => {
  it('removes exactly the files it committed, and not a file the user replaced meanwhile', async () => {
    const sub = await makeFixtureDir([]);
    try {
      const ledger = new OutputLedger();
      const signal = new AbortController().signal;
      const a = await ledger.commit(sub.dir, 'a.txt', 'ledger-test', new TextEncoder().encode('aaa'), signal, { format: 'txt' });
      const b = await ledger.commit(sub.dir, 'b.txt', 'ledger-test', new TextEncoder().encode('bbb'), signal, { format: 'txt' });
      await writeFile(join(sub.dir, 'user.txt'), 'keep me');
      // The user replaces b.txt with their own file before the rollback.
      const { rm } = await import('node:fs/promises');
      await rm(b.path);
      await writeFile(b.path, 'user content that must survive');
      expect(await ledger.rollback()).toBe(1);
      expect(await listFiles(sub.dir)).toEqual(['b.txt', 'user.txt']);
      expect(a.path).toBe(join(sub.dir, 'a.txt'));
    } finally {
      await sub.cleanup();
    }
  });
});
