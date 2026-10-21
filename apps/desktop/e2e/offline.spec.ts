/**
 * OrbitDrop works offline and never phones home: with the network emulated
 * offline, every http(s)/ws(s) request of the app's session is recorded (and
 * cancelled) while PDF → JPG runs from the picker wheel and Add Background
 * runs through its editor — none may be made. While the jobs run, the
 * internet sockets of every OrbitDrop process (main, renderers, GPU, the
 * processor utility processes) are sampled with lsof: apart from Playwright's
 * own loopback debugging connection there must be none.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { hooks, imageMeta, jobIds, launchApp, makePdf, waitForNewJob, windowOf, type Launched } from './support';

const run = promisify(execFile);

test.describe.configure({ mode: 'serial' });

let launched: Launched;

test.beforeAll(async () => {
  launched = await launchApp();
  await launched.app.evaluate(({ session }) => {
    const log: string[] = [];
    (globalThis as unknown as { __netlog: string[] }).__netlog = log;
    session.defaultSession.enableNetworkEmulation({ offline: true });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      log.push(details.url.slice(0, 200));
      callback({ cancel: true });
    });
  });
});

test.afterAll(async () => {
  await launched?.close();
});

/** The app's process tree (main and every descendant). */
async function appPids(rootPid: number): Promise<number[]> {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=']);
  const children = new Map<number, number[]>();
  for (const line of stdout.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number) as [number, number];
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const pids: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    pids.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return pids;
}

/** Internet sockets of these processes that are not loopback (lsof exits 1 when there are none). */
async function externalSockets(pids: readonly number[]): Promise<string[]> {
  let stdout = '';
  try {
    ({ stdout } = await run('lsof', ['-nP', '-a', '-i', '-p', pids.join(',')]));
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    if (failure.code !== 1 || failure.stderr) throw new Error(`lsof failed: ${String(failure.stderr ?? failure.code)}`);
    stdout = failure.stdout ?? '';
  }
  return stdout
    .split('\n')
    .slice(1)
    .filter((line) => line.trim() !== '')
    .filter((line) => !/127\.0\.0\.1|\[::1\]|localhost/.test(line));
}

/** Sample the sockets every 200 ms while `work` runs; also reports how much the sampling covered. */
async function watchSockets<T>(work: () => Promise<T>): Promise<{ result: T; seen: string[]; samples: number; maxProcesses: number }> {
  const rootPid = launched.app.process().pid!;
  const seen = new Set<string>();
  let running = true;
  let samples = 0;
  let maxProcesses = 0;
  const sampler = (async () => {
    while (running) {
      const pids = await appPids(rootPid);
      maxProcesses = Math.max(maxProcesses, pids.length);
      for (const line of await externalSockets(pids)) seen.add(line);
      samples += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();
  try {
    const result = await work();
    return { result, seen: [...seen], samples, maxProcesses };
  } finally {
    running = false;
    await sampler;
  }
}

async function chooseSector(page: Page, label: string): Promise<void> {
  const sector = page.getByRole('menuitem', { name: label, exact: true });
  await expect(sector).toBeVisible();
  await sector.click({ force: true });
}

test.skip(process.platform === 'win32', 'lsof sampling is macOS/Linux only');

test('PDF → JPG and Add Background make no network request and open no internet socket', async () => {
  const pdf = await makePdf(launched.work);
  const { seen, samples, maxProcesses } = await watchSockets(async () => {
    const known = await jobIds(launched.app);
    await hooks(launched.app).openPicker([pdf], 'convert');
    await chooseSector(await windowOf(launched.app, 'picker'), 'JPG');
    const converted = await waitForNewJob(launched.app, known, 'convert.jpeg');
    expect(converted.state).toBe('completed');
    expect(await imageMeta(join(launched.work, 'Page 001.jpg'))).toEqual({ format: 'jpeg', width: 2550, height: 3300 });

    const known2 = await jobIds(launched.app);
    await hooks(launched.app).openPicker([join(launched.work, 'Page 001.jpg')], 'tools');
    await chooseSector(await windowOf(launched.app, 'picker'), '배경 추가');
    const editor = await windowOf(launched.app, 'editor');
    await expect(editor.locator('img[alt="처리 결과 미리보기"]')).toBeVisible({ timeout: 30_000 });
    await editor.locator('.btn-primary').click();
    const composed = await waitForNewJob(launched.app, known2, 'tool.addBackground');
    expect(composed.state).toBe('completed');
    const meta = await imageMeta(join(launched.work, 'Page 001 With Background.png'));
    expect(meta.format).toBe('png');
    expect(Math.max(meta.width, meta.height)).toBe(2400);
  });
  const requests = await launched.app.evaluate(() => (globalThis as unknown as { __netlog: string[] }).__netlog);
  expect(requests).toEqual([]);
  expect(seen).toEqual([]);
  // The sampling really ran over the app's process tree (main, renderers, GPU, processor workers).
  expect(samples).toBeGreaterThanOrEqual(3);
  expect(maxProcesses).toBeGreaterThanOrEqual(4);
});
