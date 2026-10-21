/**
 * App shell in a real Electron run: every window kind is a sandboxed,
 * context-isolated panel with the right WindowContext; resize requests are
 * clamped to the work area; settings changes reach every window and the tray
 * menu; job history survives a restart.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { OrbitApi, Settings } from '@orbitdrop/contracts';
import { hooks, imageMeta, launchApp, makeJpeg, screenshotDir, windowOf } from './support';

declare global {
  interface Window {
    orbit: OrbitApi;
  }
}

test('every window kind opens sandboxed with its context; resize is clamped; settings reach windows and the tray', async () => {
  const launched = await launchApp({ env: { ORBITDROP_E2E_TRAY: '1' } });
  try {
    const h = hooks(launched.app);
    const kinds = ['dropzone', 'settings', 'about', 'jobs'] as const;
    for (const kind of kinds) await h.openWindow(kind);
    for (const kind of kinds) {
      const page = await windowOf(launched.app, kind);
      expect(await page.evaluate(() => window.orbit.getWindowContext())).toEqual({ kind });
    }
    // opening a single-instance window again focuses it instead of creating another
    await h.openWindow('settings');
    expect((await h.windows()).filter((w) => w.kind === 'settings')).toHaveLength(1);

    // Renderer processes of our windows are OS-sandboxed (process metrics) and show only our page.
    const windows = await launched.app.evaluate(({ BrowserWindow, app }) => {
      const metrics = app.getAppMetrics();
      return BrowserWindow.getAllWindows().map((w) => {
        const pid = w.webContents.getOSProcessId();
        const metric = metrics.find((m) => m.pid === pid);
        return { url: w.webContents.getURL(), type: metric?.type, sandboxed: metric?.sandboxed, visible: w.isVisible() };
      });
    });
    expect(windows).toHaveLength(kinds.length);
    for (const w of windows) {
      expect(w).toMatchObject({ type: 'Tab', visible: true });
      if (process.platform === 'darwin' || process.platform === 'win32') expect(w.sandboxed).toBe(true);
      expect(w.url).toMatch(/^file:\/\/.*\/out\/renderer\/index\.html$/);
    }
    for (const kind of kinds) {
      const page = await windowOf(launched.app, kind);
      expect(await page.evaluate(() => [typeof (window as unknown as { require?: unknown }).require, typeof (window as unknown as { process?: unknown }).process])).toEqual([
        'undefined',
        'undefined',
      ]);
    }
    const dropzone = (await h.windows()).find((w) => w.kind === 'dropzone')!;
    const onTop = await launched.app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isAlwaysOnTop() ?? false, dropzone.windowId);
    expect(onTop).toBe(true);

    // resize requests (4000 is the contract maximum) are clamped to the display's work area
    const settingsPage = await windowOf(launched.app, 'settings');
    const settingsId = (await h.windows()).find((w) => w.kind === 'settings')!.windowId;
    await settingsPage.evaluate(() => window.orbit.resizeWindow(4000, 4000));
    await settingsPage.waitForTimeout(300);
    const geometry = await launched.app.evaluate(({ BrowserWindow, screen }, id) => {
      const w = BrowserWindow.fromId(id)!;
      const bounds = w.getBounds();
      return { bounds, work: screen.getDisplayMatching(bounds).workArea };
    }, settingsId);
    expect(geometry.bounds.x).toBeGreaterThanOrEqual(geometry.work.x);
    expect(geometry.bounds.y).toBeGreaterThanOrEqual(geometry.work.y);
    expect(geometry.bounds.x + geometry.bounds.width).toBeLessThanOrEqual(geometry.work.x + geometry.work.width);
    expect(geometry.bounds.y + geometry.bounds.height).toBeLessThanOrEqual(geometry.work.y + geometry.work.height);
    expect(geometry.bounds.width).toBeGreaterThan(600);
    await settingsPage.evaluate(() => window.orbit.resizeWindow(520, 620));
    await settingsPage.waitForTimeout(300);

    for (const kind of ['dropzone', 'settings', 'about'] as const) {
      const page = await windowOf(launched.app, kind);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(screenshotDir, `desktop-main-${kind}.png`) });
    }

    // tray menu (Korean default)
    const korean = await h.trayMenu();
    expect(korean).toEqual(expect.arrayContaining(['파일 열기…', 'Drop Zone 닫기', '최근 작업', '작업 창', '전역 드래그 사용', '설정…', '정보', '종료']));

    // a settings change from one window reaches the others and the tray
    const dropzonePage = await windowOf(launched.app, 'dropzone');
    await dropzonePage.evaluate(() => {
      (window as unknown as { __settingsSeen: Settings[] }).__settingsSeen = [];
      window.orbit.onSettingsChanged((s) => (window as unknown as { __settingsSeen: Settings[] }).__settingsSeen.push(s));
    });
    const updated = await settingsPage.evaluate(() => window.orbit.updateSettings({ locale: 'en', pdf: { dpi: 150 } }));
    expect(updated).toMatchObject({ locale: 'en', pdf: { dpi: 150 } });
    await expect
      .poll(() => dropzonePage.evaluate(() => (window as unknown as { __settingsSeen: Settings[] }).__settingsSeen.map((s) => s.locale)))
      .toContain('en');
    expect(await h.trayMenu()).toEqual(expect.arrayContaining(['Open File…', 'Close Drop Zone', 'Recent Jobs', 'Quit']));
    const invalid = await settingsPage.evaluate(() =>
      window.orbit.updateSettings({ processing: { concurrency: 64 } }).then(
        () => 'accepted',
        (e: Error) => e.message,
      ),
    );
    expect(invalid).toMatch(/^INVALID_OPTIONS: /);
  } finally {
    await launched.close();
  }
});

test('hung reads cannot stall file access in main (libuv pool sized before first use)', async () => {
  test.skip(process.platform === 'win32', 'uses POSIX FIFOs to block pool threads');
  const launched = await launchApp();
  try {
    const result = await launched.app.evaluate(async () => {
      // Six opens of FIFOs without a writer each block one libuv pool thread, like hung cloud/network reads.
      const getModule = (process as unknown as { getBuiltinModule(id: string): unknown }).getBuiltinModule;
      const fs = getModule('node:fs') as typeof import('node:fs');
      const fsp = getModule('node:fs/promises') as typeof import('node:fs/promises');
      const os = getModule('node:os') as typeof import('node:os');
      const path = getModule('node:path') as typeof import('node:path');
      const cp = getModule('node:child_process') as typeof import('node:child_process');
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitdrop-uv-'));
      const fifos = Array.from({ length: 6 }, (_, i) => path.join(dir, `f${i}`));
      for (const fifo of fifos) cp.execFileSync('mkfifo', [fifo]);
      const opens = fifos.map((fifo) => fsp.open(fifo, 'r'));
      await sleep(200);
      const stat = await Promise.race([fsp.stat(dir).then(() => 'ok'), sleep(1500).then(() => 'blocked')]);
      for (const fifo of fifos) {
        try {
          fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        } catch {
          // no reader left
        }
      }
      for (const outcome of await Promise.allSettled(opens)) if (outcome.status === 'fulfilled') await outcome.value.close();
      for (const fifo of fifos) fs.unlinkSync(fifo);
      fs.rmdirSync(dir);
      return { size: process.env.UV_THREADPOOL_SIZE, stat };
    });
    expect(result).toEqual({ size: '16', stat: 'ok' });
  } finally {
    await launched.close();
  }
});

test('job history survives a restart and powers the jobs list', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-data-'));
  const work = await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-files-'));
  try {
    const first = await launchApp({ userData, work });
    let jobId: string;
    try {
      const photo = await makeJpeg(work, 'holiday photo.jpg', 640, 480);
      const selection = await hooks(first.app).registerPaths([photo]);
      await hooks(first.app).openWindow('jobs');
      const page = await windowOf(first.app, 'jobs');
      const result = await page.evaluate((id) => window.orbit.submitAction({ selectionId: id, actionId: 'convert.webp' }), selection.selectionId);
      if (result.kind !== 'jobs') throw new Error(`expected jobs, got ${result.kind}`);
      jobId = result.jobIds[0]!;
      expect((await hooks(first.app).waitForJob(jobId)).state).toBe('completed');
      expect(await imageMeta(join(work, 'holiday photo.webp'))).toEqual({ format: 'webp', width: 640, height: 480 });
    } finally {
      await first.close();
    }

    const second = await launchApp({ userData, work });
    try {
      await hooks(second.app).openWindow('jobs');
      const page = await windowOf(second.app, 'jobs');
      const jobs = await page.evaluate(() => window.orbit.listJobs());
      const restored = jobs.find((j) => j.jobId === jobId);
      expect(restored).toMatchObject({ state: 'completed', actionId: 'convert.webp', inputName: 'holiday photo.jpg' });
      expect(restored!.outputs[0]).toMatchObject({ name: 'holiday photo.webp', format: 'webp', width: 640, height: 480 });
      expect(await hooks(second.app).outputPath(restored!.outputs[0]!.outputId)).toBe(join(work, 'holiday photo.webp'));
    } finally {
      await second.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});
