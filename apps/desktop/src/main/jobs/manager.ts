import {
  DEFAULT_PROCESSING_LIMITS,
  OrbitError,
  TERMINAL_JOB_STATES,
  type ActionId,
  type JobProgress,
  type JobSnapshot,
  type JobWarning,
  type OutputFileInfo,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorSettings,
  type SelectionSource,
  type Settings,
} from '@orbitdrop/contracts';
import { JobQueue, type QueueEntry, type RunContext } from '@orbitdrop/core';
import type { OutputRegistry } from '../files/outputs';
import type { HistoryEntry, HistoryOutput, HistoryStore } from '../history/store';
import { describeError, silentLogger, type Logger } from '../log';
import { newId } from '../util/ids';

/**
 * JobManager: the core JobQueue (bounded concurrency, FIFO, cancel, crash
 * retry, stale-result protection) with the processor pool as runner. Adds:
 * per-job timeout from the live settings, output registration (outputIds),
 * history, throttled `jobsChanged` broadcasts and a settle hook for
 * notifications.
 */

export interface JobOrigin {
  readonly source: SelectionSource;
  /** Drag session that produced the job (global drag only). */
  readonly sessionId: string | null;
}

export interface JobSpec {
  readonly actionId: ActionId;
  /** One input, or several (in order) for merging actions. */
  readonly inputs: readonly ProcessorInput[];
  /** Options already validated against the action schema. */
  readonly options: unknown;
  /** null = next to each input. */
  readonly outputDir: string | null;
  readonly assets?: Readonly<Record<string, ProcessorInput>>;
  readonly origin: JobOrigin;
}

export interface JobRecordView {
  readonly jobId: string;
  readonly batchId: string | null;
  readonly spec: JobSpec;
  readonly snapshot: JobSnapshot;
}

export type PoolRunner = (
  job: ProcessorJob,
  ctx: { readonly signal: AbortSignal; readonly onProgress: (progress: JobProgress) => void; readonly timeoutMs?: number },
) => Promise<ProcessorResult>;

export interface JobManagerDeps {
  readonly run: PoolRunner;
  readonly settings: () => Settings;
  readonly outputs: OutputRegistry;
  readonly history: HistoryStore;
  readonly onChanged?: (jobs: readonly JobSnapshot[]) => void;
  readonly onSettled?: (job: JobRecordView) => void;
  readonly log?: Logger;
  readonly now?: () => number;
  readonly broadcastDelayMs?: number;
  /** Session records kept in memory (older finished jobs remain in history). */
  readonly maxRecords?: number;
}

interface JobRecord {
  readonly jobId: string;
  readonly batchId: string | null;
  readonly spec: JobSpec;
  readonly createdAt: number;
  entry: QueueEntry<ProcessorJob, ProcessorResult> | null;
  outputs: readonly OutputFileInfo[];
  outputPaths: readonly HistoryOutput[];
  /** Jobs main completed without running (e.g. file already in the target format). */
  readonly skipped: readonly JobWarning[] | null;
  settledReported: boolean;
}

export function processorSettings(settings: Settings): ProcessorSettings {
  return {
    pdfDpi: settings.pdf.dpi,
    jpegQuality: settings.output.jpegQuality,
    webpQuality: settings.output.webpQuality,
    avifQuality: settings.output.avifQuality,
    heicQuality: settings.output.heicQuality,
  };
}

const LIST_LIMIT = 200;

export class JobManager {
  private readonly records = new Map<string, JobRecord>();
  private readonly historyOutputs = new Map<string, readonly OutputFileInfo[]>();
  private readonly queue: JobQueue<ProcessorJob, ProcessorResult>;
  private readonly log: Logger;
  private readonly now: () => number;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: JobManagerDeps) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.queue = new JobQueue<ProcessorJob, ProcessorResult>({
      concurrency: deps.settings().processing.concurrency,
      timeoutMs: 0, // per-job timeout handled in runWithTimeout (reads the live setting)
      runner: (job, ctx) => this.runWithTimeout(job, ctx),
      onUpdate: (entry) => this.onUpdate(entry),
      maxCrashRetries: 1,
      now: this.now,
    });
  }

  /** Enqueue jobs. Returns their ids in order. */
  submit(specs: readonly JobSpec[], batchId: string | null): string[] {
    const settings = this.deps.settings();
    const ids: string[] = [];
    for (const spec of specs) {
      if (spec.inputs.length === 0) throw new OrbitError('INTERNAL', 'Job without inputs');
      const jobId = newId('job');
      const record: JobRecord = {
        jobId,
        batchId,
        spec,
        createdAt: this.now(),
        entry: null,
        outputs: [],
        outputPaths: [],
        skipped: null,
        settledReported: false,
      };
      this.records.set(jobId, record);
      const job: ProcessorJob = {
        jobId,
        actionId: spec.actionId,
        inputs: spec.inputs,
        options: spec.options,
        outputDir: spec.outputDir,
        settings: processorSettings(settings),
        limits: DEFAULT_PROCESSING_LIMITS,
        ...(spec.assets && Object.keys(spec.assets).length > 0 ? { assets: spec.assets } : {}),
      };
      this.log.info('job queued', { jobId, actionId: spec.actionId, inputs: spec.inputs.length, source: spec.origin.source });
      this.queue.enqueue(jobId, job);
      ids.push(jobId);
    }
    this.prune();
    return ids;
  }

  /** Record a job that is complete without running (e.g. SKIPPED_SAME_FORMAT). */
  addSkipped(spec: JobSpec, batchId: string | null, warning: JobWarning): string {
    const jobId = newId('job');
    const record: JobRecord = {
      jobId,
      batchId,
      spec,
      createdAt: this.now(),
      entry: null,
      outputs: [],
      outputPaths: [],
      skipped: [warning],
      settledReported: false,
    };
    this.records.set(jobId, record);
    this.reportSettled(record);
    this.scheduleBroadcast();
    return jobId;
  }

  cancel(jobId: string): boolean {
    return this.queue.cancel(jobId);
  }

  cancelAll(): void {
    this.queue.cancelAll();
  }

  setConcurrency(concurrency: number): void {
    this.queue.setConcurrency(concurrency);
  }

  get(jobId: string): JobRecordView | undefined {
    const record = this.records.get(jobId);
    return record ? { jobId, batchId: record.batchId, spec: record.spec, snapshot: this.toSnapshot(record) } : undefined;
  }

  snapshot(jobId: string): JobSnapshot | undefined {
    const record = this.records.get(jobId);
    if (record) return this.toSnapshot(record);
    const past = this.deps.history.list().find((entry) => entry.jobId === jobId);
    return past ? this.historySnapshot(past) : undefined;
  }

  batch(batchId: string): JobRecordView[] {
    return [...this.records.values()]
      .filter((record) => record.batchId === batchId)
      .map((record) => ({ jobId: record.jobId, batchId, spec: record.spec, snapshot: this.toSnapshot(record) }));
  }

  /** Session jobs plus history from earlier runs, newest first. */
  list(): JobSnapshot[] {
    const session = [...this.records.values()].map((record) => this.toSnapshot(record));
    const ids = new Set(session.map((job) => job.jobId));
    const past = this.deps.history
      .list()
      .filter((entry) => !ids.has(entry.jobId))
      .map((entry) => this.historySnapshot(entry));
    return [...session, ...past].sort((a, b) => b.createdAt - a.createdAt).slice(0, LIST_LIMIT);
  }

  waitFor(jobId: string): Promise<JobSnapshot> {
    const record = this.records.get(jobId);
    if (!record) return Promise.reject(new OrbitError('INTERNAL', 'Unknown job'));
    if (record.skipped) return Promise.resolve(this.toSnapshot(record));
    return this.queue.waitFor(jobId).then(() => this.toSnapshot(this.records.get(jobId) ?? record));
  }

  /** Completed jobs with outputs, newest first (tray "Recent jobs"). */
  recentWithOutputs(limit: number): JobSnapshot[] {
    return this.list()
      .filter((job) => job.state === 'completed' && job.outputs.length > 0)
      .slice(0, limit);
  }

  /** Flush a pending broadcast immediately. */
  flushBroadcast(): void {
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    this.deps.onChanged?.(this.list());
  }

  // ------------------------------------------------------------------ internals

  /**
   * The runner (pool) applies `processing.timeoutSec` from the moment a worker
   * has the job, so time spent waiting for a free worker does not count. The
   * outer limit here only guards against a job that never reaches a worker.
   */
  private async runWithTimeout(job: ProcessorJob, ctx: RunContext): Promise<ProcessorResult> {
    const timeoutMs = this.deps.settings().processing.timeoutSec * 1000;
    const controller = new AbortController();
    const forward = (): void => controller.abort(ctx.signal.reason);
    if (ctx.signal.aborted) forward();
    else ctx.signal.addEventListener('abort', forward, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const safetyNet = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new OrbitError('TIMEOUT', 'Job timed out');
        controller.abort(error);
        reject(error);
      }, timeoutMs * 2 + 60_000);
    });
    try {
      return await Promise.race([this.deps.run(job, { signal: controller.signal, onProgress: ctx.onProgress, timeoutMs }), safetyNet]);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', forward);
    }
  }

  private onUpdate(entry: QueueEntry<ProcessorJob, ProcessorResult>): void {
    const record = this.records.get(entry.id);
    if (!record) return;
    record.entry = entry;
    if (entry.state === 'completed' && entry.result && record.outputs.length === 0 && entry.result.outputs.length > 0) {
      this.registerOutputs(record, entry.result);
    }
    if (TERMINAL_JOB_STATES.has(entry.state)) {
      this.log.info('job finished', {
        jobId: record.jobId,
        state: entry.state,
        code: entry.error?.code,
        outputs: entry.result?.outputs.length ?? 0,
        attempt: entry.attempt,
      });
      this.reportSettled(record);
    }
    this.scheduleBroadcast();
  }

  private registerOutputs(record: JobRecord, result: ProcessorResult): void {
    const outputs: OutputFileInfo[] = [];
    const paths: HistoryOutput[] = [];
    for (const output of result.outputs) {
      const registered = this.deps.outputs.register(output.path);
      const dims = {
        ...(output.width !== undefined ? { width: output.width } : {}),
        ...(output.height !== undefined ? { height: output.height } : {}),
        ...(output.pages !== undefined ? { pages: output.pages } : {}),
      };
      outputs.push({ outputId: registered.outputId, name: registered.name, dirDisplay: registered.dirDisplay, format: output.format, bytes: output.bytes, ...dims });
      paths.push({ path: output.path, name: registered.name, format: output.format, bytes: output.bytes, ...dims });
    }
    record.outputs = outputs;
    record.outputPaths = paths;
  }

  private reportSettled(record: JobRecord): void {
    if (record.settledReported) return;
    record.settledReported = true;
    const snapshot = this.toSnapshot(record);
    if (snapshot.state === 'completed' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
      this.deps.history.record(this.toHistory(record, snapshot));
    }
    try {
      this.deps.onSettled?.({ jobId: record.jobId, batchId: record.batchId, spec: record.spec, snapshot });
    } catch (error) {
      this.log.error('settle hook failed', { jobId: record.jobId, error: describeError(error) });
    }
  }

  private toSnapshot(record: JobRecord): JobSnapshot {
    const { spec } = record;
    const base = {
      jobId: record.jobId,
      batchId: record.batchId,
      sessionId: spec.origin.sessionId,
      actionId: spec.actionId,
      inputName: spec.inputs[0]?.displayName ?? '',
      inputCount: spec.inputs.length,
      inputBytes: spec.inputs.reduce((sum, input) => sum + input.bytes, 0),
      createdAt: record.createdAt,
    };
    if (record.skipped || !record.entry) {
      return {
        ...base,
        state: record.skipped ? 'completed' : 'queued',
        progress: { kind: 'indeterminate' },
        startedAt: record.skipped ? record.createdAt : null,
        finishedAt: record.skipped ? record.createdAt : null,
        outputs: [],
        warnings: record.skipped ?? [],
        error: null,
      };
    }
    const entry = record.entry;
    return {
      ...base,
      state: entry.state,
      progress: entry.progress,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      outputs: record.outputs,
      warnings: entry.result?.warnings ?? [],
      error: entry.error,
    };
  }

  private toHistory(record: JobRecord, snapshot: JobSnapshot): HistoryEntry {
    return {
      jobId: snapshot.jobId,
      batchId: snapshot.batchId,
      sessionId: snapshot.sessionId,
      actionId: snapshot.actionId,
      inputName: snapshot.inputName,
      inputCount: snapshot.inputCount,
      state: snapshot.state as HistoryEntry['state'],
      createdAt: snapshot.createdAt,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      outputs: record.outputPaths,
      warnings: snapshot.warnings,
      error: snapshot.error,
      inputBytes: snapshot.inputBytes,
    };
  }

  private historySnapshot(entry: HistoryEntry): JobSnapshot {
    let outputs = this.historyOutputs.get(entry.jobId);
    if (!outputs) {
      outputs = entry.outputs.map((output) => {
        const registered = this.deps.outputs.register(output.path);
        return {
          outputId: registered.outputId,
          name: output.name,
          dirDisplay: registered.dirDisplay,
          format: output.format,
          bytes: output.bytes,
          ...(output.width !== undefined ? { width: output.width } : {}),
          ...(output.height !== undefined ? { height: output.height } : {}),
          ...(output.pages !== undefined ? { pages: output.pages } : {}),
        };
      });
      this.historyOutputs.set(entry.jobId, outputs);
    }
    return {
      jobId: entry.jobId,
      batchId: entry.batchId,
      sessionId: entry.sessionId,
      actionId: entry.actionId,
      inputName: entry.inputName,
      inputCount: entry.inputCount,
      state: entry.state,
      progress: { kind: 'indeterminate' },
      createdAt: entry.createdAt,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      outputs,
      warnings: entry.warnings,
      error: entry.error,
      inputBytes: entry.inputBytes,
    };
  }

  private scheduleBroadcast(): void {
    if (!this.deps.onChanged || this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      try {
        this.deps.onChanged?.(this.list());
      } catch (error) {
        this.log.error('jobs broadcast failed', { error: describeError(error) });
      }
    }, this.deps.broadcastDelayMs ?? 80);
    this.broadcastTimer.unref?.();
  }

  private prune(): void {
    const max = this.deps.maxRecords ?? 300;
    if (this.records.size <= max) return;
    const finished = [...this.records.values()]
      .filter((record) => record.skipped !== null || (record.entry !== null && TERMINAL_JOB_STATES.has(record.entry.state)))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const record of finished.slice(0, this.records.size - max)) {
      this.records.delete(record.jobId);
      this.queue.prune(record.jobId);
    }
  }
}
