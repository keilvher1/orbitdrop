/**
 * Conversion engine through the public processor API, the way the worker host
 * uses it: main validates dropped paths (header sniffing, real path), builds a
 * ProcessorJob per file (or one merged job), and the results are re-read from
 * disk. Covers batches with partial failure, concurrent jobs racing for the
 * same output name, and the capability gate built from the measured probe.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROCESSING_LIMITS,
  OrbitError,
  toErrorInfo,
  type ActionId,
  type JobProgress,
  type ProcessorInput,
  type ProcessorResult,
} from '@orbitdrop/contracts';
import { buildCapabilitySnapshot, supports } from '@orbitdrop/core';
import { isTempFileName, validateInputFile } from '@orbitdrop/core/node';
import { probeEngines, runJob } from '@orbitdrop/processors';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const settings = { pdfDpi: 300, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 } as const;

interface FixtureModule {
  generateFixtures(dir: string, options?: { only?: readonly string[] }): Promise<Record<string, string>>;
}

const sha256 = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex');

let ids = 0;
async function inputFor(path: string): Promise<ProcessorInput> {
  const v = await validateInputFile(path);
  return { fileId: `in${(ids += 1)}`, path: v.realPath, displayName: v.displayName, sourceDir: v.sourceDir, format: v.format, bytes: v.bytes };
}

let jobs = 0;
function run(actionId: ActionId, inputs: ProcessorInput[], options: unknown = {}, progress: JobProgress[] = []): Promise<ProcessorResult> {
  return runJob(
    { jobId: `int-${(jobs += 1)}`, actionId, inputs, options, outputDir: null, settings, limits: DEFAULT_PROCESSING_LIMITS },
    { signal: new AbortController().signal, onProgress: (p) => progress.push(p) },
  );
}

describe('conversion pipeline (validate → job → outputs re-read)', () => {
  let dir: string;
  let paths: Record<string, string>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-convert-int-'));
    const mod = (await import(pathToFileURL(join(ROOT, 'scripts', 'gen-fixtures.mjs')).href)) as FixtureModule;
    paths = await mod.generateFixtures(dir, {
      only: ['report.pdf', 'Page 001.pdf', 'photo.jpg', 'transparent.png', 'sample.webp', 'corrupt.jpg', 'png-named.jpg', '사진 테스트 😀.jpg', 'scanned.pdf'],
    });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('PDF → JPG: page count = file count, names, 300 DPI sizes, originals untouched, no temp files', async () => {
    const before = await sha256(paths['report.pdf']!);
    const progress: JobProgress[] = [];
    const result = await run('convert.jpeg', [await inputFor(paths['report.pdf']!)], {}, progress);
    const pageCount = (await PDFDocument.load(await readFile(paths['report.pdf']!))).getPageCount();
    expect(result.outputs).toHaveLength(pageCount);
    expect(result.outputs.map((o) => o.path)).toEqual(['report-p001.jpg', 'report-p002.jpg', 'report-p003.jpg'].map((n) => join(dir, n)));
    for (const out of result.outputs) {
      const meta = await sharp(out.path).metadata();
      expect(meta).toMatchObject({ format: 'jpeg', width: 2550, height: 3300, density: 300 });
      const stats = await sharp(out.path).stats();
      expect(stats.channels[0]!.min).toBeLessThan(80); // there is dark text on the page
      expect(stats.channels[0]!.max).toBe(255);
    }
    expect(await sha256(paths['report.pdf']!)).toBe(before);
    expect((await readdir(dir)).filter((n) => isTempFileName(n))).toEqual([]);
    const counts = progress.filter((p) => p.kind === 'determinate');
    expect(counts.at(-1)).toEqual({ kind: 'determinate', done: 3, total: 3, unit: 'page' });
  });

  it('a batch of images converts in parallel; one corrupt file fails alone with its own error', async () => {
    const files = ['photo.jpg', 'transparent.png', 'corrupt.jpg', 'sample.webp', '사진 테스트 😀.jpg'];
    const inputs = await Promise.all(files.map((f) => inputFor(paths[f]!)));
    const settled = await Promise.allSettled(inputs.map((input) => run('convert.png', [input])));
    const summary = settled.map((s, i) => [files[i], s.status === 'fulfilled' ? 'ok' : toErrorInfo(s.reason).code]);
    expect(summary).toEqual([
      ['photo.jpg', 'ok'],
      ['transparent.png', 'INVALID_OPTIONS'], // PNG → PNG is never offered; the executor refuses it too
      ['corrupt.jpg', 'IMAGE_CORRUPT'],
      ['sample.webp', 'ok'],
      ['사진 테스트 😀.jpg', 'ok'],
    ]);
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      const meta = await sharp(s.value.outputs[0]!.path).metadata();
      expect(meta.format).toBe('png');
    }
    expect((await readdir(dir)).filter((n) => isTempFileName(n))).toEqual([]);
  });

  it('concurrent jobs writing the same name each get their own file (exclusive naming)', async () => {
    const input = await inputFor(paths['photo.jpg']!);
    const results = await Promise.all([run('convert.webp', [input]), run('convert.webp', [input]), run('convert.webp', [input])]);
    const names = results.map((r) => r.outputs[0]!.path.slice(dir.length + 1)).sort();
    expect(names).toEqual(['photo (2).webp', 'photo (3).webp', 'photo.webp']);
    for (const r of results) expect((await sharp(r.outputs[0]!.path).metadata()).format).toBe('webp');
  });

  it('images → one PDF in the confirmed order; PDF → TXT; scanned PDF → PDF_NO_TEXT', async () => {
    const a = await inputFor(paths['sample.webp']!);
    const b = await inputFor(paths['photo.jpg']!);
    const merged = await run('convert.pdf', [a, b], { order: [b.fileId, a.fileId] });
    const pdf = await PDFDocument.load(await readFile(merged.outputs[0]!.path));
    expect(pdf.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())])).toEqual([
      [320, 240],
      [64, 48],
    ]);

    const txt = await run('convert.txt', [await inputFor(paths['Page 001.pdf']!)]);
    expect(await readFile(txt.outputs[0]!.path, 'utf8')).toBe('--- Page 1 ---\nOrbitDrop single page fixture\nSecond line of the single page\n');

    const scanned = await run('convert.txt', [await inputFor(paths['scanned.pdf']!)]).catch((e: unknown) => e);
    expect(scanned).toBeInstanceOf(OrbitError);
    expect((scanned as OrbitError).code).toBe('PDF_NO_TEXT');
  });

  it('the capability gate from the measured probe agrees with what the executors can do', async () => {
    const snapshot = buildCapabilitySnapshot(await probeEngines());
    const png = await inputFor(paths['png-named.jpg']!);
    expect(png.format).toBe('png');
    expect(supports(snapshot, 'convert.jpeg', { kind: 'image', format: png.format })).toBe(true);
    expect(supports(snapshot, 'convert.png', { kind: 'image', format: png.format })).toBe(false);
    const result = await run('convert.jpeg', [png]);
    expect(result.outputs[0]!.path).toBe(join(dir, 'png-named (2).jpg'));
    expect(result.warnings.map((w) => w.code)).toContain('EXTENSION_MISMATCH');
  });
});
