import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type JobSnapshot, type ProcessorInput, type Settings } from '@orbitdrop/contracts';
import { isTempFileName, makeTempPath } from '@orbitdrop/core/node';
import { OutputRegistry } from '../../src/main/files/outputs';
import { HistoryStore } from '../../src/main/history/store';
import { JobManager, type JobRecordView, type JobSpec } from '../../src/main/jobs/manager';
import { ProcessorPool } from '../../src/main/processing/pool';
import { fakeFleet, standardBehavior, type Behavior } from './fake-worker';
import { waitFor } from './helpers';

let dir: string;
const cleanup: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-jobs-'));
});

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  await rm(dir, { recursive: true, force: true });
});

function input(name = 'photo.png'): ProcessorInput {
  return { fileId: 'f_1', path: join(dir, name), displayName: name, sourceDir: dir, format: 'png', bytes: 1234 };
}

function spec(overrides: Partial<JobSpec> = {}): JobSpec {
  return { actionId: 'convert.jpeg', inputs: [input()], options: {}, outputDir: null, origin: { source: 'test', sessionId: null }, ...overrides };
}

function setup(behavior: Behavior, settings: Partial<Settings> = {}) {
  const fleet = fakeFleet(standardBehavior(behavior));
  const pool = new ProcessorPool({ fork: fleet.fork, jobWorkers: 2, cancelGraceMs: 30, restartBaseMs: 5, restartMaxMs: 10 });
  pool.start();
  const history = new HistoryStore(dir, undefined, 5);
  const outputs = new OutputRegistry();
  const broadcasts: JobSnapshot[][] = [];
  const settled: JobRecordView[] = [];
  const current: Settings = { ...DEFAULT_SETTINGS, ...settings };
  const jobs = new JobManager({
    run: (job, ctx) => pool.run(job, ctx),
    settings: () => current,
    outputs,
    history,
    onChanged: (list) => broadcasts.push([...list]),
    onSettled: (view) => settled.push(view),
    broadcastDelayMs: 5,
  });
  cleanup.push(() => pool.shutdown(200), () => history.flush());
  return { fleet, pool, history, outputs, jobs, broadcasts, settled };
}

const doneWith = (path: string): Behavior => (message, worker) => {
  if (message.type === 'run') worker.emit({ type: 'done', jobId: message.job.jobId, result: { outputs: [{ path, format: 'jpeg', bytes: 99, width: 10, height: 20 }], warnings: [] } });
};

describe('JobManager with the processor pool', () => {
  it('completes a job, registers its outputs and records history', async () => {
    const out = join(dir, 'photo.jpg');
    const { jobs, outputs, history, settled, broadcasts } = setup(doneWith(out));
    const [jobId] = jobs.submit([spec()], null);
    const snapshot = await jobs.waitFor(jobId!);
    expect(snapshot.state).toBe('completed');
    expect(snapshot.inputName).toBe('photo.png');
    expect(snapshot.inputBytes).toBe(1234);
    expect(snapshot.outputs).toHaveLength(1);
    const output = snapshot.outputs[0]!;
    expect(output).toMatchObject({ name: 'photo.jpg', format: 'jpeg', bytes: 99, width: 10, height: 20 });
    expect(output.dirDisplay).not.toContain('/');
    expect(outputs.get(output.outputId)?.path).toBe(out);
    expect(history.list()[0]).toMatchObject({ jobId, state: 'completed', outputs: [{ path: out, name: 'photo.jpg' }] });
    expect(settled.map((v) => v.snapshot.state)).toEqual(['completed']);
    await waitFor(() => broadcasts.some((list) => list.some((j) => j.jobId === jobId && j.state === 'completed')));
  });

  it('a worker crash cleans the job temp files and the job is retried once on a fresh worker', async () => {
    let attempts = 0;
    const out = join(dir, 'photo.jpg');
    const { jobs, fleet } = setup((message, worker) => {
      if (message.type !== 'run') return;
      attempts += 1;
      if (attempts === 1) {
        // Simulate a crash in the middle of writing: a tagged temp file is left behind.
        void writeFile(makeTempPath(dir, 'photo.jpg', message.job.jobId), 'partial').then(() => worker.exit(139));
        return;
      }
      void readdir(dir).then((names) => {
        // The leftover must already be gone when the retry starts.
        const leftovers = names.filter((n) => isTempFileName(n));
        worker.emit(
          leftovers.length === 0
            ? { type: 'done', jobId: message.job.jobId, result: { outputs: [{ path: out, format: 'jpeg', bytes: 1 }], warnings: [] } }
            : { type: 'failed', jobId: message.job.jobId, error: { code: 'INTERNAL', message: 'temp file left', retryable: false } },
        );
      });
    });
    await writeFile(join(dir, 'unrelated.txt'), 'user file');
    const [jobId] = jobs.submit([spec()], null);
    const snapshot = await jobs.waitFor(jobId!);
    expect(snapshot.state).toBe('completed');
    expect(attempts).toBe(2);
    expect(fleet.jobs().length).toBeGreaterThanOrEqual(2);
    const names = await readdir(dir);
    expect(names.filter((n) => isTempFileName(n))).toEqual([]);
    expect(names.filter((n) => !n.endsWith('.json'))).toEqual(['unrelated.txt']);
  });

  it('a job that crashes twice fails with WORKER_CRASHED', async () => {
    const { jobs } = setup((message, worker) => {
      if (message.type === 'run') worker.exit(1);
    });
    const [jobId] = jobs.submit([spec()], null);
    const snapshot = await jobs.waitFor(jobId!);
    expect(snapshot.state).toBe('failed');
    expect(snapshot.error?.code).toBe('WORKER_CRASHED');
  });

  it('times out with the live timeout setting and kills an unresponsive worker', async () => {
    // The manager reads processing.timeoutSec for every job; 50 ms keeps the test fast
    // (the settings schema enforces ≥ 10 s for real settings).
    const { jobs, fleet } = setup(() => undefined, { processing: { concurrency: 1, timeoutSec: 0.05 } });
    const [jobId] = jobs.submit([spec()], null);
    const snapshot = await jobs.waitFor(jobId!);
    expect(snapshot.state).toBe('failed');
    expect(snapshot.error?.code).toBe('TIMEOUT');
    await waitFor(() => fleet.jobs().some((w) => w.ofType('cancel').length === 1), 1000, 'cancel sent');
    await waitFor(() => fleet.jobs().some((w) => w.killCalls > 0), 1000, 'killed after grace');
  });

  it('cancels queued and running jobs', async () => {
    const { jobs, fleet } = setup((message, worker) => {
      if (message.type === 'cancel') worker.emit({ type: 'cancelled', jobId: message.jobId });
    });
    jobs.setConcurrency(1);
    const [running, queued] = jobs.submit([spec(), spec({ inputs: [input('b.png')] })], 'b_1');
    await waitFor(() => fleet.jobs().some((w) => w.ofType('run').length === 1));
    expect(jobs.cancel(queued!)).toBe(true);
    expect(jobs.cancel(running!)).toBe(true);
    expect((await jobs.waitFor(running!)).state).toBe('cancelled');
    expect((await jobs.waitFor(queued!)).state).toBe('cancelled');
    expect(jobs.cancel(running!)).toBe(false);
    expect(jobs.batch('b_1')).toHaveLength(2);
  });

  it('records skipped jobs as completed with their warning', async () => {
    const { jobs, settled } = setup(() => undefined);
    const jobId = jobs.addSkipped(spec(), null, { code: 'SKIPPED_SAME_FORMAT' });
    const snapshot = await jobs.waitFor(jobId);
    expect(snapshot).toMatchObject({ state: 'completed', outputs: [], warnings: [{ code: 'SKIPPED_SAME_FORMAT' }] });
    expect(settled).toHaveLength(1);
  });

  it('lists history from earlier runs with fresh output ids', async () => {
    const out = join(dir, 'old.jpg');
    const first = setup(doneWith(out));
    const [jobId] = first.jobs.submit([spec()], null);
    await first.jobs.waitFor(jobId!);
    await first.history.flush();

    const history = new HistoryStore(dir);
    await history.load();
    const outputs = new OutputRegistry();
    const restarted = new JobManager({ run: async () => ({ outputs: [], warnings: [] }), settings: () => DEFAULT_SETTINGS, outputs, history });
    const listed = restarted.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ jobId, state: 'completed' });
    const outputId = listed[0]!.outputs[0]!.outputId;
    expect(outputs.get(outputId)?.path).toBe(out);
    expect(restarted.recentWithOutputs(5).map((j) => j.jobId)).toEqual([jobId]);
  });
});
