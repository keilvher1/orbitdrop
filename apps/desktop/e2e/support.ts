import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import type { ActionId, ErrorCode, FileSelection, JobSnapshot, SubmitActionResult, WheelMode, WindowContext, WindowKind } from '@orbitdrop/contracts';

// apps/desktop is a CommonJS package, so Playwright compiles these files to CJS (__dirname/require exist).
export const appDir = resolve(__dirname, '..');
export const repoRoot = resolve(appDir, '../..');
export const screenshotDir = join(repoRoot, 'docs', 'screenshots');

export interface Launched {
  readonly app: ElectronApplication;
  readonly userData: string;
  readonly work: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  readonly env?: Record<string, string>;
  /** Reuse an app-data / files folder (e.g. to test a restart); it is then not deleted on close. */
  readonly userData?: string;
  readonly work?: string;
}

/** Launch the built app in automation mode with a fresh app-data folder. */
export async function launchApp(options: LaunchOptions = {}): Promise<Launched> {
  if (!existsSync(join(appDir, 'out', 'main', 'index.js'))) throw new Error('Build the app first: electron-vite build');
  const env = options.env ?? {};
  const userData = options.userData ?? (await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-data-')));
  const work = options.work ?? (await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-files-')));
  const executablePath = require('electron') as unknown as string;
  const app = await electron.launch({
    executablePath,
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, ORBITDROP_E2E: '1', ORBITDROP_USER_DATA_DIR: userData, ...env } as Record<string, string>,
    timeout: 60_000,
  });
  app.process().stderr?.on('data', (chunk: Buffer) => {
    if (process.env.ORBITDROP_E2E_VERBOSE === '1') process.stderr.write(chunk);
  });
  return {
    app,
    userData,
    work,
    close: async () => {
      await app.close().catch(() => undefined);
      if (!options.userData) await rm(userData, { recursive: true, force: true });
      if (!options.work) await rm(work, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ main-process hooks (ORBITDROP_E2E=1)

type Hooks = {
  registerPaths(paths: string[]): Promise<FileSelection>;
  openPicker(paths: string[], mode?: WheelMode): Promise<FileSelection>;
  openWindow(kind: 'jobs' | 'settings' | 'dropzone' | 'about' | 'welcome'): void;
  waitForJob(jobId: string): Promise<JobSnapshot>;
  jobs(): JobSnapshot[];
  windows(): { kind: WindowKind; context: WindowContext; windowId: number; url: string; unsaved: boolean }[];
  outputPath(outputId: string): string | null;
  updateSettings(patch: unknown): Promise<unknown>;
  trayMenu(): string[] | null;
  submit(paths: string[], actionId: ActionId, options?: unknown): Promise<SubmitActionResult>;
  failNextJobs(codes: ErrorCode[]): Promise<void>;
  holdNextJob(): Promise<void>;
  releaseHeldJobs(): Promise<number>;
};

export function hooks(app: ElectronApplication) {
  const call = <T>(name: keyof Hooks, ...args: unknown[]): Promise<T> =>
    app.evaluate(
      async (_electron, [hookName, hookArgs]) => {
        const target = (globalThis as unknown as { __orbitdrop: Record<string, (...a: unknown[]) => unknown> }).__orbitdrop;
        return target[hookName as string]!(...(hookArgs as unknown[]));
      },
      [name, args] as const,
    ) as Promise<T>;
  return {
    registerPaths: (paths: string[]) => call<FileSelection>('registerPaths', paths),
    openPicker: (paths: string[], mode: WheelMode = 'convert') => call<FileSelection>('openPicker', paths, mode),
    openWindow: (kind: 'jobs' | 'settings' | 'dropzone' | 'about' | 'welcome') => call<void>('openWindow', kind),
    waitForJob: (jobId: string) => call<JobSnapshot>('waitForJob', jobId),
    jobs: () => call<JobSnapshot[]>('jobs'),
    windows: () => call<Awaited<ReturnType<Hooks['windows']>>>('windows'),
    outputPath: (outputId: string) => call<string | null>('outputPath', outputId),
    updateSettings: (patch: unknown) => call<unknown>('updateSettings', patch),
    trayMenu: () => call<string[] | null>('trayMenu'),
    /** Register files and submit an action (as if chosen in a picker). */
    submit: (paths: string[], actionId: ActionId, options?: unknown) => call<SubmitActionResult>('submit', paths, actionId, ...(options === undefined ? [] : [options])),
    /** The next job attempts fail with these codes (E2E fault injection in main). */
    failNextJobs: (codes: ErrorCode[]) => call<void>('failNextJobs', codes),
    /** The next job attempt stays 'running' until releaseHeldJobs() or a cancel. */
    holdNextJob: () => call<void>('holdNextJob'),
    releaseHeldJobs: () => call<number>('releaseHeldJobs'),
  };
}

/** The page of the window with the given kind (waits until it exists and the renderer answered). */
export async function windowOf(app: ElectronApplication, kind: WindowKind, timeoutMs = 20_000): Promise<Page> {
  const started = Date.now();
  let seen: string[] = [];
  while (Date.now() - started < timeoutMs) {
    seen = [];
    for (const page of app.windows()) {
      if (page.isClosed()) continue;
      try {
        const context = await page.evaluate(() => (window as unknown as { orbit?: { getWindowContext(): Promise<WindowContext> } }).orbit?.getWindowContext());
        seen.push(`${page.url().slice(-40)}=${JSON.stringify(context ?? null)}`);
        if (context?.kind === kind) return page;
      } catch (error) {
        seen.push(`${page.url().slice(-40)}=error:${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}`);
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const registered = await hooks(app)
    .windows()
    .then((list) => list.map((w) => `${w.kind}:${w.url.slice(-30)}`).join(', '))
    .catch(() => 'unavailable');
  throw new Error(`no ${kind} window within ${timeoutMs} ms; pages: [${seen.join(' | ')}]; main windows: [${registered}]`);
}

/** The page of the editor window showing `editorId`. */
export async function editorWindowOf(app: ElectronApplication, editorId: string, timeoutMs = 20_000): Promise<Page> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const page of app.windows()) {
      if (page.isClosed()) continue;
      try {
        const context = await page.evaluate(() => (window as unknown as { orbit?: { getWindowContext(): Promise<WindowContext> } }).orbit?.getWindowContext());
        if (context?.kind === 'editor' && context.editorId === editorId) return page;
      } catch {
        // page navigating or closing
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no editor window for ${editorId} within ${timeoutMs} ms`);
}

/** Wait until a new job appears (not in `known`) and finishes; returns its snapshot. */
export async function waitForNewJob(app: ElectronApplication, known: ReadonlySet<string>, actionId: ActionId, timeoutMs = 90_000): Promise<JobSnapshot> {
  const h = hooks(app);
  let job: JobSnapshot | undefined;
  await expect
    .poll(
      async () => {
        job = (await h.jobs()).find((j) => !known.has(j.jobId) && j.actionId === actionId);
        return job?.state ?? 'none';
      },
      { timeout: timeoutMs, intervals: [100, 250, 500] },
    )
    .toMatch(/completed|failed|cancelled/);
  return job!;
}

export async function jobIds(app: ElectronApplication): Promise<Set<string>> {
  return new Set((await hooks(app).jobs()).map((j) => j.jobId));
}

// ------------------------------------------------------------------ fixtures

/** "Page 001.pdf": one US Letter page with text and a coloured block, like the reference recording. */
export async function makePdf(dir: string, name = 'Page 001.pdf'): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 54, y: 600, width: 504, height: 120, color: rgb(0.95, 0.33, 0.17) });
  page.drawText('Nurse Turnover: Retention of the Staff', { x: 54, y: 740, size: 16, font, color: rgb(0, 0, 0) });
  for (let i = 0; i < 30; i += 1) page.drawText(`Line ${i + 1}: the quick brown fox jumps over the lazy dog.`, { x: 54, y: 570 - i * 16, size: 10, font });
  const path = join(dir, name);
  await writeFile(path, await doc.save());
  return path;
}

/** A photo-like JPEG (gradient + shapes). */
export async function makeJpeg(dir: string, name: string, width: number, height: number): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2F5BF6"/><stop offset="1" stop-color="#36D1DC"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="#F2552C"/></svg>`;
  const path = join(dir, name);
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(path);
  return path;
}

// Outputs are read into memory first: given a path, libvips keeps the file open in its cache, and on
// Windows an open file cannot be deleted (the folder clean-up after a test failed with EBUSY).
export async function imageMeta(path: string): Promise<{ format: string; width: number; height: number }> {
  const meta = await sharp(await readFile(path)).metadata();
  return { format: meta.format ?? '', width: meta.width ?? 0, height: meta.height ?? 0 };
}

export async function pixel(path: string, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(await readFile(path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(y) * info.width + Math.floor(x)) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}
