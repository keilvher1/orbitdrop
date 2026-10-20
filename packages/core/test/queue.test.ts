import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbitError, type JobProgress } from '@orbitdrop/contracts';
import { JobQueue, type QueueEntry, type RunContext } from '../src';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Runner whose every call is controlled by the test. */
class Harness {
  readonly calls: { payload: string; ctx: RunContext; d: Deferred<string> }[] = [];
  readonly updates: QueueEntry<string, string>[] = [];
  readonly queue: JobQueue<string, string>;

  constructor(options: { concurrency?: number; timeoutMs?: number; maxCrashRetries?: number } = {}) {
    this.queue = new JobQueue<string, string>({
      concurrency: options.concurrency ?? 2,
      timeoutMs: options.timeoutMs ?? 0,
      ...(options.maxCrashRetries === undefined ? {} : { maxCrashRetries: options.maxCrashRetries }),
      runner: (payload, ctx) => {
        const d = deferred<string>();
        this.calls.push({ payload, ctx, d });
        return d.promise;
      },
      onUpdate: (entry) => this.updates.push(entry),
    });
  }

  started(): string[] {
    return this.calls.map((c) => c.payload);
  }

  call(payload: string, attempt = 1) {
    const found = this.calls.find((c) => c.payload === payload && c.ctx.attempt === attempt);
    if (!found) throw new Error(`no call for ${payload} attempt ${attempt}`);
    return found;
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('JobQueue scheduling', () => {
  it('runs at most `concurrency` jobs and starts them in FIFO order', async () => {
    const h = new Harness({ concurrency: 2 });
    for (const id of ['a', 'b', 'c', 'd']) h.queue.enqueue(id, id);
    expect(h.started()).toEqual(['a', 'b']);
    expect(h.queue.stats()).toEqual({ queued: 2, running: 2, settled: 0 });
    h.call('b').d.resolve('B');
    await flush();
    expect(h.started()).toEqual(['a', 'b', 'c']);
    h.call('a').d.resolve('A');
    await flush();
    expect(h.started()).toEqual(['a', 'b', 'c', 'd']);
    h.call('c').d.resolve('C');
    h.call('d').d.resolve('D');
    await flush();
    expect(h.queue.list().map((e) => [e.id, e.state, e.result])).toEqual([
      ['a', 'completed', 'A'],
      ['b', 'completed', 'B'],
      ['c', 'completed', 'C'],
      ['d', 'completed', 'D'],
    ]);
  });

  it('raises and lowers concurrency at runtime', async () => {
    const h = new Harness({ concurrency: 1 });
    for (const id of ['a', 'b', 'c', 'd']) h.queue.enqueue(id, id);
    expect(h.started()).toEqual(['a']);
    h.queue.setConcurrency(3);
    expect(h.started()).toEqual(['a', 'b', 'c']);
    h.queue.setConcurrency(1); // running jobs continue; nothing new starts until below the limit
    h.call('a').d.resolve('A');
    await flush();
    expect(h.started()).toEqual(['a', 'b', 'c']);
    h.call('b').d.resolve('B');
    h.call('c').d.resolve('C');
    await flush();
    expect(h.started()).toEqual(['a', 'b', 'c', 'd']);
    h.queue.setConcurrency(0);
    h.queue.enqueue('e', 'e');
    h.call('d').d.resolve('D');
    await flush();
    expect(h.started()).toContain('e'); // concurrency is clamped to at least 1
  });

  it('rejects duplicate ids until the old entry is pruned', async () => {
    const h = new Harness();
    h.queue.enqueue('a', 'a');
    expect(() => h.queue.enqueue('a', 'again')).toThrow(/duplicate/);
    h.queue.prune('a'); // still running: kept
    expect(h.queue.get('a')?.state).toBe('running');
    h.call('a').d.resolve('A');
    await flush();
    h.queue.prune('a');
    expect(h.queue.get('a')).toBeUndefined();
    expect(h.queue.enqueue('a', 'again').state).toBe('running');
  });

  it('reports progress, completes determinate progress and records timestamps from the injected clock', async () => {
    let now = 1000;
    const updates: QueueEntry<string, string>[] = [];
    const d = deferred<string>();
    let ctx!: RunContext;
    const queue = new JobQueue<string, string>({
      concurrency: 1,
      timeoutMs: 0,
      now: () => now,
      runner: (_p, c) => {
        ctx = c;
        return d.promise;
      },
      onUpdate: (e) => updates.push(e),
    });
    queue.enqueue('a', 'a');
    now = 1500;
    const progress: JobProgress = { kind: 'determinate', done: 1, total: 4, unit: 'page' };
    ctx.onProgress(progress);
    expect(queue.get('a')?.progress).toEqual(progress);
    now = 2000;
    d.resolve('ok');
    const done = await queue.waitFor('a');
    expect(done).toMatchObject({ state: 'completed', result: 'ok', enqueuedAt: 1000, startedAt: 1000, finishedAt: 2000 });
    expect(done.progress).toEqual({ kind: 'determinate', done: 4, total: 4, unit: 'page' });
    expect(updates.map((u) => u.state)).toEqual(['queued', 'running', 'running', 'completed']);
    ctx.onProgress({ kind: 'determinate', done: 2, total: 4, unit: 'page' });
    expect(queue.get('a')?.progress).toMatchObject({ done: 4 });
  });
});

describe('JobQueue cancellation', () => {
  it('cancels a queued job without ever starting it', async () => {
    const h = new Harness({ concurrency: 1 });
    h.queue.enqueue('a', 'a');
    h.queue.enqueue('b', 'b');
    expect(h.queue.cancel('b')).toBe(true);
    expect(h.queue.get('b')).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED' }, startedAt: null });
    h.call('a').d.resolve('A');
    await flush();
    expect(h.started()).toEqual(['a']);
  });

  it('cancels a running job: aborts its signal, frees the slot and ignores late results and progress', async () => {
    const h = new Harness({ concurrency: 1 });
    h.queue.enqueue('a', 'a');
    h.queue.enqueue('b', 'b');
    const a = h.call('a');
    expect(h.queue.cancel('a')).toBe(true);
    expect(a.ctx.signal.aborted).toBe(true);
    expect((a.ctx.signal.reason as OrbitError).code).toBe('CANCELLED');
    expect(h.started()).toEqual(['a', 'b']);
    a.ctx.onProgress({ kind: 'determinate', done: 1, total: 2, unit: 'step' });
    a.d.resolve('late result');
    await flush();
    expect(h.queue.get('a')).toMatchObject({ state: 'cancelled', result: null, progress: { kind: 'indeterminate' } });
    expect(h.queue.cancel('a')).toBe(false);
    expect(h.queue.cancel('unknown')).toBe(false);
  });

  it('ignores progress reported synchronously by abort listeners', () => {
    const h = new Harness({ concurrency: 1 });
    h.queue.enqueue('a', 'a');
    const a = h.call('a');
    a.ctx.signal.addEventListener('abort', () => a.ctx.onProgress({ kind: 'determinate', done: 9, total: 9, unit: 'step' }));
    h.queue.cancel('a');
    expect(h.updates.filter((u) => u.id === 'a' && u.progress.kind === 'determinate')).toEqual([]);
  });

  it('cancelAll cancels everything without starting queued jobs', async () => {
    const h = new Harness({ concurrency: 2 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) h.queue.enqueue(id, id);
    h.queue.cancelAll();
    await flush();
    expect(h.started()).toEqual(['a', 'b']);
    expect(h.queue.list().every((e) => e.state === 'cancelled')).toBe(true);
    expect(h.calls.every((c) => c.ctx.signal.aborted)).toBe(true);
  });

  it('treats a runner that reports CANCELLED itself as cancelled', async () => {
    const h = new Harness();
    h.queue.enqueue('a', 'a');
    h.call('a').d.reject(new OrbitError('CANCELLED', 'worker cancelled'));
    expect(await h.queue.waitFor('a')).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED' } });
  });
});

describe('JobQueue failures, timeouts and crash retries', () => {
  it('fails with TIMEOUT, aborts the runner and ignores its late result', async () => {
    vi.useFakeTimers();
    const h = new Harness({ concurrency: 1, timeoutMs: 100 });
    h.queue.enqueue('a', 'a');
    h.queue.enqueue('b', 'b');
    const a = h.call('a');
    await vi.advanceTimersByTimeAsync(99);
    expect(h.queue.get('a')?.state).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.queue.get('a')).toMatchObject({ state: 'failed', error: { code: 'TIMEOUT', retryable: true } });
    expect((a.ctx.signal.reason as OrbitError).code).toBe('TIMEOUT');
    expect(h.started()).toEqual(['a', 'b']);
    a.d.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.queue.get('a')?.result).toBeNull();
    // A job that finishes in time is not affected by its timer.
    h.call('b').d.resolve('B');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.queue.get('b')?.state).toBe('completed');
  });

  it('retries a WORKER_CRASHED job once, first in line, then fails', async () => {
    let now = 0;
    const calls: { payload: string; attempt: number; d: Deferred<string> }[] = [];
    const queue = new JobQueue<string, string>({
      concurrency: 1,
      timeoutMs: 0,
      now: () => (now += 10),
      runner: (payload, ctx) => {
        const d = deferred<string>();
        calls.push({ payload, attempt: ctx.attempt, d });
        return d.promise;
      },
    });
    queue.enqueue('a', 'a');
    queue.enqueue('b', 'b');
    const startedAt = queue.get('a')!.startedAt;
    calls[0]!.d.reject(new OrbitError('WORKER_CRASHED', 'worker died'));
    await flush();
    expect(calls.map((c) => [c.payload, c.attempt])).toEqual([
      ['a', 1],
      ['a', 2],
    ]);
    expect(queue.get('a')).toMatchObject({ state: 'running', attempt: 2, startedAt });
    calls[1]!.d.reject(new OrbitError('WORKER_CRASHED', 'worker died again'));
    await flush();
    expect(queue.get('a')).toMatchObject({ state: 'failed', attempt: 2, error: { code: 'WORKER_CRASHED', retryable: true } });
    expect(calls.map((c) => c.payload)).toEqual(['a', 'a', 'b']);
  });

  it('completes when the retry succeeds and honours maxCrashRetries', async () => {
    const h = new Harness({ concurrency: 1, maxCrashRetries: 2 });
    h.queue.enqueue('a', 'a');
    h.call('a', 1).d.reject(new OrbitError('WORKER_CRASHED', 'x'));
    await flush();
    h.call('a', 2).d.reject(new OrbitError('WORKER_CRASHED', 'x'));
    await flush();
    h.call('a', 3).d.resolve('third time');
    expect(await h.queue.waitFor('a')).toMatchObject({ state: 'completed', attempt: 3, result: 'third time' });
    const none = new Harness({ concurrency: 1, maxCrashRetries: 0 });
    none.queue.enqueue('x', 'x');
    none.call('x').d.reject(new OrbitError('WORKER_CRASHED', 'x'));
    expect(await none.queue.waitFor('x')).toMatchObject({ state: 'failed', attempt: 1 });
  });

  it('gives each crash retry a fresh timeout', async () => {
    vi.useFakeTimers();
    const h = new Harness({ concurrency: 1, timeoutMs: 100 });
    h.queue.enqueue('a', 'a');
    await vi.advanceTimersByTimeAsync(80);
    h.call('a', 1).d.reject(new OrbitError('WORKER_CRASHED', 'x'));
    await vi.advanceTimersByTimeAsync(80);
    expect(h.queue.get('a')).toMatchObject({ state: 'running', attempt: 2 });
    await vi.advanceTimersByTimeAsync(20);
    expect(h.queue.get('a')).toMatchObject({ state: 'failed', error: { code: 'TIMEOUT' } });
  });

  it('keeps OrbitError codes, maps other errors to INTERNAL and survives throwing or non-promise runners', async () => {
    const results: string[] = [];
    let mode = '';
    const queue = new JobQueue<string, string>({
      concurrency: 1,
      timeoutMs: 0,
      runner: ((payload: string) => {
        mode = payload;
        if (payload === 'sync-throw') throw new Error('boom');
        if (payload === 'plain') return 'plain value' as unknown as Promise<string>;
        if (payload === 'orbit') return Promise.reject(new OrbitError('PDF_ENCRYPTED', 'locked'));
        return Promise.reject(new TypeError('bad'));
      }) as (payload: string, ctx: RunContext) => Promise<string>,
      onUpdate: (e) => {
        if (e.finishedAt !== null) results.push(`${e.id}:${e.state}:${e.error?.code ?? e.result}`);
      },
    });
    for (const id of ['sync-throw', 'plain', 'orbit', 'other']) queue.enqueue(id, id);
    await queue.waitFor('other');
    expect(mode).toBe('other');
    expect(results).toEqual(['sync-throw:failed:INTERNAL', 'plain:completed:plain value', 'orbit:failed:PDF_ENCRYPTED', 'other:failed:INTERNAL']);
  });
});

describe('JobQueue waiting and listeners', () => {
  it('waitFor resolves every waiter once; settled and unknown jobs answer immediately', async () => {
    const h = new Harness();
    h.queue.enqueue('a', 'a');
    const w1 = h.queue.waitFor('a');
    const w2 = h.queue.waitFor('a');
    h.call('a').d.resolve('A');
    expect((await w1).result).toBe('A');
    expect((await w2).result).toBe('A');
    expect((await h.queue.waitFor('a')).state).toBe('completed');
    await expect(h.queue.waitFor('nope')).rejects.toThrow(/unknown job/);
  });

  it('a throwing onUpdate listener never breaks the queue', async () => {
    const errors: unknown[] = [];
    const d = deferred<string>();
    const queue = new JobQueue<string, string>({
      concurrency: 1,
      timeoutMs: 0,
      runner: () => d.promise,
      onUpdate: () => {
        throw new Error('listener bug');
      },
      onListenerError: (e) => errors.push(e),
    });
    queue.enqueue('a', 'a');
    queue.enqueue('b', 'b');
    d.resolve('A');
    const entry = await queue.waitFor('a');
    expect(entry.state).toBe('completed');
    expect(queue.get('b')?.state).toBe('running');
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('allows cancelling from inside onUpdate (re-entrancy)', async () => {
    let queue!: JobQueue<string, string>;
    const started: string[] = [];
    queue = new JobQueue<string, string>({
      concurrency: 1,
      timeoutMs: 0,
      runner: (payload) => {
        started.push(payload);
        return new Promise<string>(() => undefined);
      },
      onUpdate: (e) => {
        if (e.id === 'a' && e.state === 'running') queue.cancel('a');
      },
    });
    queue.enqueue('a', 'a');
    queue.enqueue('b', 'b');
    await flush();
    expect(queue.get('a')?.state).toBe('cancelled');
    expect(queue.get('b')?.state).toBe('running');
    expect(started).toEqual(['a', 'b']);
  });
});
