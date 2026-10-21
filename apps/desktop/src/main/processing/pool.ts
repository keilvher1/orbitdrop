import {
  OrbitError,
  type EngineProbe,
  type ImageInfo,
  type JobProgress,
  type MainToProcessorMessage,
  type OrbitErrorInfo,
  type PreviewRequest,
  type PreviewResult,
  type ProcessingLimits,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorToMainMessage,
} from '@orbitdrop/contracts';
import { cleanupTempFiles } from '@orbitdrop/core/node';
import { describeError, silentLogger, type Logger } from '../log';
import { delay } from '../util/concurrency';
import { publicErrorInfo } from '../util/errors';
import { newId } from '../util/ids';

/**
 * ProcessorPool: runs @orbitdrop/processors in isolated worker processes
 * (Electron utilityProcess in the app, fakes in tests).
 *
 *  - N job workers, one job at a time each (N = settings.processing.concurrency).
 *    They start lazily and stop after being idle for a while.
 *  - One dedicated "aux" worker for previews, image inspection and the engine
 *    probe, so an editor preview never waits behind a long conversion. An aux
 *    worker that stops answering is killed and restarted.
 *  - Timeout: counted from the moment a worker has the job (waiting for a free
 *    worker does not count).
 *  - Cancel/timeout: `cancel` is sent; if the worker does not confirm within
 *    the grace period it is killed (and restarted on demand).
 *  - Crash: a worker exiting during a job fails the job with WORKER_CRASHED
 *    (the JobQueue retries once) after its temp files were cleaned up with
 *    `cleanupTempFiles(dir, jobId)`. Cleanup finishes before the retry starts,
 *    because the retry reuses the job id as temp-file tag; if the output folder
 *    does not answer within `cleanupTimeoutMs` the slot is freed anyway and the
 *    job fails without an automatic retry (OUTPUT_WRITE_FAILED).
 *  - Shutdown waits (bounded) for worker exits and for those cleanups.
 */

export interface WorkerProcess {
  readonly pid: number | undefined;
  postMessage(message: MainToProcessorMessage): void;
  kill(): boolean;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
}

export type WorkerRole = 'job' | 'aux';
export type WorkerFactory = (role: WorkerRole, index: number) => WorkerProcess;

export interface PoolRunContext {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: JobProgress) => void;
  /** Time limit counted once a worker has the job; undefined/0 = none. */
  readonly timeoutMs?: number;
}

export interface ProcessorPoolOptions {
  readonly fork: WorkerFactory;
  /** Job workers created by start() if setJobWorkers() was not called before. */
  readonly jobWorkers: number;
  readonly cancelGraceMs?: number;
  readonly readyTimeoutMs?: number;
  /** Job workers idle this long are stopped (0 = keep them). */
  readonly idleShutdownMs?: number;
  readonly restartBaseMs?: number;
  readonly restartMaxMs?: number;
  readonly previewTimeoutMs?: number;
  readonly inspectTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  /** Remove temp files a crashed/killed job left behind. */
  readonly cleanup?: (dirs: readonly string[], jobId: string) => Promise<void>;
  /** Longest wait for that cleanup before the worker slot is reused anyway. */
  readonly cleanupTimeoutMs?: number;
  readonly log?: Logger;
  readonly now?: () => number;
}

type SlotState = 'stopped' | 'starting' | 'ready' | 'stopping';

interface ActiveJob {
  readonly jobId: string;
  readonly dirs: readonly string[];
  readonly onProgress: (progress: JobProgress) => void;
  readonly resolve: (result: ProcessorResult) => void;
  readonly reject: (error: Error) => void;
  aborted: boolean;
  settled: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  detach: () => void;
}

interface PendingRequest {
  readonly kind: 'preview' | 'inspect' | 'probe';
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly detach: () => void;
}

interface Waiter {
  readonly resolve: (slot: WorkerSlot) => void;
  readonly reject: (error: Error) => void;
}

class WorkerSlot {
  state: SlotState = 'stopped';
  process: WorkerProcess | null = null;
  generation = 0;
  ready: Promise<void> | null = null;
  readyResolve: (() => void) | null = null;
  readyReject: ((error: Error) => void) | null = null;
  busy = false;
  job: ActiveJob | null = null;
  retired = false;
  crashes = 0;
  startedAt = 0;
  lastMessageAt = 0;
  idleTimer: ReturnType<typeof setTimeout> | null = null;
  killTimer: ReturnType<typeof setTimeout> | null = null;
  exitWaiters: (() => void)[] = [];

  constructor(
    readonly role: WorkerRole,
    readonly index: number,
  ) {}
}

/** Worker error → OrbitError, with message/detail scrubbed of paths (they reach the renderer and history). */
export function errorFromInfo(info: OrbitErrorInfo): OrbitError {
  const clean = publicErrorInfo(info);
  return new OrbitError(clean.code, clean.message, clean.detail === undefined ? undefined : { detail: clean.detail });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new OrbitError('CANCELLED', 'Cancelled');
}

/** Folders a job writes into (its temp files live there too). */
export function outputDirsOf(job: ProcessorJob): string[] {
  if (job.outputDir) return [job.outputDir];
  return [...new Set(job.inputs.map((input) => input.sourceDir))];
}

async function defaultCleanup(dirs: readonly string[], jobId: string): Promise<void> {
  await Promise.all(dirs.map((dir) => cleanupTempFiles(dir, jobId).catch(() => 0)));
}

function isMessage(value: unknown): value is ProcessorToMainMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/** Resolves when `promise` settles or after `ms`, whichever comes first (never rejects). */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([promise.then(() => undefined, () => undefined), delay(ms)]);
}

export class ProcessorPool {
  private readonly jobSlots: WorkerSlot[] = [];
  private readonly aux = new WorkerSlot('aux', 0);
  private readonly waiters: Waiter[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  /** Temp-file cleanups of crashed/killed jobs still running (awaited by shutdown). */
  private readonly cleanups = new Set<Promise<boolean>>();
  private readonly log: Logger;
  private readonly now: () => number;
  private nextIndex = 0;
  private closed = false;
  private started = false;
  private readonly auxListeners = new Set<() => void>();

  constructor(private readonly options: ProcessorPoolOptions) {
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  /** Start the aux worker (probe/preview) and create the job slots (their processes start on demand). */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Keep a size chosen with setJobWorkers() before start (from the settings).
    if (this.jobSlots.length === 0) this.setJobWorkers(this.options.jobWorkers);
    this.spawn(this.aux).catch((error: unknown) => this.log.warn('aux worker failed to start', { error: describeError(error) }));
  }

  /** Called when the aux worker became ready after a restart. */
  onAuxReady(listener: () => void): () => void {
    this.auxListeners.add(listener);
    return () => this.auxListeners.delete(listener);
  }

  setJobWorkers(count: number): void {
    const target = Math.max(1, Math.min(8, Math.floor(count)));
    const active = this.jobSlots.filter((slot) => !slot.retired);
    if (target > active.length) {
      for (let i = active.length; i < target; i += 1) {
        const slot = new WorkerSlot('job', this.nextIndex);
        this.nextIndex += 1;
        this.jobSlots.push(slot);
        this.handOff(slot);
      }
    } else if (target < active.length) {
      const extra = active.length - target;
      const order = [...active].sort((a, b) => Number(a.busy) - Number(b.busy));
      for (const slot of order.slice(0, extra)) {
        slot.retired = true;
        if (!slot.busy) this.stopSlot(slot);
      }
    }
    this.pruneRetired();
  }

  get jobWorkerCount(): number {
    return this.jobSlots.filter((slot) => !slot.retired).length;
  }

  stats(): { readonly jobWorkers: number; readonly runningJobs: number; readonly liveProcesses: number; readonly auxState: SlotState } {
    const live = [...this.jobSlots, this.aux].filter((slot) => slot.process !== null).length;
    return {
      jobWorkers: this.jobWorkerCount,
      runningJobs: this.jobSlots.filter((slot) => slot.job !== null).length,
      liveProcesses: live,
      auxState: this.aux.state,
    };
  }

  // ------------------------------------------------------------------ jobs

  async run(job: ProcessorJob, ctx: PoolRunContext): Promise<ProcessorResult> {
    if (ctx.signal.aborted) throw abortError(ctx.signal);
    const slot = await this.acquire(ctx.signal);
    try {
      await this.spawn(slot);
    } catch (error) {
      this.release(slot);
      throw error instanceof OrbitError ? error : new OrbitError('WORKER_CRASHED', 'Processor worker failed to start');
    }
    if (ctx.signal.aborted) {
      this.release(slot);
      throw abortError(ctx.signal);
    }
    return new Promise<ProcessorResult>((resolve, reject) => {
      const active: ActiveJob = {
        jobId: job.jobId,
        dirs: outputDirsOf(job),
        onProgress: ctx.onProgress,
        resolve,
        reject,
        aborted: false,
        settled: false,
        graceTimer: null,
        timeoutTimer: null,
        detach: () => undefined,
      };
      const onAbort = (): void => this.abortJob(slot, active, abortError(ctx.signal));
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      active.detach = () => ctx.signal.removeEventListener('abort', onAbort);
      const child = slot.process;
      if (!child) {
        // The worker vanished between start and dispatch: fail like a crash (the queue retries once).
        active.detach();
        active.settled = true;
        this.release(slot);
        reject(new OrbitError('WORKER_CRASHED', 'Processor worker is not running'));
        return;
      }
      slot.job = active;
      try {
        child.postMessage({ type: 'run', job });
      } catch (error) {
        this.log.error('could not send job to worker', { jobId: job.jobId, error: describeError(error) });
        this.kill(slot); // the exit handler fails the job with WORKER_CRASHED after cleanup
        return;
      }
      if (ctx.timeoutMs !== undefined && ctx.timeoutMs > 0) {
        active.timeoutTimer = setTimeout(() => {
          active.timeoutTimer = null;
          this.log.warn('job timed out', { jobId: active.jobId });
          this.abortJob(slot, active, new OrbitError('TIMEOUT', 'Job timed out'));
        }, ctx.timeoutMs);
        active.timeoutTimer.unref?.();
      }
    });
  }

  private acquire(signal: AbortSignal): Promise<WorkerSlot> {
    if (this.closed) return Promise.reject(new OrbitError('CANCELLED', 'Shutting down'));
    const free = this.jobSlots
      .filter((slot) => !slot.busy && !slot.retired && slot.state !== 'stopping')
      .sort((a, b) => Number(b.state === 'ready') - Number(a.state === 'ready'))[0];
    if (free) {
      this.claim(free);
      return Promise.resolve(free);
    }
    return new Promise<WorkerSlot>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError(signal));
      };
      const waiter: Waiter = {
        resolve: (slot) => {
          signal.removeEventListener('abort', onAbort);
          resolve(slot);
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private claim(slot: WorkerSlot): void {
    slot.busy = true;
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
  }

  private release(slot: WorkerSlot): void {
    slot.busy = false;
    slot.job = null;
    if (slot.retired || this.closed) {
      this.stopSlot(slot);
      this.pruneRetired();
      return;
    }
    this.handOff(slot);
  }

  /** Give a free slot to the next waiter, or arm its idle timer. */
  private handOff(slot: WorkerSlot): void {
    if (slot.busy || slot.retired) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.claim(slot);
      waiter.resolve(slot);
      return;
    }
    const idleMs = this.options.idleShutdownMs ?? 0;
    if (idleMs > 0 && slot.state === 'ready' && !slot.idleTimer) {
      slot.idleTimer = setTimeout(() => {
        slot.idleTimer = null;
        if (!slot.busy) this.stopSlot(slot);
      }, idleMs);
      slot.idleTimer.unref?.();
    }
  }

  /** Cancel or time out a running job: settle it now, ask the worker to stop, kill it after the grace period. */
  private abortJob(slot: WorkerSlot, active: ActiveJob, reason: Error): void {
    if (active.aborted || slot.job !== active) return;
    active.aborted = true;
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    active.timeoutTimer = null;
    if (!active.settled) {
      active.settled = true;
      active.reject(reason);
    }
    try {
      slot.process?.postMessage({ type: 'cancel', jobId: active.jobId });
    } catch {
      // worker already gone; the exit handler cleans up
    }
    active.graceTimer = setTimeout(() => {
      if (slot.job !== active) return;
      this.log.warn('worker did not stop after cancel; killing it', { jobId: active.jobId });
      this.kill(slot);
    }, this.options.cancelGraceMs ?? 3000);
    active.graceTimer.unref?.();
  }

  private finishJob(slot: WorkerSlot, active: ActiveJob, settle: () => void): void {
    if (active.graceTimer) clearTimeout(active.graceTimer);
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    active.graceTimer = null;
    active.timeoutTimer = null;
    active.detach();
    if (!active.settled) {
      active.settled = true;
      settle();
    }
    this.release(slot);
  }

  // ------------------------------------------------------------------ aux requests

  preview(request: PreviewRequest, signal?: AbortSignal): Promise<PreviewResult> {
    return this.auxRequest<PreviewResult>('preview', request.previewId, { type: 'preview', request }, this.options.previewTimeoutMs ?? 60_000, signal);
  }

  /** Cancel a preview: the worker aborts it and a pending promise rejects with CANCELLED. */
  cancelPreview(previewId: string): void {
    const pending = this.pending.get(previewId);
    if (pending) {
      this.pending.delete(previewId);
      clearTimeout(pending.timer);
      pending.detach();
      pending.reject(new OrbitError('CANCELLED', 'Preview superseded'));
    }
    this.safePost(this.aux, { type: 'cancelPreview', previewId });
  }

  /** Ask the aux worker to drop its cached preview decodes (no-op if it isn't running). */
  clearPreviewCaches(): void {
    this.safePost(this.aux, { type: 'clearPreviewCaches' });
  }

  inspect(input: ProcessorInput, limits: ProcessingLimits): Promise<ImageInfo> {
    const requestId = newId('rq');
    return this.auxRequest<ImageInfo>('inspect', requestId, { type: 'inspect', requestId, input, limits }, this.options.inspectTimeoutMs ?? 30_000);
  }

  probe(): Promise<EngineProbe> {
    const requestId = newId('rq');
    return this.auxRequest<EngineProbe>('probe', requestId, { type: 'probe', requestId }, this.options.probeTimeoutMs ?? 30_000);
  }

  private async auxRequest<T>(
    kind: PendingRequest['kind'],
    id: string,
    message: MainToProcessorMessage,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) throw new OrbitError('CANCELLED', 'Shutting down');
    if (signal?.aborted) throw abortError(signal);
    await this.spawn(this.aux);
    if (signal?.aborted) throw abortError(signal);
    return new Promise<T>((resolve, reject) => {
      const sentAt = this.now();
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        pending.detach();
        if (kind === 'preview') this.safePost(this.aux, { type: 'cancelPreview', previewId: id });
        reject(new OrbitError('TIMEOUT', `${kind} timed out`));
        // Inspect and probe are quick; a preview may be slow, but silence since it was sent means the
        // worker's event loop is stuck. Either way: restart the aux worker so later requests can work.
        if (kind !== 'preview' || this.aux.lastMessageAt < sentAt) {
          this.log.warn('preview worker unresponsive; restarting it', { kind });
          this.kill(this.aux);
        }
      }, timeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        if (kind === 'preview') this.cancelPreview(id);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const pending: PendingRequest = {
        kind,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      this.pending.set(id, pending);
      if (!this.safePost(this.aux, message)) {
        this.pending.delete(id);
        clearTimeout(timer);
        pending.detach();
        reject(new OrbitError('WORKER_CRASHED', 'Preview worker is not available'));
      }
    });
  }

  private settlePending(id: string, outcome: { readonly value: unknown } | { readonly error: Error }): void {
    const pending = this.pending.get(id);
    if (!pending) return; // stale (cancelled, timed out)
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.detach();
    if ('error' in outcome) pending.reject(outcome.error);
    else pending.resolve(outcome.value);
  }

  // ------------------------------------------------------------------ worker lifecycle

  private spawn(slot: WorkerSlot): Promise<void> {
    if (this.closed) return Promise.reject(new OrbitError('CANCELLED', 'Shutting down'));
    if (slot.state === 'ready') return Promise.resolve();
    if (slot.state === 'starting' && slot.ready) return slot.ready;
    slot.state = 'starting';
    slot.generation += 1;
    // A kill fallback armed for a previous process must not suppress the new process's one.
    if (slot.killTimer) clearTimeout(slot.killTimer);
    slot.killTimer = null;
    const generation = slot.generation;
    const ready = (async () => {
      const backoff =
        slot.crashes > 0
          ? Math.min(this.options.restartMaxMs ?? 5000, (this.options.restartBaseMs ?? 250) * 2 ** (slot.crashes - 1))
          : 0;
      if (backoff > 0) await delay(backoff);
      if (this.closed || slot.generation !== generation) throw new OrbitError('CANCELLED', 'Worker start abandoned');
      let child: WorkerProcess;
      try {
        child = this.options.fork(slot.role, slot.index);
      } catch (error) {
        slot.state = 'stopped';
        slot.crashes += 1;
        throw new OrbitError('WORKER_CRASHED', 'Could not start a processor worker', { detail: describeError(error) });
      }
      slot.process = child;
      slot.startedAt = this.now();
      child.onMessage((message) => this.onMessage(slot, generation, message));
      child.onExit((code) => this.onExit(slot, generation, code));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new OrbitError('WORKER_CRASHED', 'Processor worker did not start in time'));
          this.kill(slot);
        }, this.options.readyTimeoutMs ?? 20_000);
        timer.unref?.();
        slot.readyResolve = () => {
          clearTimeout(timer);
          resolve();
        };
        slot.readyReject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      });
      slot.readyResolve = null;
      slot.readyReject = null;
      if (slot.generation === generation && slot.state === 'starting') slot.state = 'ready';
    })();
    slot.ready = ready;
    ready.catch(() => {
      if (slot.generation === generation && slot.state === 'starting') slot.state = 'stopped';
    });
    return ready;
  }

  private onMessage(slot: WorkerSlot, generation: number, raw: unknown): void {
    if (generation !== slot.generation || !isMessage(raw)) return;
    slot.lastMessageAt = this.now();
    const message = raw;
    switch (message.type) {
      case 'ready':
        this.log.debug('worker ready', { role: slot.role, index: slot.index, pid: message.pid });
        slot.readyResolve?.();
        if (slot.role === 'aux') {
          for (const listener of this.auxListeners) listener();
        }
        return;
      case 'progress':
      case 'done':
      case 'failed':
      case 'cancelled': {
        const active = slot.job;
        if (!active || active.jobId !== message.jobId) return; // late message of a finished job
        if (message.type === 'progress') {
          if (!active.aborted) active.onProgress(message.progress);
          return;
        }
        if (message.type === 'done') {
          slot.crashes = 0;
          if (active.aborted) {
            // Finished just as it was cancelled: the files exist, but the job already counts as cancelled.
            this.log.info('job finished after it was cancelled; result not registered', { jobId: active.jobId, outputs: message.result.outputs.length });
          }
          this.finishJob(slot, active, () => active.resolve(message.result));
        } else if (message.type === 'failed') {
          this.finishJob(slot, active, () => active.reject(errorFromInfo(message.error)));
        } else {
          this.finishJob(slot, active, () => active.reject(new OrbitError('CANCELLED', 'Cancelled')));
        }
        return;
      }
      case 'previewDone':
        this.settlePending(message.previewId, { value: message.result });
        return;
      case 'previewFailed':
        this.settlePending(message.previewId, { error: errorFromInfo(message.error) });
        return;
      case 'inspectDone':
        this.settlePending(message.requestId, { value: message.info });
        return;
      case 'inspectFailed':
        this.settlePending(message.requestId, { error: errorFromInfo(message.error) });
        return;
      case 'probeDone':
        this.settlePending(message.requestId, { value: message.probe });
        return;
      default:
        return;
    }
  }

  private onExit(slot: WorkerSlot, generation: number, code: number): void {
    if (generation !== slot.generation) return;
    const intentional = slot.state === 'stopping';
    slot.state = 'stopped';
    slot.process = null;
    slot.ready = null;
    slot.generation += 1; // ignore anything else from this process
    if (slot.killTimer) clearTimeout(slot.killTimer);
    slot.killTimer = null;
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    slot.readyReject?.(new OrbitError('WORKER_CRASHED', `Processor worker exited before it was ready (code ${code})`));
    slot.readyReject = null;
    slot.readyResolve = null;

    const active = slot.job;
    if (!intentional || active) {
      const livedMs = this.now() - slot.startedAt;
      slot.crashes = livedMs > 30_000 ? 1 : slot.crashes + 1;
      if (!active?.aborted) this.log.warn('processor worker exited', { role: slot.role, index: slot.index, code, crashes: slot.crashes });
    }

    if (slot.role === 'aux') {
      for (const [id, pending] of [...this.pending]) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.detach();
        pending.reject(new OrbitError('WORKER_CRASHED', 'Preview worker stopped unexpectedly'));
      }
      // Restart eagerly (previews should not wait for a cold start), but not forever in a crash loop:
      // after repeated quick crashes the next preview/inspect/probe request starts it on demand.
      if (!this.closed && !intentional && slot.crashes <= 5) {
        this.spawn(this.aux).catch((error: unknown) => this.log.warn('aux worker restart failed', { error: describeError(error) }));
      }
      this.resolveExitWaiters(slot);
      return;
    }

    if (!active) {
      this.resolveExitWaiters(slot);
      if (slot.retired) this.pruneRetired();
      else if (!slot.busy) this.handOff(slot);
      return;
    }
    slot.job = null;
    if (active.graceTimer) clearTimeout(active.graceTimer);
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    active.graceTimer = null;
    active.timeoutTimer = null;
    active.detach();
    const cleanup = this.options.cleanup ?? defaultCleanup;
    const finished = cleanup(active.dirs, active.jobId).then(
      () => true,
      (error: unknown) => {
        this.log.warn('temp cleanup failed', { jobId: active.jobId, error: describeError(error) });
        return true;
      },
    );
    this.cleanups.add(finished);
    void finished.finally(() => this.cleanups.delete(finished));
    // Registered before the exit waiters run, so shutdown() sees (and awaits) this cleanup.
    this.resolveExitWaiters(slot);
    const timeoutMs = this.options.cleanupTimeoutMs ?? 10_000;
    void Promise.race([finished, delay(timeoutMs).then(() => false)]).then((done) => {
      if (!done) this.log.warn('temp cleanup did not finish in time; output folder unresponsive', { jobId: active.jobId });
      if (!active.settled) {
        active.settled = true;
        active.reject(
          done
            ? new OrbitError('WORKER_CRASHED', `Processor worker stopped unexpectedly (exit code ${code})`)
            : // Not WORKER_CRASHED: an automatic retry (same temp-file tag) must not race the unfinished cleanup.
              new OrbitError('OUTPUT_WRITE_FAILED', 'The processor stopped and the output folder did not respond'),
        );
      }
      this.release(slot);
    });
  }

  private resolveExitWaiters(slot: WorkerSlot): void {
    const waiters = slot.exitWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  private safePost(slot: WorkerSlot, message: MainToProcessorMessage): boolean {
    if (!slot.process) return false;
    try {
      slot.process.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  private kill(slot: WorkerSlot): void {
    const child = slot.process;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // already gone
    }
    // If no exit event arrives, treat the process as gone so the pool can recover.
    if (!slot.killTimer) {
      const generation = slot.generation;
      slot.killTimer = setTimeout(() => {
        slot.killTimer = null;
        if (slot.generation === generation && slot.process === child) this.onExit(slot, generation, -1);
      }, 5000);
      slot.killTimer.unref?.();
    }
  }

  private stopSlot(slot: WorkerSlot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    if (!slot.process || slot.state === 'stopping') return;
    slot.state = 'stopping';
    this.safePost(slot, { type: 'shutdown' });
    const generation = slot.generation;
    const timer = setTimeout(() => {
      if (slot.generation === generation && slot.process) this.kill(slot);
    }, 2500);
    timer.unref?.();
  }

  private pruneRetired(): void {
    for (let i = this.jobSlots.length - 1; i >= 0; i -= 1) {
      const slot = this.jobSlots[i]!;
      if (slot.retired && !slot.busy && slot.process === null) this.jobSlots.splice(i, 1);
    }
  }

  /**
   * Stop all workers. Running jobs are cancelled; workers get `timeoutMs` to
   * exit by themselves (their processors remove temp files on abort), then
   * they are killed, and temp-file cleanups of interrupted jobs are awaited
   * (bounded by `cleanupWaitMs`).
   */
  async shutdown(timeoutMs = 2500, cleanupWaitMs = 3000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new OrbitError('CANCELLED', 'Shutting down'));
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.detach();
      pending.reject(new OrbitError('CANCELLED', 'Shutting down'));
    }
    const live = [...this.jobSlots, this.aux].filter((slot) => slot.process !== null);
    const exits = live.map(
      (slot) =>
        new Promise<void>((resolve) => {
          slot.exitWaiters.push(resolve);
          const active = slot.job;
          if (active) {
            if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
            active.timeoutTimer = null;
            active.aborted = true;
            if (!active.settled) {
              active.settled = true;
              active.reject(new OrbitError('CANCELLED', 'Shutting down'));
            }
          }
          slot.state = 'stopping';
          this.safePost(slot, { type: 'shutdown' });
        }),
    );
    await settleWithin(Promise.all(exits), timeoutMs);
    const stragglers = live.filter((slot) => slot.process !== null);
    for (const slot of stragglers) this.kill(slot);
    if (stragglers.length > 0) await settleWithin(Promise.all(exits), 1000);
    if (this.cleanups.size > 0) await settleWithin(Promise.all([...this.cleanups]), cleanupWaitMs);
  }
}
