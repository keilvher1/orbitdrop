import { join } from 'node:path';
import { z } from 'zod';
import {
  ActionIdSchema,
  ERROR_CODES,
  FileFormatSchema,
  Id,
  WARNING_CODES,
  type ActionId,
  type FileFormat,
  type JobState,
  type JobWarning,
  type OrbitErrorInfo,
} from '@orbitdrop/contracts';
import { describeError, silentLogger, type Logger } from '../log';
import { SerialQueue, readJson, writeJsonAtomic } from '../util/atomic-json';

/**
 * Job history: `<userData>/history.json`, the last 100 finished jobs. Only
 * names, sizes, states and output paths are stored — never file contents —
 * so the tray's "Recent jobs" and the jobs window survive a restart.
 */
export const HISTORY_VERSION = 1;
export const HISTORY_LIMIT = 100;

const HistoryOutputSchema = z.object({
  path: z.string().min(1).max(32767),
  name: z.string().min(1).max(1024),
  format: FileFormatSchema,
  bytes: z.number().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  pages: z.number().int().positive().optional(),
});

const HistoryEntrySchema = z.object({
  jobId: Id,
  batchId: Id.nullable(),
  sessionId: Id.nullable(),
  actionId: ActionIdSchema,
  inputName: z.string().max(1024),
  inputCount: z.number().int().nonnegative(),
  state: z.enum(['completed', 'failed', 'cancelled']),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  outputs: z.array(HistoryOutputSchema).max(5000),
  warnings: z
    .array(z.object({ code: z.enum(WARNING_CODES), params: z.record(z.string(), z.union([z.string(), z.number()])).optional() }))
    .max(100),
  error: z
    .object({
      code: z.enum(ERROR_CODES),
      message: z.string().max(2000),
      detail: z.string().max(2000).optional(),
      retryable: z.boolean(),
    })
    .nullable(),
  inputBytes: z.number().nonnegative(),
});

export interface HistoryOutput {
  readonly path: string;
  readonly name: string;
  readonly format: FileFormat;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly pages?: number;
}

export interface HistoryEntry {
  readonly jobId: string;
  readonly batchId: string | null;
  readonly sessionId: string | null;
  readonly actionId: ActionId;
  readonly inputName: string;
  readonly inputCount: number;
  readonly state: Extract<JobState, 'completed' | 'failed' | 'cancelled'>;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly outputs: readonly HistoryOutput[];
  readonly warnings: readonly JobWarning[];
  readonly error: OrbitErrorInfo | null;
  readonly inputBytes: number;
}

export class HistoryStore {
  readonly file: string;
  private entries: HistoryEntry[] = [];
  private readonly writes = new SerialQueue();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    dir: string,
    private readonly log: Logger = silentLogger,
    private readonly saveDelayMs = 400,
  ) {
    this.file = join(dir, 'history.json');
  }

  async load(): Promise<readonly HistoryEntry[]> {
    try {
      const raw = await readJson(this.file);
      if (raw.kind !== 'ok') {
        if (raw.kind === 'corrupt') this.log.warn('history file was corrupt; starting empty');
        this.entries = [];
        return this.entries;
      }
      const list = (raw.value as { jobs?: unknown } | null)?.jobs;
      const valid: HistoryEntry[] = [];
      if (Array.isArray(list)) {
        for (const item of list) {
          const parsed = HistoryEntrySchema.safeParse(item);
          if (parsed.success) valid.push(parsed.data as HistoryEntry);
        }
      }
      this.entries = valid.sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt)).slice(0, HISTORY_LIMIT);
    } catch (error) {
      this.log.warn('history unreadable; starting empty', { error: describeError(error) });
      this.entries = [];
    }
    return this.entries;
  }

  /** Newest first. */
  list(): readonly HistoryEntry[] {
    return this.entries;
  }

  record(entry: HistoryEntry): void {
    this.entries = [entry, ...this.entries.filter((e) => e.jobId !== entry.jobId)].slice(0, HISTORY_LIMIT);
    this.scheduleSave();
  }

  /** Remove the entries `predicate` selects ("clear finished jobs"); returns their job ids. Saves when anything changed. */
  removeWhere(predicate: (entry: HistoryEntry) => boolean): string[] {
    const removed: string[] = [];
    const kept: HistoryEntry[] = [];
    for (const entry of this.entries) {
      if (predicate(entry)) removed.push(entry.jobId);
      else kept.push(entry);
    }
    if (removed.length > 0) {
      this.entries = kept;
      this.scheduleSave();
    }
    return removed;
  }

  clear(): void {
    this.entries = [];
    this.scheduleSave();
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.save();
    }
    await this.writes.idle();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  private save(): Promise<void> {
    const snapshot = { version: HISTORY_VERSION, jobs: this.entries };
    return this.writes
      .run(() => writeJsonAtomic(this.file, snapshot))
      .catch((error: unknown) => this.log.error('history save failed', { error: describeError(error) }));
  }
}
