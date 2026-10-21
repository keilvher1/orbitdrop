import { OrbitError, toErrorInfo, type CapabilitySnapshot, type FileSelection, type ProcessorInput, type SelectedFile, type SelectionSource } from '@orbitdrop/contracts';
import { buildFileSelection, buildSelectedFile, type SelectionCandidate } from '@orbitdrop/core';
import { isNetworkPath, validateInputFile, type ValidatedInput } from '@orbitdrop/core/node';
import { scrubPaths } from '../log';
import { mapLimit, withTimeout } from '../util/concurrency';
import { newId } from '../util/ids';

/**
 * FileRegistry: the only place that maps renderer-facing ids to file-system
 * paths. Every path that enters the app (global drag drop, Drop Zone, open
 * dialog, background picker) is validated here with `validateInputFile`
 * (realpath + loop detection, regular file, size limit, header sniffing)
 * before an id is handed out; selections are built with core
 * `buildFileSelection` (order kept, problems explained, files this build
 * cannot read flagged). The renderer only ever sees `SelectedFile`.
 */

export interface RegisteredFile {
  readonly fileId: string;
  readonly selected: SelectedFile;
  /** Present when the file passed validation (it may still carry a `problem`, e.g. unreadable in this build). */
  readonly input: ValidatedInput | null;
}

export interface UsableFile extends RegisteredFile {
  readonly input: ValidatedInput;
}

export interface SelectionRecord {
  readonly selection: FileSelection;
  readonly files: readonly RegisteredFile[];
}

export type PathValidator = (path: string) => Promise<ValidatedInput>;

export interface FileRegistryOptions {
  readonly validate?: PathValidator;
  /** Current capabilities (null while the engines are being probed). */
  readonly snapshot?: () => CapabilitySnapshot | null;
  /** Selections kept before the least recently used ones are forgotten. */
  readonly maxSelections?: number;
  /** Standalone files (e.g. background images) kept. */
  readonly maxStandalone?: number;
  /**
   * Files validated concurrently. Each validation holds a libuv thread-pool
   * thread while it reads, so this stays well below the pool size.
   */
  readonly concurrency?: number;
  /**
   * Header reads that timed out are assumed to still block a pool thread for
   * `hungReadMs`; once `maxHungReads` of them are outstanding, validation fails
   * fast (TIMEOUT) instead of risking a pool where no fs call can run.
   */
  readonly maxHungReads?: number;
  readonly hungReadMs?: number;
  /**
   * Limit for one whole validation. validateInputFile limits only the header
   * read; lstat/realpath/stat on a dead network mount can block much longer.
   * A validation that hits this limit also counts as a hung read.
   */
  readonly validationTimeoutMs?: number;
}

/** Whether a validation error means the header read timed out (its thread may still be blocked). */
export function isHungReadError(error: unknown): boolean {
  if (!(error instanceof OrbitError)) return false;
  if (error.code === 'TIMEOUT') return true;
  const cause = (error as Error & { cause?: unknown }).cause;
  return (error.code === 'CLOUD_PLACEHOLDER' || error.code === 'NETWORK_PATH_FAILED') && cause instanceof OrbitError && cause.code === 'TIMEOUT';
}

export const MAX_SELECTION_FILES = 500;

export function isUsable(file: RegisteredFile): file is UsableFile {
  return file.input !== null && file.selected.problem === undefined;
}

export function toProcessorInput(file: UsableFile): ProcessorInput {
  return {
    fileId: file.fileId,
    path: file.input.realPath,
    displayName: file.input.displayName,
    sourceDir: file.input.sourceDir,
    format: file.input.format,
    bytes: file.input.bytes,
  };
}

export class FileRegistry {
  private readonly files = new Map<string, RegisteredFile>();
  private readonly refCounts = new Map<string, number>();
  /** Insertion order = least recently used first. */
  private readonly selections = new Map<string, SelectionRecord>();
  private readonly standalone: string[] = [];
  private readonly validateRaw: PathValidator;
  private readonly maxSelections: number;
  private readonly maxStandalone: number;
  private readonly concurrency: number;
  private readonly maxHungReads: number;
  private readonly hungReadMs: number;
  private readonly validationTimeoutMs: number;
  private hungReads = 0;

  constructor(private readonly options: FileRegistryOptions = {}) {
    this.validateRaw = options.validate ?? ((path) => validateInputFile(path));
    this.maxSelections = options.maxSelections ?? 200;
    this.maxStandalone = options.maxStandalone ?? 100;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.maxHungReads = Math.max(1, options.maxHungReads ?? 8);
    this.hungReadMs = options.hungReadMs ?? 2 * 60_000;
    this.validationTimeoutMs = options.validationTimeoutMs ?? 8000;
  }

  /** Header reads that timed out recently (assumed to still hold a pool thread). */
  get outstandingHungReads(): number {
    return this.hungReads;
  }

  private async validate(path: string): Promise<ValidatedInput> {
    if (this.hungReads >= this.maxHungReads) {
      throw new OrbitError('TIMEOUT', 'Too many files did not respond; try again in a moment');
    }
    try {
      return await withTimeout(this.validateRaw(path), this.validationTimeoutMs, () => {
        const timeout = new OrbitError('TIMEOUT', 'The file did not respond');
        return isNetworkPath(path, process.platform)
          ? new OrbitError('NETWORK_PATH_FAILED', 'Network location did not respond', { cause: timeout })
          : timeout;
      });
    } catch (error) {
      if (isHungReadError(error)) {
        this.hungReads += 1;
        const timer = setTimeout(() => {
          this.hungReads = Math.max(0, this.hungReads - 1);
        }, this.hungReadMs);
        timer.unref?.();
      }
      throw error;
    }
  }

  /** Validate paths and create a selection. Invalid files are kept with a `problem` so the UI can explain them. */
  async registerPaths(paths: readonly string[], source: SelectionSource): Promise<FileSelection> {
    if (paths.length === 0) throw new OrbitError('FILE_NOT_FOUND', 'No files');
    if (paths.length > MAX_SELECTION_FILES) throw new OrbitError('TOO_MANY_FILES', 'Too many files');
    const unique = [...new Set(paths)];
    const validated = await mapLimit(unique, this.concurrency, async (path) => {
      try {
        return { path, input: await this.validate(path), error: null as unknown };
      } catch (error) {
        return { path, input: null, error };
      }
    });

    const seenReal = new Set<string>();
    const candidates: SelectionCandidate[] = [];
    const inputs = new Map<string, ValidatedInput>();
    for (const item of validated) {
      const fileId = newId('f');
      if (item.input) {
        if (seenReal.has(item.input.realPath)) continue; // the same file twice (e.g. through a symlink)
        seenReal.add(item.input.realPath);
        inputs.set(fileId, item.input);
        candidates.push({ fileId, input: item.input });
      } else {
        const info = toErrorInfo(item.error);
        // The message reaches the renderer: never let a raw fs message carry the path along.
        candidates.push({ fileId, path: item.path, error: { code: info.code, message: scrubPaths(info.message).slice(0, 300) } });
      }
    }

    const selection = buildFileSelection(newId('sel'), source, candidates, {
      maxFiles: MAX_SELECTION_FILES,
      ...(this.snapshot() ? { snapshot: this.snapshot()! } : {}),
    });
    const records: RegisteredFile[] = selection.files.map((selected) => ({ fileId: selected.fileId, selected, input: inputs.get(selected.fileId) ?? null }));
    for (const record of records) {
      this.files.set(record.fileId, record);
      this.refCounts.set(record.fileId, (this.refCounts.get(record.fileId) ?? 0) + 1);
    }
    this.selections.set(selection.selectionId, { selection, files: records });
    this.evictSelections();
    return selection;
  }

  /**
   * Validate files again without registering anything (retryJob: a file may be
   * gone, replaced or still a cloud placeholder since the job ran). Same
   * validator, time limit, concurrency and hung-read accounting as
   * registration. Rejects with the error of the earliest failing file; files
   * after a failure are not read.
   */
  async revalidate(paths: readonly string[]): Promise<ValidatedInput[]> {
    const failures = new Map<number, unknown>();
    const inputs = await mapLimit(paths, this.concurrency, async (path, index) => {
      if (failures.size > 0) return null;
      try {
        return await this.validate(path);
      } catch (error) {
        failures.set(index, error);
        return null;
      }
    });
    if (failures.size > 0) throw failures.get(Math.min(...failures.keys()));
    return inputs as ValidatedInput[];
  }

  /** Validate one standalone file (e.g. a background image). Throws OrbitError when it cannot be used. */
  async registerFile(path: string): Promise<UsableFile> {
    const input = await this.validate(path);
    const fileId = newId('f');
    const selected = buildSelectedFile({ fileId, input }, this.snapshot() ?? undefined);
    if (selected.problem) throw new OrbitError(selected.problem.code, selected.problem.message);
    const record: UsableFile = { fileId, selected, input };
    this.files.set(fileId, record);
    this.standalone.push(fileId);
    while (this.standalone.length > this.maxStandalone) {
      const old = this.standalone.shift();
      if (old !== undefined && !this.refCounts.has(old)) this.files.delete(old);
    }
    return record;
  }

  getSelection(selectionId: string): FileSelection | undefined {
    return this.touch(selectionId)?.selection;
  }

  getSelectionRecord(selectionId: string): SelectionRecord | undefined {
    return this.touch(selectionId);
  }

  getFile(fileId: string): RegisteredFile | undefined {
    return this.files.get(fileId);
  }

  /** Usable files of a selection in selection order. */
  usableFiles(selectionId: string): UsableFile[] {
    return this.touch(selectionId)?.files.filter(isUsable) ?? [];
  }

  get selectionCount(): number {
    return this.selections.size;
  }

  get fileCount(): number {
    return this.files.size;
  }

  private snapshot(): CapabilitySnapshot | null {
    return this.options.snapshot?.() ?? null;
  }

  private touch(selectionId: string): SelectionRecord | undefined {
    const record = this.selections.get(selectionId);
    if (!record) return undefined;
    this.selections.delete(selectionId);
    this.selections.set(selectionId, record);
    return record;
  }

  private evictSelections(): void {
    while (this.selections.size > this.maxSelections) {
      const oldest = this.selections.keys().next();
      if (oldest.done) break;
      const record = this.selections.get(oldest.value)!;
      this.selections.delete(oldest.value);
      for (const file of record.files) {
        const count = (this.refCounts.get(file.fileId) ?? 1) - 1;
        if (count <= 0) {
          this.refCounts.delete(file.fileId);
          this.files.delete(file.fileId);
        } else {
          this.refCounts.set(file.fileId, count);
        }
      }
    }
  }
}
