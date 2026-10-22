/**
 * App lifecycle in the real app (no synthesized OS input; the OS events are
 * emitted on Electron's own emitters from the main process):
 *  - a second launch with files opens the picker for them, after FileRegistry
 *    validation; without files it shows the Drop Zone; macOS open-file too;
 *  - sleep / screen lock cancel an open drag session in the helper (stub),
 *    resume / unlock check the helper again;
 *  - corrupt settings and history: kept aside, defaults, a notice, no crash;
 *  - quitting while a job runs: cancelled, no orphan worker or helper, no temp file;
 *  - an app data folder that cannot be written is reported, not a silent quit.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { DEFAULT_SETTINGS, type FileSelection, type OrbitApi } from '@orbitdrop/contracts';
import { appDir, hooks, launchApp, makeJpeg, makePdf, windowOf } from './support';

declare global {
  interface Window {
    orbit: OrbitApi;
  }
}

/** The selection the picker window shows (names only — the renderer never sees paths). */
async function pickerSelection(app: ElectronApplication, previous?: string): Promise<FileSelection> {
  let selectionId = '';
  await expect
    .poll(async () => {
      const picker = (await hooks(app).windows()).find((w) => w.context.kind === 'picker' && w.context.selectionId !== previous);
      selectionId = picker?.context.kind === 'picker' ? picker.context.selectionId : '';
      return selectionId !== '';
    })
    .toBe(true);
  const page = await windowOf(app, 'picker');
  return page.evaluate((id) => window.orbit.getSelection(id), selectionId);
}

test('a second launch with files opens them in the picker (validated); without files the Drop Zone; macOS open-file too', async () => {
  const launched = await launchApp();
  try {
    // A tray app: starting it opens no window at all (no dashboard).
    expect(await hooks(launched.app).windows()).toEqual([]);
    expect(launched.app.windows()).toHaveLength(0);
    await makeJpeg(launched.work, 'photo.jpg', 640, 480);
    const pdf = await makePdf(launched.work);
    const emitSecondInstance = (argv: string[]) =>
      launched.app.evaluate(({ app }, args) => {
        app.emit('second-instance', {}, args.argv, args.cwd);
      }, { argv, cwd: launched.work });

    // Relative path resolved against the second launch's folder; switches ignored; a missing file is explained.
    await emitSecondInstance(['/Applications/OrbitDrop.app/Contents/MacOS/OrbitDrop', '--some-switch', 'photo.jpg', 'missing.png']);
    const first = await pickerSelection(launched.app);
    expect(first.source).toBe('openDialog');
    expect(first.files.map((f) => f.name)).toEqual(['photo.jpg', 'missing.png']);
    expect(first.files[0]!.problem).toBeUndefined();
    expect(first.files[1]!.problem?.code).toBe('FILE_NOT_FOUND');
    expect(JSON.stringify(first)).not.toContain(launched.work);

    // No files: the Drop Zone.
    await emitSecondInstance(['/Applications/OrbitDrop.app/Contents/MacOS/OrbitDrop', '--some-switch']);
    await windowOf(launched.app, 'dropzone');

    if (process.platform === 'darwin') {
      // open-file comes once per file; one hand-over opens one picker with every file.
      await launched.app.evaluate(({ app }, paths) => {
        for (const path of paths) app.emit('open-file', { preventDefault: () => undefined }, path);
      }, [join(launched.work, 'photo.jpg'), pdf]);
      const handedOver = await pickerSelection(launched.app, first.selectionId);
      expect(handedOver.files.map((f) => f.name)).toEqual(['photo.jpg', 'Page 001.pdf']);
    }
  } finally {
    await launched.close();
  }
});

test('sleep and screen lock cancel the open drag session; resume and unlock re-check the helper', async () => {
  test.skip(process.platform === 'win32', 'the stub helper is a shebang script');
  const logs = await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-helper-'));
  const stubLog = join(logs, 'stub.log');
  const launched = await launchApp({
    env: {
      ORBITDROP_E2E_HELPER: '1',
      ORBITDROP_HELPER_PATH: join(appDir, 'e2e', 'fixtures', 'stub-helper.mjs'),
      STUB_LOG: stubLog,
      STUB_OPEN_SESSION: 'sess_open',
    },
  });
  const received = async (): Promise<{ type: string; sessionId?: string }[]> =>
    (await readFile(stubLog, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; sessionId?: string });
  const count = async (type: string) => (await received()).filter((m) => m.type === type).length;
  try {
    await expect.poll(async () => (await launched.app.evaluate(() => (globalThis as unknown as { __orbitdrop: { helperStatus(): { state: string } } }).__orbitdrop.helperStatus())).state).toBe('running');
    await expect.poll(() => count('configure')).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 600)); // the stub opens its session 100 ms after configure

    await launched.app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('lock-screen');
    });
    await expect.poll(async () => (await received()).filter((m) => m.type === 'cancelSession').map((m) => m.sessionId)).toEqual(['sess_open']);
    await launched.app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('suspend'); // the helper already answered `cancelled`: nothing more to cancel
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await count('cancelSession')).toBe(1);

    const [configures, pings, queries] = [await count('configure'), await count('ping'), await count('queryPermissions')];
    await launched.app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('resume');
    });
    await expect.poll(() => count('configure')).toBe(configures + 1); // displays may have changed: configured again
    expect(await count('ping')).toBeGreaterThanOrEqual(pings + 1); // at once (the 10 s watchdog ping may add one)
    expect(await count('queryPermissions')).toBe(queries + (process.platform === 'darwin' ? 1 : 0));
  } finally {
    await launched.close();
    await rm(logs, { recursive: true, force: true });
  }
});

test('corrupt settings and history are kept aside, the defaults apply and the user is told — no crash', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-data-'));
  await writeFile(join(userData, 'settings.json'), '{ "locale": "en", broken');
  await writeFile(join(userData, 'history.json'), '[[[');
  const launched = await launchApp({ userData });
  try {
    await expect
      .poll(async () => (await launched.app.evaluate(() => (globalThis as unknown as { __orbitdrop: { notifications(): { title: string }[] } }).__orbitdrop.notifications())).map((n) => n.title))
      .toEqual(['설정을 기본값으로 되돌렸습니다', '작업 기록을 비웠습니다']);
    const names = await readdir(userData);
    const settingsBackup = names.find((n) => /^settings\.corrupt-\d+\.json$/.test(n));
    const historyBackup = names.find((n) => /^history\.corrupt-\d+\.json$/.test(n));
    expect(settingsBackup).toBeDefined();
    expect(historyBackup).toBeDefined();
    expect(await readFile(join(userData, settingsBackup!), 'utf8')).toBe('{ "locale": "en", broken');
    expect(await readFile(join(userData, historyBackup!), 'utf8')).toBe('[[[');
    expect(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'))).toEqual(DEFAULT_SETTINGS);

    await hooks(launched.app).openWindow('settings');
    const settings = await windowOf(launched.app, 'settings');
    await expect(settings.getByText(`원래 파일은 앱 데이터 폴더에 ${settingsBackup} 이름으로 보관했습니다.`, { exact: false })).toBeVisible();
    await expect(settings.getByText(`${historyBackup} 이름으로 보관했습니다.`, { exact: false })).toBeVisible();
  } finally {
    await launched.close();
    await rm(userData, { recursive: true, force: true });
  }
});

/** A PDF with enough pages that converting it at 300 DPI takes several seconds. */
async function makeLongPdf(dir: string, pages: number): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([612, 792]);
    page.drawRectangle({ x: 40, y: 40 + (i % 10) * 20, width: 500, height: 300, color: rgb(0.2, 0.4, 0.9) });
    page.drawText(`Page ${i + 1}`, { x: 60, y: 700, size: 32, font });
  }
  const path = join(dir, 'long report.pdf');
  await writeFile(path, await doc.save());
  return path;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

test('quitting while a job runs: the job is cancelled, no worker or helper process stays behind, no temp file or partial output is left', async () => {
  test.skip(process.platform === 'win32', 'the stub helper is a shebang script; ps is used to find it');
  const userData = await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-data-'));
  const launched = await launchApp({
    userData,
    env: { ORBITDROP_E2E_HELPER: '1', ORBITDROP_HELPER_PATH: join(appDir, 'e2e', 'fixtures', 'stub-helper.mjs') },
  });
  try {
    const pdf = await makeLongPdf(launched.work, 1500); // far more pages than can be converted before the quit below
    const h = hooks(launched.app);
    await expect.poll(async () => (await launched.app.evaluate(() => (globalThis as unknown as { __orbitdrop: { helperStatus(): { state: string } } }).__orbitdrop.helperStatus())).state).toBe('running');
    const submitted = await h.submit([pdf], 'convert.jpeg');
    if (submitted.kind !== 'jobs') throw new Error(`expected jobs, got ${submitted.kind}`);
    const jobId = submitted.jobIds[0]!;
    // Inside the conversion: the worker has rendered and written some pages, many are still to come.
    await expect
      .poll(async () => {
        const progress = (await h.jobs()).find((j) => j.jobId === jobId)?.progress;
        return progress?.kind === 'determinate' ? progress.done : 0;
      })
      .toBeGreaterThanOrEqual(3);

    const mainPid = launched.app.process().pid!;
    const utility = await launched.app.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.type === 'Utility').map((m) => m.pid));
    const helperPids = await new Promise<number[]>((resolve) => {
      const ps = spawn('ps', ['-axo', 'pid=,ppid=,command=']);
      let out = '';
      ps.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      ps.on('exit', () =>
        resolve(
          out
            .split('\n')
            .map((line) => line.trim().split(/\s+/))
            .filter((parts) => Number(parts[1]) === mainPid && parts.slice(2).join(' ').includes('stub-helper.mjs'))
            .map((parts) => Number(parts[0])),
        ),
      );
    });
    expect(utility.length).toBeGreaterThanOrEqual(2); // the job worker and the preview worker
    expect(helperPids).toHaveLength(1);
    expect((await h.jobs()).find((j) => j.jobId === jobId)?.state).toBe('running');

    await launched.app.close();
    await expect.poll(() => [mainPid, ...utility, ...helperPids].filter(alive), { timeout: 15_000 }).toEqual([]);
    // No temp file, and the pages written before the quit were rolled back with the cancelled job.
    expect(await readdir(launched.work)).toEqual(['long report.pdf']);
    const history = JSON.parse(await readFile(join(userData, 'history.json'), 'utf8')) as { jobs: { jobId: string; state: string }[] };
    expect(history.jobs.find((j) => j.jobId === jobId)?.state).toBe('cancelled');
  } finally {
    await launched.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('an app data folder that cannot be written is reported (exit code 1), not a silent quit', async () => {
  test.skip(process.platform === 'win32', 'chmod does not make a Windows folder read-only');
  const userData = await mkdtemp(join(tmpdir(), 'orbitdrop-e2e-ro-'));
  await chmod(userData, 0o555);
  try {
    const executable = require('electron') as unknown as string;
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(executable, [appDir], {
        cwd: appDir,
        env: { ...process.env, ORBITDROP_E2E: '1', ORBITDROP_USER_DATA_DIR: userData },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`still running after 30 s; stderr: ${stderr.slice(-500)}`));
      }, 30_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });
    expect(result.stderr).toContain('ORBITDROP_STARTUP_ERROR dataDirNotWritable');
    expect(result.code).toBe(1);
  } finally {
    await chmod(userData, 0o755);
    await rm(userData, { recursive: true, force: true });
  }
});
