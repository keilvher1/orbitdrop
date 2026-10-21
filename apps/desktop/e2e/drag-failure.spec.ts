/**
 * A global-drag job whose output folder is read-only: with notifications off
 * nothing would tell the user, so main opens the Jobs window (without taking
 * focus), where the failed card offers "save to another folder". The drop
 * comes from the protocol-faithful stub helper (e2e/fixtures/stub-helper.mjs);
 * the read-only folder is a real chmod 555 folder.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { SETTINGS_VERSION } from '@orbitdrop/contracts';
import { appDir, hooks, launchApp, makeJpeg, windowOf } from './support';

test.skip(process.platform === 'win32', 'the stub helper is a shebang script; chmod 555 does not make a folder read-only on Windows');

test('a drag job that cannot write next to its file opens the Jobs window with "save to another folder"', async () => {
  const work = await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-files-'));
  const userData = await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-data-'));
  const locked = join(work, 'locked');
  try {
    await mkdir(locked);
    const photo = await makeJpeg(locked, 'photo.jpg', 400, 300);
    await chmod(locked, 0o555);
    // Notifications off: the Jobs window is the only signal.
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ version: SETTINGS_VERSION, notifications: false }));
    const launched = await launchApp({
      work,
      userData,
      env: {
        ORBITDROP_E2E_HELPER: '1',
        ORBITDROP_HELPER_PATH: join(appDir, 'e2e', 'fixtures', 'stub-helper.mjs'),
        STUB_DROPS: JSON.stringify([{ sessionId: 'sess_locked', actionId: 'convert.png', mode: 'convert', files: [photo] }]),
      },
    });
    try {
      const h = hooks(launched.app);
      await expect
        .poll(async () => (await h.jobs()).filter((j) => j.sessionId === 'sess_locked').map((j) => [j.state, j.error?.code]), { timeout: 60_000 })
        .toEqual([['failed', 'OUTPUT_DIR_NOT_WRITABLE']]);
      const jobsWindow = await windowOf(launched.app, 'jobs');
      const card = jobsWindow.locator('li.job-card').filter({ hasText: 'photo.jpg' });
      await expect(card.getByText('이 폴더에는 저장할 수 없습니다. 다른 폴더를 선택하세요.')).toBeVisible();
      await expect(card.getByRole('button', { name: '다른 폴더에 저장…' })).toBeVisible();
      expect(await launched.app.evaluate(() => (globalThis as unknown as { __orbitdrop: { notifications(): unknown[] } }).__orbitdrop.notifications())).toEqual([]);
      // Opened once for the drop, not for every later change.
      expect((await h.windows()).filter((w) => w.kind === 'jobs')).toHaveLength(1);
    } finally {
      await launched.close();
    }
  } finally {
    await chmod(locked, 0o755).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
