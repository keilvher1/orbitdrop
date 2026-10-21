/**
 * Jobs window polish: retrying jobs (after a timeout, a crash or a cancel),
 * the explanation when an input is gone, and "clear finished" (list and
 * history.json emptied of finished jobs, the running job and every output
 * file untouched). Failures and long-running jobs are scripted through main's
 * E2E-only hooks (failNextJobs / holdNextJob, unpackaged builds only); the
 * retried jobs run through the real processors and their outputs are decoded.
 * Clicks are delivered to the real renderer by Playwright — no OS input.
 */
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { JobSnapshot, OrbitApi } from '@orbitdrop/contracts';
import { hooks, imageMeta, jobIds, launchApp, makeJpeg, waitForNewJob, windowOf, type Launched } from './support';

declare global {
  interface Window {
    orbit: OrbitApi;
  }
}

test.describe.configure({ mode: 'serial' });

let launched: Launched;
let jobsPage: Page;

test.beforeAll(async () => {
  launched = await launchApp();
  await hooks(launched.app).openWindow('jobs');
  jobsPage = await windowOf(launched.app, 'jobs');
});

test.afterAll(async () => {
  await launched?.close();
});

/** The card of the job with this input name and state label (e.g. 실패, 취소됨, 처리 중). */
function card(inputName: string, stateLabel: string) {
  return jobsPage.locator('li.job-card').filter({ hasText: inputName }).filter({ has: jobsPage.locator('.job-state', { hasText: stateLabel }) });
}

async function submitFailing(name: string, codes: Parameters<ReturnType<typeof hooks>['failNextJobs']>[0]): Promise<JobSnapshot> {
  const source = await makeJpeg(launched.work, name, 640, 480);
  await hooks(launched.app).failNextJobs(codes);
  const submitted = await hooks(launched.app).submit([source], 'convert.png');
  if (submitted.kind !== 'jobs') throw new Error(`expected jobs, got ${submitted.kind}`);
  const job = await hooks(launched.app).waitForJob(submitted.jobIds[0]!);
  expect(job.state).toBe('failed');
  return job;
}

async function historyIds(): Promise<string[] | null> {
  try {
    const raw = JSON.parse(await readFile(join(launched.userData, 'history.json'), 'utf8')) as { jobs?: { jobId: string }[] };
    return (raw.jobs ?? []).map((j) => j.jobId);
  } catch {
    return null;
  }
}

test('a timed-out job is retried from the Jobs window: same action, real output, one retry only', async () => {
  const failed = await submitFailing('retry-me.jpg', ['TIMEOUT']);
  expect(failed.error?.code).toBe('TIMEOUT');
  const failedCard = card('retry-me.jpg', '실패');
  await expect(failedCard.getByText('처리 시간이 너무 길어 중단했습니다.')).toBeVisible();
  const known = await jobIds(launched.app);
  await failedCard.getByRole('button', { name: '다시 시도' }).click();
  await expect(failedCard.getByText('다시 시도했습니다.')).toBeVisible();
  await expect(failedCard.getByRole('button', { name: '다시 시도' })).toHaveCount(0);

  const retried = await waitForNewJob(launched.app, known, 'convert.png');
  expect(retried.state).toBe('completed');
  expect(retried.inputName).toBe('retry-me.jpg');
  expect(await imageMeta(join(launched.work, 'retry-me.png'))).toEqual({ format: 'png', width: 640, height: 480 });
  await expect(card('retry-me.jpg', '완료')).toBeVisible();

  // Asking again (e.g. after reopening the window) returns the first retry instead of running a third time.
  const again = await jobsPage.evaluate((id) => window.orbit.retryJob(id), failed.jobId);
  expect(again).toEqual({ kind: 'jobs', jobIds: [retried.jobId] });
  expect((await hooks(launched.app).jobs()).filter((j) => j.inputName === 'retry-me.jpg')).toHaveLength(2);
});

test('a job whose worker crashed twice can be retried; if the input is gone, the window says so and runs nothing', async () => {
  // WORKER_CRASHED is retried once automatically by the queue: two crashes fail the job.
  const failed = await submitFailing('vanish.jpg', ['WORKER_CRASHED', 'WORKER_CRASHED']);
  expect(failed.error?.code).toBe('WORKER_CRASHED');
  await rm(join(launched.work, 'vanish.jpg'));
  const failedCard = card('vanish.jpg', '실패');
  await failedCard.getByRole('button', { name: '다시 시도' }).click();
  await expect(failedCard.getByText(/다시 시도할 수 없습니다/)).toBeVisible();
  await expect(failedCard.getByRole('button', { name: '다시 시도' })).toBeVisible(); // still offered (the file may come back)
  expect((await hooks(launched.app).jobs()).filter((j) => j.inputName === 'vanish.jpg')).toHaveLength(1);
});

test('a cancelled job can be retried', async () => {
  const source = await makeJpeg(launched.work, 'stop-me.jpg', 320, 240);
  await hooks(launched.app).holdNextJob();
  const submitted = await hooks(launched.app).submit([source], 'convert.webp');
  if (submitted.kind !== 'jobs') throw new Error('expected jobs');
  const running = card('stop-me.jpg', '처리 중');
  await running.getByRole('button', { name: '작업 취소' }).click();
  const cancelled = card('stop-me.jpg', '취소됨');
  await expect(cancelled).toBeVisible();
  expect((await hooks(launched.app).waitForJob(submitted.jobIds[0]!)).state).toBe('cancelled');
  expect(await hooks(launched.app).releaseHeldJobs()).toBe(0); // the hold ended with the cancel

  const known = await jobIds(launched.app);
  await cancelled.getByRole('button', { name: '다시 시도' }).click();
  await expect(cancelled.getByText('다시 시도했습니다.')).toBeVisible();
  const retried = await waitForNewJob(launched.app, known, 'convert.webp');
  expect(retried.state).toBe('completed');
  expect(await imageMeta(join(launched.work, 'stop-me.webp'))).toEqual({ format: 'webp', width: 320, height: 240 });
});

test('clear finished: finished jobs leave the list and history.json; the running job and all outputs stay', async () => {
  const outputsBefore = ['retry-me.png', 'stop-me.webp'];
  const finishedIds = (await hooks(launched.app).jobs()).filter((j) => ['completed', 'failed', 'cancelled'].includes(j.state)).map((j) => j.jobId);
  expect(finishedIds.length).toBeGreaterThanOrEqual(5);
  await expect.poll(async () => (await historyIds())?.length ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(finishedIds.length);

  // One job stays running (held) while the user clears.
  const source = await makeJpeg(launched.work, 'still-running.jpg', 200, 100);
  await hooks(launched.app).holdNextJob();
  const submitted = await hooks(launched.app).submit([source], 'convert.png');
  if (submitted.kind !== 'jobs') throw new Error('expected jobs');
  await expect(card('still-running.jpg', '처리 중')).toBeVisible();

  await jobsPage.getByRole('button', { name: '끝난 작업 지우기' }).click();
  await expect(jobsPage.getByRole('heading', { name: '최근 작업' })).toHaveCount(0);
  await expect(jobsPage.getByRole('button', { name: '끝난 작업 지우기' })).toHaveCount(0);
  await expect(card('still-running.jpg', '처리 중')).toBeVisible();
  const listed = await hooks(launched.app).jobs();
  expect(listed.map((j) => [j.inputName, j.state])).toEqual([['still-running.jpg', 'running']]);
  await expect.poll(async () => (await historyIds()) ?? ['unreadable'], { timeout: 10_000 }).toEqual([]);
  for (const name of outputsBefore) expect((await stat(join(launched.work, name))).size).toBeGreaterThan(0);

  // Nothing was cancelled: the held job finishes normally afterwards and is listed and recorded again.
  expect(await hooks(launched.app).releaseHeldJobs()).toBe(1);
  const done = await hooks(launched.app).waitForJob(submitted.jobIds[0]!);
  expect(done.state).toBe('completed');
  expect(await imageMeta(join(launched.work, 'still-running.png'))).toEqual({ format: 'png', width: 200, height: 100 });
  await expect(card('still-running.jpg', '완료')).toBeVisible();
  await expect.poll(async () => historyIds(), { timeout: 10_000 }).toEqual([done.jobId]);
});
