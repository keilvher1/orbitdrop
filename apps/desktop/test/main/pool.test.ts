import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_LIMITS, OrbitError, type JobProgress, type PreviewRequest, type ProcessorJob, type ProcessorResult } from '@orbitdrop/contracts';
import { ProcessorPool, outputDirsOf, rollbackCommitted } from '../../src/main/processing/pool';
import { failedProbe } from '../../src/main/processing/probe-fallback';
import { fakeFleet, standardBehavior, type Behavior, type FakeWorker } from './fake-worker';
import { imageInfo, probeWith, waitFor } from './helpers';

const settings = { pdfDpi: 300, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 } as const;

function job(jobId: string, sourceDir = '/tmp/in'): ProcessorJob {
  return {
    jobId,
    actionId: 'convert.jpeg',
    inputs: [{ fileId: 'f_1', path: `${sourceDir}/a.png`, displayName: 'a.png', sourceDir, format: 'png', bytes: 10 }],
    options: {},
    outputDir: null,
    settings,
    limits: DEFAULT_PROCESSING_LIMITS,
  };
}

function result(name: string): ProcessorResult {
  return { outputs: [{ path: `/tmp/in/${name}`, format: 'jpeg', bytes: 5, width: 1, height: 1 }], warnings: [] };
}

function preview(previewId: string): PreviewRequest {
  return { previewId, kind: 'tool.crop', input: job('x').inputs[0]!, options: {}, maxEdge: 100, settings, limits: DEFAULT_PROCESSING_LIMITS };
}

const pools: ProcessorPool[] = [];
function makePool(behavior: Behavior, options: Partial<ConstructorParameters<typeof ProcessorPool>[0]> = {}) {
  const fleet = fakeFleet(standardBehavior(behavior));
  const cleanups: { dirs: readonly string[]; jobId: string }[] = [];
  const pool = new ProcessorPool({
    fork: fleet.fork,
    jobWorkers: 1,
    cancelGraceMs: 30,
    restartBaseMs: 5,
    restartMaxMs: 20,
    cleanup: async (dirs, jobId) => {
      cleanups.push({ dirs, jobId });
    },
    ...options,
  });
  pools.push(pool);
  pool.start();
  return { pool, fleet, cleanups };
}

const controller = (): AbortController => new AbortController();

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.shutdown(200)));
});

describe('ProcessorPool jobs', () => {
  it('runs a job in a job worker and forwards progress', async () => {
    const { pool, fleet } = makePool((message, worker) => {
      if (message.type === 'run') {
        worker.emit({ type: 'progress', jobId: message.job.jobId, progress: { kind: 'determinate', done: 1, total: 2, unit: 'page' } });
        worker.emit({ type: 'done', jobId: message.job.jobId, result: result('a.jpg') });
      }
    });
    const progress: JobProgress[] = [];
    const out = await pool.run(job('j1'), { signal: controller().signal, onProgress: (p) => progress.push(p) });
    expect(out.outputs[0]!.path).toBe('/tmp/in/a.jpg');
    expect(progress).toEqual([{ kind: 'determinate', done: 1, total: 2, unit: 'page' }]);
    expect(fleet.jobs()).toHaveLength(1);
    expect(fleet.aux()).toHaveLength(1);
    expect(fleet.aux()[0]!.ofType('run')).toHaveLength(0); // jobs never go to the preview worker
  });

  it('maps worker failures to OrbitErrors with the same code', async () => {
    const { pool } = makePool((message, worker) => {
      if (message.type === 'run') worker.emit({ type: 'failed', jobId: message.job.jobId, error: { code: 'PDF_ENCRYPTED', message: 'encrypted', retryable: false } });
    });
    await expect(pool.run(job('j1'), { signal: controller().signal, onProgress: () => undefined })).rejects.toMatchObject({ code: 'PDF_ENCRYPTED' });
  });

  it('runs at most one job per worker and queues the rest', async () => {
    const pending = new Map<string, () => void>();
    const { pool, fleet } = makePool(
      (message, worker) => {
        if (message.type === 'run') pending.set(message.job.jobId, () => worker.emit({ type: 'done', jobId: message.job.jobId, result: result(`${message.job.jobId}.jpg`) }));
      },
      { jobWorkers: 2 },
    );
    const runs = ['a', 'b', 'c'].map((id) => pool.run(job(id), { signal: controller().signal, onProgress: () => undefined }));
    await waitFor(() => pending.size === 2, 1000, 'two running');
    expect([...pending.keys()].sort()).toEqual(['a', 'b']);
    expect(pool.stats().runningJobs).toBe(2);
    pending.get('a')!();
    await waitFor(() => pending.has('c'), 1000, 'third starts');
    pending.get('b')!();
    pending.get('c')!();
    const results = await Promise.all(runs);
    expect(results.map((r) => r.outputs[0]!.path)).toEqual(['/tmp/in/a.jpg', '/tmp/in/b.jpg', '/tmp/in/c.jpg']);
    expect(fleet.jobs()).toHaveLength(2);
  });

  it('cancel: sends cancel, settles right away and reuses the worker once it confirms', async () => {
    const { pool, fleet, cleanups } = makePool((message, worker) => {
      if (message.type === 'cancel') worker.emit({ type: 'cancelled', jobId: message.jobId });
      if (message.type === 'run' && message.job.jobId === 'second') worker.emit({ type: 'done', jobId: 'second', result: result('second.jpg') });
    });
    const abort = controller();
    const first = pool.run(job('first'), { signal: abort.signal, onProgress: () => undefined });
    await waitFor(() => fleet.jobs()[0]?.ofType('run').length === 1, 1000, 'run sent');
    abort.abort(new OrbitError('CANCELLED', 'Cancelled'));
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    const second = await pool.run(job('second'), { signal: controller().signal, onProgress: () => undefined });
    expect(second.outputs).toHaveLength(1);
    expect(fleet.jobs()).toHaveLength(1); // same worker
    expect(fleet.jobs()[0]!.ofType('cancel')).toEqual([{ type: 'cancel', jobId: 'first' }]);
    expect(cleanups).toEqual([]);
  });

  it('cancel: a worker that ignores cancel is killed after the grace period, temp files are cleaned and a new worker serves the next job', async () => {
    const { pool, fleet, cleanups } = makePool((message, worker) => {
      if (message.type === 'run' && message.job.jobId === 'next') worker.emit({ type: 'done', jobId: 'next', result: result('next.jpg') });
    });
    const abort = controller();
    const stuck = pool.run(job('stuck', '/tmp/stuck'), { signal: abort.signal, onProgress: () => undefined });
    await waitFor(() => fleet.jobs()[0]?.ofType('run').length === 1);
    abort.abort(new OrbitError('TIMEOUT', 'Job timed out'));
    await expect(stuck).rejects.toMatchObject({ code: 'TIMEOUT' });
    await waitFor(() => fleet.jobs()[0]!.killCalls === 1, 1000, 'kill');
    await waitFor(() => cleanups.length === 1, 1000, 'cleanup');
    expect(cleanups[0]).toEqual({ dirs: ['/tmp/stuck'], jobId: 'stuck' });
    const next = await pool.run(job('next'), { signal: controller().signal, onProgress: () => undefined });
    expect(next.outputs).toHaveLength(1);
    expect(fleet.jobs()).toHaveLength(2);
  });

  it('crash during a job: cleanup runs before the job fails with WORKER_CRASHED', async () => {
    const order: string[] = [];
    const fleetBehavior: Behavior = (message, worker) => {
      if (message.type === 'run') setTimeout(() => worker.exit(139), 2);
    };
    const { pool } = makePool(fleetBehavior, {
      cleanup: async (_dirs, jobId) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`cleanup:${jobId}`);
      },
    });
    const run = pool.run(job('boom'), { signal: controller().signal, onProgress: () => undefined }).catch((error: unknown) => {
      order.push(`rejected:${(error as OrbitError).code}`);
    });
    await run;
    expect(order).toEqual(['cleanup:boom', 'rejected:WORKER_CRASHED']);
  });

  it('ignores late messages for jobs that already finished', async () => {
    const { pool } = makePool((message, worker) => {
      if (message.type === 'run') {
        worker.emit({ type: 'done', jobId: message.job.jobId, result: result('one.jpg') });
        worker.emit({ type: 'failed', jobId: message.job.jobId, error: { code: 'INTERNAL', message: 'late', retryable: false } });
        worker.emit({ type: 'progress', jobId: message.job.jobId, progress: { kind: 'indeterminate' } });
      }
    });
    const progress: JobProgress[] = [];
    await expect(pool.run(job('one'), { signal: controller().signal, onProgress: (p) => progress.push(p) })).resolves.toBeDefined();
    expect(progress).toEqual([]);
  });

  it('resizes the number of job workers', async () => {
    const { pool } = makePool(() => undefined, { jobWorkers: 3 });
    expect(pool.jobWorkerCount).toBe(3);
    pool.setJobWorkers(1);
    expect(pool.jobWorkerCount).toBe(1);
    pool.setJobWorkers(2);
    expect(pool.jobWorkerCount).toBe(2);
  });

  it('stops idle job workers and starts them again on demand', async () => {
    const { pool, fleet } = makePool(
      (message, worker) => {
        if (message.type === 'run') worker.emit({ type: 'done', jobId: message.job.jobId, result: result('x.jpg') });
      },
      { idleShutdownMs: 20 },
    );
    await pool.run(job('a'), { signal: controller().signal, onProgress: () => undefined });
    await waitFor(() => fleet.jobs()[0]!.alive === false, 1000, 'idle stop');
    expect(fleet.jobs()[0]!.ofType('shutdown')).toHaveLength(1);
    await pool.run(job('b'), { signal: controller().signal, onProgress: () => undefined });
    expect(fleet.jobs()).toHaveLength(2);
  });
});

describe('ProcessorPool previews, inspect and probe', () => {
  it('routes preview, inspect and probe to the aux worker', async () => {
    const { pool, fleet } = makePool((message, worker) => {
      if (message.type === 'preview') {
        worker.emit({ type: 'previewDone', previewId: message.request.previewId, result: { data: new Uint8Array([1, 2]), mime: 'image/png', width: 2, height: 1, sourceWidth: 4, sourceHeight: 2 } });
      }
      if (message.type === 'inspect') worker.emit({ type: 'inspectDone', requestId: message.requestId, info: imageInfo(4, 2) });
      if (message.type === 'probe') worker.emit({ type: 'probeDone', requestId: message.requestId, probe: probeWith() });
    });
    const shown = await pool.preview(preview('p1'));
    expect(shown.width).toBe(2);
    expect((await pool.inspect(job('x').inputs[0]!, DEFAULT_PROCESSING_LIMITS)).orientedWidth).toBe(4);
    expect((await pool.probe()).pdfRender).toBe(true);
    expect(fleet.jobs()).toHaveLength(0); // no job worker was needed
  });

  it('cancelPreview rejects the pending preview and tells the worker', async () => {
    const { pool, fleet } = makePool(() => undefined);
    const pending = pool.preview(preview('p1'));
    await waitFor(() => fleet.aux()[0]?.ofType('preview').length === 1);
    pool.cancelPreview('p1');
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await waitFor(() => fleet.aux()[0]!.ofType('cancelPreview').length === 1);
  });

  it('an aux crash fails pending requests and the aux worker restarts', async () => {
    let crash = true;
    const { pool, fleet } = makePool((message, worker) => {
      if (message.type === 'probe') {
        if (crash) {
          crash = false;
          worker.exit(1);
        } else {
          worker.emit({ type: 'probeDone', requestId: message.requestId, probe: failedProbe(['x']) });
        }
      }
    });
    await expect(pool.probe()).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    await waitFor(() => fleet.aux().length === 2, 1000, 'aux restart');
    await expect(pool.probe()).resolves.toMatchObject({ errors: ['x'] });
  });

  it('times out previews that never answer', async () => {
    const { pool, fleet } = makePool(() => undefined, { previewTimeoutMs: 30 });
    await expect(pool.preview(preview('slow'))).rejects.toMatchObject({ code: 'TIMEOUT' });
    await waitFor(() => fleet.aux()[0]!.ofType('cancelPreview').length === 1);
  });
});

describe('ProcessorPool shutdown', () => {
  it('cancels running work and stops every worker', async () => {
    const { pool, fleet } = makePool(() => undefined);
    const running = pool.run(job('long'), { signal: controller().signal, onProgress: () => undefined });
    const outcome = running.then(
      () => 'resolved',
      (error: unknown) => (error as OrbitError).code,
    );
    await waitFor(() => fleet.jobs()[0]?.ofType('run').length === 1);
    await pool.shutdown(500);
    expect(await outcome).toBe('CANCELLED');
    expect(fleet.workers.every((w) => !w.alive)).toBe(true);
    await expect(pool.run(job('after'), { signal: controller().signal, onProgress: () => undefined })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('ProcessorPool review fixes', () => {
  it('start() keeps the worker count chosen from the settings before it', async () => {
    const fleet = fakeFleet(standardBehavior(() => undefined));
    const pool = new ProcessorPool({ fork: fleet.fork, jobWorkers: 1 });
    pools.push(pool);
    pool.setJobWorkers(3);
    pool.start();
    expect(pool.jobWorkerCount).toBe(3);
  });

  it('the job timeout starts when a worker has the job, not while it waits for one', async () => {
    const { pool } = makePool((message, worker) => {
      if (message.type !== 'run') return;
      const ms = message.job.jobId === 'long' ? 150 : 20;
      setTimeout(() => worker.emit({ type: 'done', jobId: message.job.jobId, result: result(`${message.job.jobId}.jpg`) }), ms);
    });
    const long = pool.run(job('long'), { signal: controller().signal, onProgress: () => undefined });
    // waits ~150 ms for the only worker, then needs 20 ms: well inside its own 100 ms limit
    const queued = pool.run(job('queued'), { signal: controller().signal, onProgress: () => undefined, timeoutMs: 100 });
    await expect(long).resolves.toBeDefined();
    await expect(queued).resolves.toMatchObject({ outputs: [{ path: '/tmp/in/queued.jpg' }] });
  });

  it('a running job past its timeout fails with TIMEOUT and its worker is stopped', async () => {
    const { pool, fleet } = makePool(() => undefined); // never answers
    await expect(pool.run(job('stuck'), { signal: controller().signal, onProgress: () => undefined, timeoutMs: 40 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await waitFor(() => fleet.jobs()[0]!.ofType('cancel').length === 1, 1000, 'cancel');
    await waitFor(() => fleet.jobs()[0]!.killCalls === 1, 1000, 'kill after grace');
  });

  it('a crash whose temp cleanup hangs (dead network folder) frees the worker anyway and fails without a retry', async () => {
    let first = true;
    const { pool } = makePool(
      (message, worker) => {
        if (message.type !== 'run') return;
        if (first) {
          first = false;
          setTimeout(() => worker.exit(1), 2);
        } else {
          worker.emit({ type: 'done', jobId: message.job.jobId, result: result('next.jpg') });
        }
      },
      { cleanup: () => new Promise<void>(() => undefined), cleanupTimeoutMs: 30 },
    );
    await expect(pool.run(job('crashed', '/Volumes/gone'), { signal: controller().signal, onProgress: () => undefined })).rejects.toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
    });
    await expect(pool.run(job('next'), { signal: controller().signal, onProgress: () => undefined })).resolves.toBeDefined();
  });

  it('an unresponsive aux worker is restarted after an inspect timeout', async () => {
    const { pool, fleet } = makePool(() => undefined, { inspectTimeoutMs: 30 });
    await waitFor(() => fleet.aux().length === 1);
    await expect(pool.inspect(job('x').inputs[0]!, DEFAULT_PROCESSING_LIMITS)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await waitFor(() => fleet.aux()[0]!.killCalls === 1, 1000, 'kill');
    await waitFor(() => fleet.aux().length === 2, 1000, 'restart');
  });

  it('a slow preview does not restart an aux worker that keeps answering other requests', async () => {
    const { pool, fleet } = makePool(
      (message, worker) => {
        if (message.type === 'probe') worker.emit({ type: 'probeDone', requestId: message.requestId, probe: probeWith() });
      },
      { previewTimeoutMs: 60 },
    );
    const slow = pool.preview(preview('slow'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.probe(); // the worker is alive and answering
    await expect(slow).rejects.toMatchObject({ code: 'TIMEOUT' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fleet.aux()[0]!.killCalls).toBe(0);
  });

  it('a preview cancelled while the aux worker is still starting is never sent to it', async () => {
    const fleet = fakeFleet(standardBehavior(() => undefined), 40); // slow worker start
    const pool = new ProcessorPool({ fork: fleet.fork, jobWorkers: 1 });
    pools.push(pool);
    pool.start();
    const abort = controller();
    const pending = pool.preview(preview('early'), abort.signal);
    abort.abort(new OrbitError('CANCELLED', 'superseded'));
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await waitFor(() => fleet.aux()[0]?.received.length !== undefined, 1000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fleet.aux()[0]!.ofType('preview')).toHaveLength(0);
  });

  it('a result that arrives after a cancel frees the worker for the next job', async () => {
    const { pool } = makePool((message, worker) => {
      if (message.type === 'cancel') worker.emit({ type: 'done', jobId: message.jobId, result: result('late.jpg') });
      if (message.type === 'run' && message.job.jobId === 'next') worker.emit({ type: 'done', jobId: 'next', result: result('next.jpg') });
    });
    const abort = controller();
    const running = pool.run(job('late'), { signal: abort.signal, onProgress: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort(new OrbitError('CANCELLED', 'Cancelled'));
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(pool.run(job('next'), { signal: controller().signal, onProgress: () => undefined })).resolves.toBeDefined();
  });

  it('stopping the pool waits for the temp cleanup of a job whose worker had to be killed', async () => {
    let cleaned = false;
    const fleet = fakeFleet(() => undefined); // ignores everything, including the stop request
    const pool = new ProcessorPool({
      fork: fleet.fork,
      jobWorkers: 1,
      cleanup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        cleaned = true;
      },
    });
    pool.start();
    const running = pool.run(job('busy'), { signal: controller().signal, onProgress: () => undefined }).catch(() => 'rejected');
    await waitFor(() => fleet.jobs()[0]?.ofType('run').length === 1, 1000, 'dispatched');
    await pool.shutdown(30, 1000);
    expect(cleaned).toBe(true);
    expect(await running).toBe('rejected');
    expect(fleet.workers.every((w) => !w.alive)).toBe(true);
  });
});

describe('outputDirsOf', () => {
  it('uses the explicit folder or each input folder once', () => {
    expect(outputDirsOf({ ...job('a'), outputDir: '/out' })).toEqual(['/out']);
    const merged: ProcessorJob = { ...job('m'), inputs: [job('a', '/x').inputs[0]!, job('b', '/y').inputs[0]!, job('c', '/x').inputs[0]!] };
    expect(outputDirsOf(merged)).toEqual(['/x', '/y']);
  });
});

describe('outputs committed by a job that does not finish', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-pool-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write an output like the processors do and report it like the worker host does. */
  async function commit(worker: FakeWorker, jobId: string, name: string, content = 'page'): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, content, { flag: 'wx' }); // never overwrites, like writeOutput
    const info = await stat(path);
    worker.emit({ type: 'committed', jobId, output: { path, dev: info.dev, ino: info.ino, size: info.size } });
    return path;
  }

  it('a crash mid-job removes the pages it committed before the job fails, so the retry writes the same names', async () => {
    const pages = ['report-p001.jpg', 'report-p002.jpg', 'report-p003.jpg'];
    let attempt = 0;
    const { pool } = makePool((message, worker) => {
      if (message.type !== 'run') return;
      attempt += 1;
      const { jobId } = message.job;
      void (async () => {
        if (attempt === 1) {
          await commit(worker, jobId, pages[0]!);
          await commit(worker, jobId, pages[1]!);
          worker.exit(139); // dies before page 3 and before reporting `done`
          return;
        }
        // The retry: with the names free it writes every page under its own name (no "report-p001 (2).jpg").
        const outputs = [];
        for (const name of pages) outputs.push({ path: await commit(worker, jobId, name), format: 'jpeg' as const, bytes: 4 });
        worker.emit({ type: 'done', jobId, result: { outputs, warnings: [] } });
      })().catch((error: unknown) => worker.emit({ type: 'failed', jobId, error: { code: 'INTERNAL', message: String(error), retryable: false } }));
    });
    const crashed = await pool.run(job('pdf'), { signal: controller().signal, onProgress: () => undefined }).catch((error: unknown) => error);
    expect(crashed).toMatchObject({ code: 'WORKER_CRASHED' });
    expect(await readdir(dir)).toEqual([]); // rolled back before the failure was reported (i.e. before any retry)
    const retried = await pool.run(job('pdf'), { signal: controller().signal, onProgress: () => undefined });
    expect(retried.outputs).toHaveLength(3);
    expect((await readdir(dir)).sort()).toEqual(pages);
  });

  it('leaves a committed file alone once it is not the same file any more', async () => {
    const { pool } = makePool((message, worker) => {
      if (message.type !== 'run') return;
      void (async () => {
        const path = await commit(worker, message.job.jobId, 'page.jpg', 'first');
        await unlink(path);
        await writeFile(path, 'replaced by the user'); // same name, another file
        await commit(worker, message.job.jobId, 'other.jpg', 'second');
        await writeFile(join(dir, 'other.jpg'), 'edited since'); // same file, another size
        worker.exit(1);
      })();
    });
    await expect(pool.run(job('j'), { signal: controller().signal, onProgress: () => undefined })).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    expect((await readdir(dir)).sort()).toEqual(['other.jpg', 'page.jpg']);
    expect(await readFile(join(dir, 'page.jpg'), 'utf8')).toBe('replaced by the user');
  });

  it('a worker killed after a cancel leaves none of its committed outputs', async () => {
    const { pool, fleet } = makePool((message, worker) => {
      if (message.type === 'run') void commit(worker, message.job.jobId, 'half.jpg'); // and then ignores `cancel`
    });
    const abort = controller();
    const running = pool.run(job('stuck'), { signal: abort.signal, onProgress: () => undefined });
    await waitFor(() => fleet.jobs()[0]?.ofType('run').length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20)); // the commit reached main
    abort.abort(new OrbitError('CANCELLED', 'Cancelled'));
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    await waitFor(() => fleet.jobs()[0]!.killCalls === 1, 1000, 'kill after the grace period');
    await expect.poll(async () => readdir(dir), { timeout: 2000 }).toEqual([]);
  });

  it('a cancelled job whose worker still reports `done` has its outputs removed (it counts as cancelled)', async () => {
    const { pool, fleet } = makePool((message, worker) => {
      if (message.type === 'run') void commit(worker, message.job.jobId, 'late.jpg');
      if (message.type === 'cancel') worker.emit({ type: 'done', jobId: message.jobId, result: { outputs: [{ path: join(dir, 'late.jpg'), format: 'jpeg', bytes: 4 }], warnings: [] } });
    });
    const abort = controller();
    const running = pool.run(job('late'), { signal: abort.signal, onProgress: () => undefined });
    await waitFor(() => fleet.jobs()[0]?.ofType('run').length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort(new OrbitError('CANCELLED', 'Cancelled'));
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(async () => readdir(dir), { timeout: 2000 }).toEqual([]);
  });

  it('rollbackCommitted ignores missing files and folders', async () => {
    await writeFile(join(dir, 'a.jpg'), 'x');
    const info = await stat(join(dir, 'a.jpg'));
    const folder = await stat(dir);
    expect(
      await rollbackCommitted([
        { path: join(dir, 'a.jpg'), dev: info.dev, ino: info.ino, size: info.size },
        { path: join(dir, 'missing.jpg'), dev: info.dev, ino: info.ino, size: 1 },
        { path: dir, dev: folder.dev, ino: folder.ino, size: folder.size },
      ]),
    ).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });
});
