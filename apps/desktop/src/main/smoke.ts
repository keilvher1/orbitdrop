import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { FILE_FORMATS, OrbitError, type ActionId } from '@orbitdrop/contracts';
import { WINDOW_PROBE, describeProbe, judgeWindow, type WindowProbe } from '../shared/window-probe';
import type { OrbitApp } from './app';
import { describeError } from './log';
import { probeHasEngines } from './processing/probe-fallback';
import { delay, withTimeout } from './util/concurrency';
import { readJpegSize } from './util/jpeg';
import { minimalPdf, readPngSize } from './util/pdf';
import { encodePng, testPattern } from './util/png';

/**
 * `--smoke-test` (docs/architecture.md): no tray, nothing on screen. Probes
 * the engines in a worker, starts the native helper and waits up to 5 s for
 * `ready`, converts a generated PNG to JPG in a temp folder through the real
 * pipeline (FileRegistry → SubmissionService → JobManager → ProcessorPool →
 * processors) — and, as an extra check, renders a generated one-page PDF to
 * PNG (PDF.js inside the utility process) — and opens the About window the
 * way every window opens (same BrowserWindow options, renderer file, preload,
 * IPC), hidden: it must load and render (`window`; a packaged app whose
 * windows stay blank fails here). Prints exactly one `ORBITDROP_SMOKE {json}`
 * line to stdout and returns the exit code (0 ok, 1 failed). Every field
 * reports what actually happened.
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
  /** The About window, opened hidden like any window: loaded, preload ran, rendered with main's data. */
  window: WindowReport;
}

export interface WindowReport {
  /** loaded && preload && rendered, never shown, no error. */
  ok: boolean;
  view: 'about';
  /** Opening the window → view rendered. */
  ms: number | null;
  /** The renderer's page finished loading (did-finish-load, no did-fail-load). */
  loaded: boolean;
  /** The sandboxed preload ran (window.orbit exists). */
  preload: boolean;
  /** React rendered the About view with the version main sent (IPC round trip) and its stylesheets loaded. */
  rendered: boolean;
  /** The window appeared on screen at some point (must stay false). */
  shown: boolean;
  error: string | null;
  /** First console errors of the page (e.g. CSP violations), for diagnosis; they do not fail the check. */
  consoleErrors: string[];
}

/** The hidden window must have rendered within this time. */
export const WINDOW_TIMEOUT_MS = 15_000;
/**
 * The x64 macOS build gets longer: on Apple silicon it runs under Rosetta 2, whose first launch
 * translates Electron's x86_64 code while the engine probe and the helper start at the same time
 * (the probe already gets 90 s for that). Measured: 6.7 s on the development Mac; on GitHub's macOS
 * runner (a VM) the window was still loading after 15 s, while every other check passed. A blank
 * window still fails: this only bounds how long the check waits for the page.
 */
export const WINDOW_TIMEOUT_X64_MAC_MS = 60_000;

function windowTimeoutMs(): number {
  return process.platform === 'darwin' && process.arch === 'x64' ? WINDOW_TIMEOUT_X64_MAC_MS : WINDOW_TIMEOUT_MS;
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
    window: { ok: false, view: 'about', ms: null, loaded: false, preload: false, rendered: false, shown: false, error: null, consoleErrors: [] },
  };

  let workDir: string | null = null;
  try {
    await orbit.startCore();
    const helperCheck = checkHelper(orbit, report);
    const windowCheck = checkWindow(orbit, report.window, version);

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
    await Promise.all([helperCheck, windowCheck]);
  } catch (error) {
    report.conversion.error ??= describeError(error);
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  report.ok = report.probe.ok && report.conversion.ok && report.pdfConversion.ok && report.window.ok && (report.helper.ok || !report.helper.required);
  report.durationMs = Date.now() - started;
  await new Promise<void>((resolve) => process.stdout.write(`ORBITDROP_SMOKE ${JSON.stringify(report)}\n`, () => resolve()));
  return report.ok ? 0 : 1;
}

/**
 * Opens the About window hidden — through the WindowManager, so with the
 * BrowserWindow options, renderer file (file:// inside app.asar when
 * packaged), preload, CSP and IPC every window uses — and waits until it
 * rendered: the page loaded, the preload ran, and the view shows the version
 * main sent. Fails on did-fail-load, preload-error, a renderer crash, an error
 * the page shows, or WINDOW_TIMEOUT_MS (x64 macOS: WINDOW_TIMEOUT_X64_MAC_MS). The window is never shown and is
 * closed again.
 */
async function checkWindow(orbit: OrbitApp, report: WindowReport, version: string): Promise<void> {
  const started = Date.now();
  let window: BrowserWindow | null = null;
  try {
    window = orbit.startWindows({ hidden: true }).open('about');
    const contents = window.webContents;
    let failure: string | null = null;
    // A failed load still ends in did-finish-load (of Chromium's error page): loaded = finished, never failed.
    let finished = false;
    let loadFailed = false;
    window.on('show', () => {
      report.shown = true;
    });
    contents.on('did-finish-load', () => {
      finished = true;
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame) return;
      loadFailed = true;
      failure ??= `did-fail-load ${description} (${code})`;
    });
    contents.on('preload-error', (_event, _path, error) => {
      failure ??= `preload-error ${describeError(error)}`;
    });
    contents.on('render-process-gone', (_event, details) => {
      failure ??= `render-process-gone ${details.reason}`;
    });
    contents.on('console-message', (details) => {
      if (details.level === 'error' && report.consoleErrors.length < 5) report.consoleErrors.push(details.message.slice(0, 300));
    });

    let probe: WindowProbe | null = null;
    const timeoutMs = windowTimeoutMs();
    while (failure === null && Date.now() - started < timeoutMs) {
      report.loaded = finished && !loadFailed;
      if (report.loaded && !contents.isDestroyed()) {
        // Bounded: a hung or crashed renderer never answers.
        probe = await withTimeout(contents.executeJavaScript(WINDOW_PROBE) as Promise<WindowProbe>, 2000, () => new OrbitError('TIMEOUT', 'page did not answer')).catch(() => null);
        if (probe) {
          report.preload = probe.preload;
          const verdict = judgeWindow(probe, version);
          if (verdict.error !== null) failure = verdict.error;
          else if (verdict.rendered) {
            report.rendered = true;
            report.ms = Date.now() - started;
            break;
          }
        }
      }
      if (failure === null) await delay(100);
    }
    report.loaded = finished && !loadFailed;
    if (failure !== null) report.error = failure;
    else if (!report.rendered) report.error = `not rendered within ${timeoutMs / 1000} s (loaded ${report.loaded}, ${describeProbe(probe)})`;
  } catch (error) {
    report.error = describeError(error);
  } finally {
    if (window && !window.isDestroyed()) {
      report.shown ||= window.isVisible();
      window.destroy();
    }
  }
  report.ok = report.loaded && report.preload && report.rendered && !report.shown && report.error === null;
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
