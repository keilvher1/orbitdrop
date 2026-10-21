/**
 * Smoke entry for the conversion engine under Electron's Node. It is bundled
 * like electron-vite bundles the processor host (CJS, @orbitdrop/* inlined,
 * runtime dependencies external) by convert-electron-smoke.mjs and then run
 * with ELECTRON_RUN_AS_NODE=1 and inside a real Electron utilityProcess.
 * Prints exactly one line: `CONVERT_SMOKE {json}`; exit code 0 when ok.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { DEFAULT_PROCESSING_LIMITS, type ActionId, type ProcessorResult } from '@orbitdrop/contracts';
import { validateInputFile } from '@orbitdrop/core/node';
import { probeEngines, runJob } from '@orbitdrop/processors';

const settings = { pdfDpi: 150, jpegQuality: 85, webpQuality: 80, avifQuality: 60, heicQuality: 70 } as const;

async function run(actionId: ActionId, paths: string[], options: unknown = {}): Promise<ProcessorResult> {
  const inputs = await Promise.all(
    paths.map(async (path, i) => {
      const v = await validateInputFile(path);
      return { fileId: `in${i}`, path: v.realPath, displayName: v.displayName, sourceDir: v.sourceDir, format: v.format, bytes: v.bytes };
    }),
  );
  return runJob(
    { jobId: `smoke-${actionId.replace('.', '-')}`, actionId, inputs, options, outputDir: null, settings, limits: DEFAULT_PROCESSING_LIMITS },
    { signal: new AbortController().signal, onProgress: () => undefined },
  );
}

async function main(): Promise<void> {
  const started = Date.now();
  const probe = await probeEngines();
  const probeMs = Date.now() - started;
  const dir = await mkdtemp(join(tmpdir(), 'orbitdrop-convert-smoke-'));
  const results: unknown[] = [];
  let ok = probe.pdfRender && probe.pdfText && probe.errors.length === 0;
  try {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 2; n += 1) doc.addPage([612, 792]).drawText(`Smoke page ${n}`, { x: 72, y: 700, size: 24, font });
    const pdfPath = join(dir, 'report.pdf');
    await writeFile(pdfPath, await doc.save());
    const pngPath = join(dir, 'alpha.png');
    await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 0.5 } } }).png().toFile(pngPath);

    // Regression ("SOI not found in JPEG" in the app): plain sharp JPEGs plus one whose EXIF gets
    // stripped — in a utilityProcess Buffer.poolSize is 64 KiB, so small Buffers are pool views.
    const jpegs: string[] = [];
    for (const [name, w, h, exif] of [
      ['a.jpg', 1600, 1200, false],
      ['b.jpg', 1200, 900, false],
      ['c.jpg', 1600, 1200, true],
    ] as const) {
      const path = join(dir, name);
      const image = sharp({ create: { width: w, height: h, channels: 3, background: '#cc6633' } });
      await (exif ? image.withExif({ IFD0: { Make: 'Smoke' } }) : image).jpeg().toFile(path);
      jpegs.push(path);
    }
    const merged = await run('convert.pdf', jpegs, { order: ['in0', 'in1', 'in2'] });
    const mergedDoc = await PDFDocument.load(await readFile(merged.outputs[0]!.path));
    const pageSizes = mergedDoc.getPages().map((page) => [Math.round(page.getWidth()), Math.round(page.getHeight())]);
    results.push({ actionId: 'convert.pdf (jpegs)', outputs: [{ name: 'a.pdf', format: 'pdf', pages: pageSizes.length, pageSizes }], warnings: merged.warnings.map((w) => w.code) });
    ok &&= JSON.stringify(pageSizes) === JSON.stringify([[1600, 1200], [1200, 900], [1600, 1200]]);

    const checks: [ActionId, string[], unknown][] = [
      ['convert.jpeg', [pdfPath], {}],
      ['convert.png', [pdfPath], { dpi: 300 }],
      ['convert.txt', [pdfPath], {}],
      ['convert.docx', [pdfPath], {}],
      ['convert.jpeg', [pngPath], {}],
      ['convert.webp', [pngPath], {}],
      ['convert.bmp', [pngPath], {}],
      ['convert.pdf', [pngPath], {}],
    ];
    for (const [actionId, paths, options] of checks) {
      const result = await run(actionId, paths, options);
      const outputs = await Promise.all(
        result.outputs.map(async (o) => {
          const decoded = o.format === 'jpeg' || o.format === 'png' || o.format === 'webp' ? await sharp(o.path).metadata() : null;
          return { name: o.path.slice(dir.length + 1), format: o.format, bytes: o.bytes, width: decoded?.width ?? o.width, height: decoded?.height ?? o.height };
        }),
      );
      results.push({ actionId, outputs, warnings: result.warnings.map((w) => w.code) });
    }
    const first = results[1] as { outputs: { name: string; width: number; height: number }[] };
    ok &&= first.outputs.length === 2 && first.outputs[0]!.name === 'report-p001.jpg' && first.outputs[0]!.width === 1275 && first.outputs[0]!.height === 1650;
    const second = results[2] as { outputs: { width: number; height: number }[] };
    ok &&= second.outputs[0]!.width === 2550 && second.outputs[0]!.height === 3300;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const line = {
    ok,
    processType: (process as { type?: string }).type ?? null,
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    probeMs,
    totalMs: Date.now() - started,
    bufferPoolSize: Buffer.poolSize,
    // Where the engines were loaded from (inside the archive in the "asar" modes).
    resolved: Object.fromEntries(
      ['pdfjs-dist/package.json', 'sharp', '@napi-rs/canvas'].map((m) => {
        try {
          return [m, createRequire(import.meta.url).resolve(m)];
        } catch {
          return [m, null];
        }
      }),
    ),
    probe: {
      pdfRender: probe.pdfRender,
      pdfText: probe.pdfText,
      koreanFont: probe.koreanFont,
      errors: probe.errors,
      heic: probe.formats.heic,
      bmp: probe.formats.bmp,
      avif: probe.formats.avif,
      versions: probe.versions,
    },
    results,
  };
  finish(line, ok);
}

/**
 * Exit explicitly once stdout is flushed: an Electron utility process forked
 * with stdio 'pipe' keeps its stdout/stderr pipes (PipeWrap) open, so it would
 * otherwise never exit on its own.
 */
function finish(line: object, ok: boolean): void {
  process.stdout.write(`CONVERT_SMOKE ${JSON.stringify(line)}\n`, () => process.exit(ok ? 0 : 1));
}

main().catch((error: unknown) => {
  finish({ ok: false, processType: (process as { type?: string }).type ?? null, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, false);
});
