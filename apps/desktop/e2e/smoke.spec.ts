import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { expect, test } from '@playwright/test';
import { appDir } from './support';

/**
 * `--smoke-test` the way scripts/package.mjs runs it on every package — here
 * on the built, unpackaged app and without the automation switches
 * (ORBITDROP_E2E off). Besides engines and conversions it must open one real
 * window (About), hidden, and prove that it rendered: a package whose windows
 * stay blank (e.g. the renderer file cannot be loaded) fails its smoke test.
 * The native helper is left out (ORBITDROP_DISABLE_HELPER, optional).
 */

interface SmokeWindow {
  ok: boolean;
  view: string;
  ms: number | null;
  loaded: boolean;
  preload: boolean;
  rendered: boolean;
  shown: boolean;
  error: string | null;
  consoleErrors: string[];
}

interface SmokeRun {
  readonly code: number | null;
  readonly report: { ok: boolean; window: SmokeWindow; conversion: { ok: boolean }; pdfConversion: { ok: boolean } } | null;
  readonly stderr: string;
}

function runSmoke(env: Record<string, string> = {}): Promise<SmokeRun> {
  const executable = require('electron') as unknown as string;
  // No automation or development switch from the test runner's environment (Windows: names are case-insensitive).
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ORBITDROP_') && key.toUpperCase() !== 'ELECTRON_RENDERER_URL'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [appDir, '--smoke-test', '--smoke-optional-helper'], {
      cwd: appDir,
      env: { ...base, ORBITDROP_DISABLE_HELPER: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`--smoke-test still running after 150 s; stderr: ${stderr.slice(-1000)}`));
    }, 150_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('ORBITDROP_SMOKE '));
      resolve({ code, report: line ? (JSON.parse(line.slice('ORBITDROP_SMOKE '.length)) as SmokeRun['report']) : null, stderr });
    });
  });
}

/** A local port nobody listens on (bound, then released). */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

test('--smoke-test opens a hidden window, checks that it really rendered, and reports it', async () => {
  const run = await runSmoke();
  expect(run.report, run.stderr.slice(-2000)).not.toBeNull();
  const report = run.report!;
  expect(report.window, JSON.stringify(report.window)).toMatchObject({ ok: true, view: 'about', loaded: true, preload: true, rendered: true, shown: false, error: null, consoleErrors: [] });
  expect(report.window.ms).toBeGreaterThan(0);
  expect(report.window.ms).toBeLessThan(15_000);
  expect(report.ok).toBe(true);
  expect(run.code).toBe(0);
});

test('--smoke-test fails when the window cannot load its page (a blank window)', async () => {
  // Development builds load the renderer from ELECTRON_RENDERER_URL when it is set (packaged builds never do).
  const port = await closedPort();
  const run = await runSmoke({ ELECTRON_RENDERER_URL: `http://127.0.0.1:${port}/` });
  expect(run.report, run.stderr.slice(-2000)).not.toBeNull();
  const report = run.report!;
  expect(report.window, JSON.stringify(report.window)).toMatchObject({ ok: false, loaded: false, rendered: false, shown: false });
  expect(report.window.error).toMatch(/^did-fail-load ERR_CONNECTION_REFUSED/);
  expect(report.conversion.ok && report.pdfConversion.ok).toBe(true); // the rest of the self test still passed
  expect(report.ok).toBe(false);
  expect(run.code).toBe(1);
});
