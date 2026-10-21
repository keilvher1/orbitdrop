/**
 * The real native helper (staged by scripts/build-native-*.mjs at
 * resources/helper/<platform>-<arch>/) driven by main: spawn, `ready`,
 * main's `configure` accepted without protocol errors, re-configure on a
 * settings change, `shutdown` on quit. Global drag is configured OFF
 * (`enabled: false`), so the helper observes nothing on the tester's desktop.
 * Skipped when no helper binary is staged.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { OrbitApi } from '@orbitdrop/contracts';
import { appDir, hooks, launchApp, windowOf } from './support';

declare global {
  interface Window {
    orbit: OrbitApi;
  }
}

const helperName = process.platform === 'win32' ? 'OrbitDropHelper.exe' : 'OrbitDropHelper';
const helperPath = join(appDir, 'resources', 'helper', `${process.platform}-${process.arch}`, helperName);

test.skip(!existsSync(helperPath), `no helper staged at ${helperPath}`);

function helperProcessCount(): number {
  if (process.platform === 'win32') return 0;
  try {
    return execFileSync('pgrep', ['-f', helperPath], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

test('the real helper accepts main’s configure and stops on quit', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-data-'));
  try {
    // Global drag off: the helper is configured but observes nothing.
    await mkdir(userData, { recursive: true });
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ version: 1, globalDrag: { enabled: false } }));
    const launched = await launchApp({ userData, env: { ORBITDROP_E2E_HELPER: '1' } });
    try {
      const h = hooks(launched.app);
      await expect
        .poll(async () => (await launched.app.evaluate(() => (globalThis as unknown as { __orbitdrop: { helperStatus(): { state: string } } }).__orbitdrop.helperStatus())).state, {
          timeout: 15_000,
        })
        .toBe('disabled');
      await h.openWindow('settings');
      const page = await windowOf(launched.app, 'settings');
      expect(await page.evaluate(() => window.orbit.getHelperStatus())).toEqual({ state: 'disabled' });
      // A settings change re-sends configure (locale) — still no protocol error.
      await h.updateSettings({ locale: 'en' });
      await page.waitForTimeout(500);
      expect(helperProcessCount()).toBe(1);
    } finally {
      await launched.close();
    }
    await expect.poll(() => helperProcessCount(), { timeout: 5000 }).toBe(0);
    const log = await readFile(join(userData, 'logs', 'main.log'), 'utf8');
    expect(log).toContain('native helper ready');
    expect(log).not.toMatch(/invalid helper message|helper reported an error|helper line exceeded|helper did not exit/);
    expect(log).not.toMatch(/native helper stopped/); // no crash/restart during the run
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
