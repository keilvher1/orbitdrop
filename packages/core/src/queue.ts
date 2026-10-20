import { OrbitError, toErrorInfo, type JobProgress, type JobState, type OrbitErrorInfo } from '@orbitdrop/contracts';

/**
 * Generic bounded-concurrency job queue with cancellation, timeouts and
 * stale-result protection. Main wraps it (JobManager) with the processor pool
 * as the runner; tests drive it with fake runners.
 *
 * Guarantees:
 *  - at most `concurrency` jobs run at once; FIFO start order
 *  - a job settles exactly once (completed | failed | cancelled)
 *  - results or progress arriving after a job settled (late responses from a
 *    cancelled/timed-out run) are ignored
 *  - a job whose runner reports a worker crash is retried at most
 *    `maxCrashRetries` times before failing with WORKER_CRASHED
 */

export interface RunContext {
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly onProgress: (progress: JobProgress) => void;
}

export type Runner<P, R> = (payload: P, ctx: RunContext) => Promise<R>;

export interface QueueEntry<P, R> {
  readonly id: string;
  readonly payload: P;
  readonly state: JobState;
  readonly progress: JobProgress;
  readonly attempt: number;
  readonly enqueuedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly result: R | null;
  readonly error: OrbitErrorInfo | null;
}

export interface JobQueueOptions<P, R> {
  readonly concurrency: number;
  /** Per-attempt timeout; 0 disables. */
  readonly timeoutMs: number;
  readonly runner: Runner<P, R>;
  readonly onUpdate?: (entry: QueueEntry<P, R>) => void;
  readonly maxCrashRetries?: number;
  readonly now?: () => number;
}

interface MutableEntry<P, R> {
  id: string;
  payload: P;
  state: JobState;
  progress: JobProgress;
  attempt: number;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  result: R | null;
  error: OrbitErrorInfo | null;
  controller: AbortController | null;
  /** Incremented on every attempt; responses carrying an older token are stale. */
  token: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class JobQueue<P, R> {
  private readonly entries = new Map<string, MutableEntry<P, R>>();
  private readonly waiting: string[] = [];
  private running = 0;
  private concurrency: number;
  private readonly settledWaiters = new Map<string, ((entry: QueueEntry<P, R>) => void)[]>();

  constructor(private readonly options: JobQueueOptions<P, R>) {
    this.concurrency = Math.max(1, options.concurrency);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  enqueue(id: string, payload: P): QueueEntry<P, R> {
    if (this.entries.has(id)) throw new Error(`duplicate job id ${id}`);
    const entry: MutableEntry<P, R> = {
      id,
      payload,
      state: 'queued',
      progress: { kind: 'indeterminate' },
      attempt: 0,
      enqueuedAt: this.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      controller: null,
      token: 0,
      timer: null,
    };
    this.entries.set(id, entry);
    this.waiting.push(id);
    this.emit(entry);
    this.pump();
    return this.snapshot(entry);
  }

  /** Cancel a queued or running job. Returns false if unknown or already settled. */
  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.state === 'completed' || entry.state === 'failed' || entry.state === 'cancelled') return false;
    if (entry.state === 'queued') {
      const index = this.waiting.indexOf(id);
      if (index >= 0) this.waiting.splice(index, 1);
      this.settle(entry, 'cancelled', null, { code: 'CANCELLED', message: 'Cancelled', retryable: false });
      return true;
    }
    entry.controller?.abort(new OrbitError('CANCELLED', 'Cancelled'));
    this.finishRunning(entry);
    this.settle(entry, 'cancelled', null, { code: 'CANCELLED', message: 'Cancelled', retryable: false });
    this.pump();
    return true;
  }

  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, concurrency);
    this.pump();
  }

  get(id: string): QueueEntry<P, R> | undefined {
    const entry = this.entries.get(id);
    return entry ? this.snapshot(entry) : undefined;
  }

  list(): QueueEntry<P, R>[] {
    return [...this.entries.values()].map((e) => this.snapshot(e));
  }

  /** Forget settled jobs (history is kept by the caller). */
  prune(id: string): void {
    const entry = this.entries.get(id);
    if (entry && entry.finishedAt !== null) this.entries.delete(id);
  }

  /** Resolves when the job settles. */
  waitFor(id: string): Promise<QueueEntry<P, R>> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new Error(`unknown job ${id}`));
    if (entry.finishedAt !== null) return Promise.resolve(this.snapshot(entry));
    return new Promise((resolve) => {
      const list = this.settledWaiters.get(id) ?? [];
      list.push(resolve);
      this.settledWaiters.set(id, list);
    });
  }

  /** Cancel everything (app quit). */
  cancelAll(): void {
    for (const id of [...this.entries.keys()]) this.cancel(id);
  }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      const entry = this.entries.get(id);
      if (!entry || entry.state !== 'queued') continue;
      this.start(entry);
    }
  }

  private start(entry: MutableEntry<P, R>): void {
    this.running += 1;
    entry.state = 'running';
    entry.attempt += 1;
    entry.token += 1;
    entry.startedAt ??= this.now();
    entry.progress = { kind: 'indeterminate' };
    const token = entry.token;
    const controller = new AbortController();
    entry.controller = controller;
    if (this.options.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (entry.token !== token || entry.state !== 'running') return;
        controller.abort(new OrbitError('TIMEOUT', 'Job timed out'));
        this.finishRunning(entry);
        this.settle(entry, 'failed', null, { code: 'TIMEOUT', message: 'Job timed out', retryable: true });
        this.pump();
      }, this.options.timeoutMs);
    }
    this.emit(entry);

    const onProgress = (progress: JobProgress): void => {
      if (entry.token !== token || entry.state !== 'running') return;
      entry.progress = progress;
      this.emit(entry);
    };

    let promise: Promise<R>;
    try {
      promise = this.options.runner(entry.payload, { signal: controller.signal, attempt: entry.attempt, onProgress });
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      (result) => {
        if (entry.token !== token || entry.state !== 'running') return; // stale
        this.finishRunning(entry);
        this.settle(entry, 'completed', result, null);
        this.pump();
      },
      (error: unknown) => {
        if (entry.token !== token || entry.state !== 'running') return; // stale
        this.finishRunning(entry);
        const info = toErrorInfo(error);
        if (info.code === 'WORKER_CRASHED' && entry.attempt <= (this.options.maxCrashRetries ?? 1)) {
          entry.state = 'queued';
          this.waiting.unshift(entry.id);
          this.emit(entry);
        } else if (info.code === 'CANCELLED') {
          this.settle(entry, 'cancelled', null, info);
        } else {
          this.settle(entry, 'failed', null, info);
        }
        this.pump();
      },
    );
  }

  private finishRunning(entry: MutableEntry<P, R>): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.controller = null;
    entry.token += 1; // invalidate any in-flight responses of this attempt
    this.running = Math.max(0, this.running - 1);
  }

  private settle(entry: MutableEntry<P, R>, state: JobState, result: R | null, error: OrbitErrorInfo | null): void {
    entry.state = state;
    entry.result = result;
    entry.error = error;
    entry.finishedAt = this.now();
    if (state === 'completed' && entry.progress.kind === 'determinate') {
      entry.progress = { ...entry.progress, done: entry.progress.total };
    }
    const snapshot = this.emit(entry);
    const waiters = this.settledWaiters.get(entry.id);
    this.settledWaiters.delete(entry.id);
    waiters?.forEach((resolve) => resolve(snapshot));
  }

  private snapshot(entry: MutableEntry<P, R>): QueueEntry<P, R> {
    return {
      id: entry.id,
      payload: entry.payload,
      state: entry.state,
      progress: entry.progress,
      attempt: entry.attempt,
      enqueuedAt: entry.enqueuedAt,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      result: entry.result,
      error: entry.error,
    };
  }

  private emit(entry: MutableEntry<P, R>): QueueEntry<P, R> {
    const snapshot = this.snapshot(entry);
    this.options.onUpdate?.(snapshot);
    return snapshot;
  }
}
