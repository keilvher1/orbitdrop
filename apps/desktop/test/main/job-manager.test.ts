import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, OrbitError, type JobSnapshot, type ProcessorInput, type ProcessorResult, type Settings } from '@orbitdrop/contracts';
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
    expect(listed[0]).toMatchObject({ jobId, state: 'completed', earlierRun: true });
    // A job of this session is not marked (it can be retried while main still has its inputs).
    expect(first.jobs.list()[0]!.earlierRun).toBeUndefined();
    const outputId = listed[0]!.outputs[0]!.outputId;
    expect(outputs.get(outputId)?.path).toBe(out);
    expect(restarted.recentWithOutputs(5).map((j) => j.jobId)).toEqual([jobId]);
  });
});

describe('clearFinished', () => {
  /** A manager with a scriptable runner and a controllable clock (no worker processes). */
  function manual() {
    let clock = 1_000;
    const gates = new Map<string, { resolve: (result: ProcessorResult) => void; reject: (error: unknown) => void }>();
    const behaviour = new Map<string, 'done' | 'hold' | 'fail'>();
    const history = new HistoryStore(dir, undefined, 5);
    const outputs = new OutputRegistry();
    const broadcasts: JobSnapshot[][] = [];
    const settledBatches: number[] = [];
    const jobs: JobManager = new JobManager({
      run: (job) => {
        const name = job.inputs[0]!.displayName;
        const mode = behaviour.get(name) ?? 'done';
        if (mode === 'fail') return Promise.reject(new OrbitError('DISK_FULL', 'full'));
        if (mode === 'done') return Promise.resolve({ outputs: [{ path: join(dir, `${name}.jpg`), format: 'jpeg' as const, bytes: 5 }], warnings: [] });
        return new Promise<ProcessorResult>((resolve, reject) => gates.set(name, { resolve, reject }));
      },
      settings: () => DEFAULT_SETTINGS,
      outputs,
      history,
      now: () => clock,
      onChanged: (list) => broadcasts.push([...list]),
      onSettled: (view) => {
        if (view.batchId) settledBatches.push(jobs.batch(view.batchId).length);
      },
      broadcastDelayMs: 1,
    });
    cleanup.push(() => history.flush());
    return {
      jobs,
      history,
      outputs,
      broadcasts,
      settledBatches,
      gates,
      behaviour,
      setClock: (value: number) => {
        clock = value;
      },
    };
  }

  it('removes finished session jobs and history entries, keeps active jobs, outputs and files', async () => {
    const m = manual();
    m.behaviour.set('fail.png', 'fail');
    m.behaviour.set('hold.png', 'hold');
    m.behaviour.set('queued.png', 'hold');
    const outFile = join(dir, 'done.png.jpg');
    await writeFile(outFile, 'result');
    const [done, failed] = m.jobs.submit([spec({ inputs: [input('done.png')] }), spec({ inputs: [input('fail.png')] })], null);
    await Promise.all([m.jobs.waitFor(done!), m.jobs.waitFor(failed!)]);
    const skipped = m.jobs.addSkipped(spec({ inputs: [input('same.jpg')] }), null, { code: 'SKIPPED_SAME_FORMAT' });
    m.jobs.setConcurrency(1);
    const [held, queued] = m.jobs.submit([spec({ inputs: [input('hold.png')] }), spec({ inputs: [input('queued.png')] })], null);
    await waitFor(() => m.gates.has('hold.png'), 1000, 'held job running');
    const outputId = m.jobs.get(done!)!.snapshot.outputs[0]!.outputId;
    expect(m.history.list().map((e) => e.jobId).sort()).toEqual([done, failed, skipped].sort());

    const before = m.broadcasts.length;
    expect(m.jobs.clearFinished()).toBe(3);
    // Broadcast right away (not throttled) without the finished jobs.
    expect(m.broadcasts.length).toBe(before + 1);
    // (Same fake createdAt for both: compare without relying on the order of the tie.)
    expect(new Map(m.broadcasts.at(-1)!.map((j) => [j.jobId, j.state]))).toEqual(
      new Map([
        [queued!, 'queued'],
        [held!, 'running'],
      ]),
    );
    expect(m.jobs.list().map((j) => j.jobId).sort()).toEqual([held, queued].sort());
    expect(m.jobs.get(done!)).toBeUndefined();
    expect(m.history.list()).toEqual([]);
    // Outputs stay revealable by id and on disk.
    expect(m.outputs.get(outputId)?.path).toBe(outFile);
    expect(await readFile(outFile, 'utf8')).toBe('result');
    // Nothing active was cancelled: the held job still completes.
    m.gates.get('hold.png')!.resolve({ outputs: [], warnings: [] });
    expect((await m.jobs.waitFor(held!)).state).toBe('completed');
    await m.history.flush();
    const reloaded = new HistoryStore(dir);
    expect((await reloaded.load()).map((e) => e.jobId)).toEqual([held]);
    m.gates.get('queued.png')?.resolve({ outputs: [], warnings: [] });
    await waitFor(() => m.gates.has('queued.png'), 1000, 'queued job started');
    m.gates.get('queued.png')!.resolve({ outputs: [], warnings: [] });
    await m.jobs.waitFor(queued!);
    expect(m.jobs.clearFinished()).toBe(2);
    expect(m.jobs.clearFinished()).toBe(0);
  });

  it('only removes jobs that finished at or before the cut-off (a job finishing during the click stays)', async () => {
    const m = manual();
    m.setClock(1_000);
    const [early] = m.jobs.submit([spec({ inputs: [input('early.png')] })], null);
    await m.jobs.waitFor(early!);
    m.setClock(2_000);
    const [late] = m.jobs.submit([spec({ inputs: [input('late.png')] })], null);
    await m.jobs.waitFor(late!);
    expect(m.jobs.list().map((j) => j.finishedAt)).toEqual([2_000, 1_000]);
    expect(m.jobs.clearFinished(1_500)).toBe(1);
    expect(m.jobs.list().map((j) => j.jobId)).toEqual([late]);
    expect(m.history.list().map((e) => e.jobId)).toEqual([late]);
    expect(m.jobs.clearFinished(1_999)).toBe(0);
    expect(m.jobs.clearFinished(2_000)).toBe(1);
  });

  it('also clears jobs of earlier runs that are only in history', async () => {
    const first = manual();
    const [old] = first.jobs.submit([spec({ inputs: [input('old.png')] })], null);
    await first.jobs.waitFor(old!);
    await first.history.flush();
    const history = new HistoryStore(dir, undefined, 5);
    await history.load();
    const broadcasts: JobSnapshot[][] = [];
    const restarted = new JobManager({ run: async () => ({ outputs: [], warnings: [] }), settings: () => DEFAULT_SETTINGS, outputs: new OutputRegistry(), history, onChanged: (list) => broadcasts.push([...list]) });
    expect(restarted.list().map((j) => j.jobId)).toEqual([old]);
    expect(restarted.clearFinished()).toBe(1);
    expect(restarted.list()).toEqual([]);
    expect(broadcasts.at(-1)).toEqual([]);
    await history.flush();
    expect(await new HistoryStore(dir).load()).toEqual([]);
  });

  it('keeps a job whose worker crashed while its automatic retry runs', async () => {
    let attempts = 0;
    let release: (() => void) | null = null;
    const history = new HistoryStore(dir, undefined, 5);
    cleanup.push(() => history.flush());
    const jobs = new JobManager({
      run: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new OrbitError('WORKER_CRASHED', 'crashed'));
        return new Promise<ProcessorResult>((resolve) => {
          release = () => resolve({ outputs: [], warnings: [] });
        });
      },
      settings: () => DEFAULT_SETTINGS,
      outputs: new OutputRegistry(),
      history,
    });
    const [jobId] = jobs.submit([spec()], null);
    await waitFor(() => attempts === 2, 1000, 'second attempt');
    expect(jobs.clearFinished()).toBe(0);
    expect(jobs.get(jobId!)?.snapshot.state).toBe('running');
    release!();
    expect((await jobs.waitFor(jobId!)).state).toBe('completed');
  });

  it('a finished member of a running batch leaves the list but still counts for the batch notification', async () => {
    const m = manual();
    m.behaviour.set('second.png', 'hold');
    const [first, second] = m.jobs.submit([spec({ inputs: [input('first.png')] }), spec({ inputs: [input('second.png')] })], 'b_1');
    await m.jobs.waitFor(first!);
    await waitFor(() => m.gates.has('second.png'), 1000, 'second running');
    expect(m.jobs.clearFinished()).toBe(1);
    expect(m.jobs.list().map((j) => j.jobId)).toEqual([second]);
    expect(m.jobs.get(first!)).toBeUndefined();
    expect(m.jobs.batch('b_1')).toHaveLength(2);
    m.gates.get('second.png')!.resolve({ outputs: [], warnings: [] });
    await m.jobs.waitFor(second!);
    // The settle hook (notifications) saw both jobs of the batch; afterwards the cleared one is gone.
    expect(m.settledBatches).toEqual([2, 2]);
    expect(m.jobs.batch('b_1').map((j) => j.jobId)).toEqual([second]);
    expect(m.jobs.list().map((j) => j.jobId)).toEqual([second]);
  });

  it('forgets the retry memo of cleared jobs', async () => {
    const m = manual();
    m.behaviour.set('fail.png', 'fail');
    const [failed] = m.jobs.submit([spec({ inputs: [input('fail.png')] })], null);
    await m.jobs.waitFor(failed!);
    expect(m.jobs.get(failed!)?.snapshot.retried).toBeUndefined();
    m.jobs.markRetried(failed!, ['job_new']);
    expect(m.jobs.retriedAs(failed!)).toEqual(['job_new']);
    // The snapshot says so too, so a reopened Jobs window shows "retried" instead of the buttons.
    expect(m.jobs.get(failed!)?.snapshot.retried).toBe(true);
    m.jobs.clearFinished();
    expect(m.jobs.retriedAs(failed!)).toBeUndefined();
  });
});
