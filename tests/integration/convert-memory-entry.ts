/**
 * Memory probe for PDF jobs, run inside a real Electron utilityProcess by
 * `node tests/integration/convert-electron-smoke.mjs memory` (bundled like the
 * processor host: CJS, dependencies external). Converts the PDF named by
 * CONVERT_MEMORY_PDF with each action in CONVERT_MEMORY_ACTIONS while sampling
 * the process RSS every 5 ms, and prints one line `CONVERT_SMOKE {json}`.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { DEFAULT_PROCESSING_LIMITS, type ActionId } from '@orbitdrop/contracts';
import { probeEngines, runJob } from '@orbitdrop/processors';

const MB = 1024 * 1024;
// utilityProcess ignores --expose-gc in execArgv; enable it at runtime so samples start from a settled heap.
setFlagsFromString('--expose_gc');
const gc = (globalThis as { gc?: () => void }).gc ?? (runInNewContext('gc') as (() => void) | undefined);

function rssMB(): number {
  return Math.round(process.memoryUsage().rss / MB);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    gc?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function main(): Promise<void> {
  const pdfPath = process.env.CONVERT_MEMORY_PDF;
  if (!pdfPath) throw new Error('CONVERT_MEMORY_PDF is not set');
  const actions = (process.env.CONVERT_MEMORY_ACTIONS ?? 'convert.txt,convert.jpeg').split(',') as ActionId[];
  const size = (await stat(pdfPath)).size;
  await probeEngines();
  await settle();
  const baseline = rssMB();
  const runs: unknown[] = [];
  for (const actionId of actions) {
    await settle();
    const before = rssMB();
    let peak = before;
    const timer = setInterval(() => {
      peak = Math.max(peak, rssMB());
    }, 5);
    const out = await mkdtemp(join(tmpdir(), 'orbitdrop-memory-out-'));
    const started = Date.now();
    let outcome: Record<string, unknown>;
    try {
      const result = await runJob(
        {
          jobId: `memory-${actionId.replace('.', '-')}`,
          actionId,
          inputs: [{ fileId: 'big', path: pdfPath, displayName: basename(pdfPath), sourceDir: dirname(pdfPath), format: 'pdf', bytes: size }],
          options: actionId === 'convert.jpeg' || actionId === 'convert.png' ? { dpi: 150 } : {},
          outputDir: out,
          settings: { pdfDpi: 150, jpegQuality: 85, webpQuality: 80, avifQuality: 60, heicQuality: 70 },
          limits: { ...DEFAULT_PROCESSING_LIMITS, pdfPageConcurrency: 2 },
        },
        {
          signal: new AbortController().signal,
          // Progress callbacks run between pages: sample there too (timers can starve during parsing).
          onProgress: () => {
            peak = Math.max(peak, rssMB());
                },
        },
      );
      outcome = { ok: true, outputs: result.outputs.length };
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearInterval(timer);
      peak = Math.max(peak, rssMB());
      await rm(out, { recursive: true, force: true });
    }
    runs.push({
      actionId,
      ...outcome,
      ms: Date.now() - started,
      rssBeforeMB: before,
      peakRssMB: peak,
      peakOverBeforeMB: peak - before,
    });
  }
  const line = {
    ok: runs.every((r) => (r as { ok: boolean }).ok),
    processType: (process as { type?: string }).type ?? null,
    electron: process.versions.electron ?? null,
    gcExposed: Boolean(gc),
    pdfMB: Math.round(size / MB),
    baselineRssMB: baseline,
    maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    runs,
  };
  process.stdout.write(`CONVERT_SMOKE ${JSON.stringify(line)}\n`, () => process.exit(line.ok ? 0 : 1));
}

main().catch((error: unknown) => {
  process.stdout.write(`CONVERT_SMOKE ${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`, () => process.exit(1));
});
