import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILE_FORMATS, OrbitError, type ActionId } from '@orbitdrop/contracts';
import type { OrbitApp } from './app';
import { describeError } from './log';
import { probeHasEngines } from './processing/probe-fallback';
import { withTimeout } from './util/concurrency';
import { readJpegSize } from './util/jpeg';
import { minimalPdf, readPngSize } from './util/pdf';
import { encodePng, testPattern } from './util/png';

/**
 * `--smoke-test` (docs/architecture.md): no windows, no tray. Probes the
 * engines in a worker, starts the native helper and waits up to 5 s for
 * `ready`, converts a generated PNG to JPG in a temp folder through the real
 * pipeline (FileRegistry → SubmissionService → JobManager → ProcessorPool →
 * processors) — and, as an extra check, renders a generated one-page PDF to
 * PNG (PDF.js inside the utility process) — prints exactly one
 * `ORBITDROP_SMOKE {json}` line to stdout and returns the exit code (0 ok,
 * 1 failed). Every field reports what actually happened.
 */

export interface ConversionReport {
  ok: boolean;
  actionId: ActionId;
  state: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  ms: number | null;
  error: string | null;
}

export interface SmokeReport {
  ok: boolean;
  version: string;
  platform: string;
  arch: string;
  packaged: boolean;
  durationMs: number;
  probe: {
    ok: boolean;
    decode: string[];
    encode: string[];
    pdfRender: boolean;
    pdfText: boolean;
    enabledActions: string[];
    errors: string[];
  };
  helper: {
    ok: boolean;
    required: boolean;
    found: boolean;
    source: string | null;
    ready: boolean;
    version: string | null;
    globalDrag: { available: boolean; reason: string | null } | null;
    error: string | null;
  };
  /** PNG → JPG (the conversion the architecture requires). */
  conversion: ConversionReport;
  /** PDF → PNG at the default 300 DPI (PDF.js page rendering in the worker). */
  pdfConversion: ConversionReport;
}

const IMAGE_W = 64;
const IMAGE_H = 48;
/** 72 × 36 pt → 300 × 150 px at 300 DPI. */
const PDF_W_PT = 72;
const PDF_H_PT = 36;

function emptyConversion(actionId: ActionId): ConversionReport {
  return { ok: false, actionId, state: null, width: null, height: null, bytes: null, ms: null, error: null };
}

export async function runSmokeTest(orbit: OrbitApp, version: string, packaged: boolean): Promise<number> {
  const started = Date.now();
  const report: SmokeReport = {
    ok: false,
    version,
    platform: process.platform,
    arch: process.arch,
    packaged,
    durationMs: 0,
    probe: { ok: false, decode: [], encode: [], pdfRender: false, pdfText: false, enabledActions: [], errors: [] },
    helper: {
      ok: false,
      required: !orbit.options.smokeOptionalHelper,
      found: false,
      source: null,
      ready: false,
      version: null,
      globalDrag: null,
      error: null,
    },
    conversion: emptyConversion('convert.jpeg'),
    pdfConversion: emptyConversion('convert.png'),
  };

  let workDir: string | null = null;
  try {
    await orbit.startCore();
    const helperCheck = checkHelper(orbit, report);

    const snapshot = await orbit.capabilities.get();
    const { probe } = snapshot;
    report.probe = {
      ok: orbit.capabilities.lastProbeSucceeded && probeHasEngines(probe),
      decode: FILE_FORMATS.filter((f) => probe.formats[f]?.input),
      encode: FILE_FORMATS.filter((f) => probe.formats[f]?.output),
      pdfRender: probe.pdfRender,
      pdfText: probe.pdfText,
      enabledActions: Object.values(snapshot.actions)
        .filter((a) => a.enabled)
        .map((a) => a.actionId),
      errors: probe.errors.slice(0, 8).map((e) => e.slice(0, 300)),
    };

    workDir = await mkdtemp(join(tmpdir(), 'orbitdrop-smoke-'));
    const image = join(workDir, 'smoke-image.png');
    await writeFile(image, encodePng(IMAGE_W, IMAGE_H, testPattern(IMAGE_W, IMAGE_H)));
    const pdf = join(workDir, 'smoke-page.pdf');
    await writeFile(pdf, minimalPdf(PDF_W_PT, PDF_H_PT));

    await Promise.all([
      convert(orbit, image, report.conversion, (data) => readJpegSize(data), { width: IMAGE_W, height: IMAGE_H }, 'JPEG'),
      convert(orbit, pdf, report.pdfConversion, (data) => readPngSize(data), { width: 300, height: 150 }, 'PNG'),
    ]);
    await helperCheck;
  } catch (error) {
    report.conversion.error ??= describeError(error);
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  report.ok = report.probe.ok && report.conversion.ok && report.pdfConversion.ok && (report.helper.ok || !report.helper.required);
  report.durationMs = Date.now() - started;
  await new Promise<void>((resolve) => process.stdout.write(`ORBITDROP_SMOKE ${JSON.stringify(report)}\n`, () => resolve()));
  return report.ok ? 0 : 1;
}

async function checkHelper(orbit: OrbitApp, report: SmokeReport): Promise<void> {
  const helper = orbit.helper;
  if (!helper) {
    report.helper.error = 'helper disabled (ORBITDROP_DISABLE_HELPER)';
    return;
  }
  try {
    await helper.start();
    const location = helper.helperLocation;
    report.helper.found = location !== null;
    report.helper.source = location?.source ?? null;
    if (!location) {
      report.helper.error = 'helper binary not found';
      return;
    }
    const ready = await helper.waitForReady(5000);
    if (!ready) {
      const status = helper.status;
      report.helper.error = status.state === 'crashed' || status.state === 'unavailable' ? status.reason : 'no ready message within 5 s';
      return;
    }
    report.helper.ready = true;
    report.helper.version = ready.helperVersion;
    report.helper.globalDrag = { available: ready.globalDrag.available, reason: ready.globalDrag.reason ?? null };
    report.helper.ok = true;
  } catch (error) {
    report.helper.error = describeError(error);
  } finally {
    await helper.stop().catch(() => undefined);
  }
}

async function convert(
  orbit: OrbitApp,
  input: string,
  report: ConversionReport,
  readSize: (data: Uint8Array) => { width: number; height: number } | null,
  expected: { readonly width: number; readonly height: number },
  label: string,
): Promise<void> {
  const started = Date.now();
  try {
    const selection = await orbit.files.registerPaths([input], 'test');
    const result = await orbit.submission.submit({ selectionId: selection.selectionId, actionId: report.actionId }, { source: 'test', sessionId: null });
    if (result.kind !== 'jobs') {
      report.error = result.kind === 'rejected' ? `${result.error.code}: ${result.error.message}` : 'unexpected editor result';
      return;
    }
    const jobId = result.jobIds[0];
    if (!jobId) {
      report.error = 'no job created';
      return;
    }
    const job = await withTimeout(orbit.jobs.waitFor(jobId), 90_000, () => new OrbitError('TIMEOUT', 'conversion did not finish within 90 s'));
    report.state = job.state;
    report.ms = Date.now() - started;
    if (job.state !== 'completed') {
      report.error = job.error ? `${job.error.code}: ${job.error.message}`.slice(0, 300) : `job ${job.state}`;
      return;
    }
    const output = job.outputs[0];
    const path = output ? orbit.outputs.get(output.outputId)?.path : undefined;
    if (!path) {
      report.error = 'job completed without an output file';
      return;
    }
    const data = await readFile(path);
    const size = readSize(data);
    report.bytes = data.byteLength;
    report.width = size?.width ?? null;
    report.height = size?.height ?? null;
    if (!size) report.error = `output is not a ${label}`;
    else if (size.width !== expected.width || size.height !== expected.height) report.error = `unexpected size ${size.width}x${size.height}`;
    else report.ok = true;
  } catch (error) {
    report.error = describeError(error);
  }
}
