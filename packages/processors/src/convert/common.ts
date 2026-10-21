import { lstat, unlink } from 'node:fs/promises';
import {
  FORMAT_INFO,
  OrbitError,
  formatFromExtension,
  parseActionOptions,
  type ConvertOptions,
  type ConvertTarget,
  type FileFormat,
  type JobProgress,
  type JobWarning,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorOutput,
  type ProcessorRunContext,
} from '@orbitdrop/contracts';
import { splitName } from '@orbitdrop/core';
import { assertWritableDir } from '@orbitdrop/core/node';
import { outputDirFor, writeBytes } from '../common/io';

/** Validate convert.* options again inside the worker (defense in depth). */
export function parseConvertOptions(job: ProcessorJob): ConvertOptions {
  try {
    return parseActionOptions(job.actionId as `convert.${ConvertTarget}`, job.options) as ConvertOptions;
  } catch (error) {
    const issues = (error as { issues?: { path?: unknown[]; message?: string }[] }).issues;
    const detail = Array.isArray(issues)
      ? issues
          .slice(0, 5)
          .map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message ?? ''}`)
          .join('; ')
      : error instanceof Error
        ? error.message
        : String(error);
    throw new OrbitError('INVALID_OPTIONS', 'Invalid conversion options', { detail: detail.slice(0, 300), cause: error });
  }
}

export function targetOf(job: ProcessorJob): ConvertTarget {
  if (!job.actionId.startsWith('convert.')) throw new OrbitError('INVALID_OPTIONS', 'Not a conversion action');
  return job.actionId.slice('convert.'.length) as ConvertTarget;
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new OrbitError('CANCELLED', 'Cancelled');
}

/** Normalise anything thrown inside an executor into an OrbitError. */
export function toOrbitError(error: unknown, signal: AbortSignal): OrbitError {
  if (error instanceof OrbitError) return error;
  if (signal.aborted || (error as { name?: unknown } | null)?.name === 'AbortError') {
    return new OrbitError('CANCELLED', 'Cancelled', { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new OrbitError('INTERNAL', 'Conversion failed', { detail: message.slice(0, 300), cause: error });
}

/** Progress reporting that never lets a throwing listener break the job. */
export function reporter(ctx: ProcessorRunContext): (progress: JobProgress) => void {
  return (progress) => {
    try {
      ctx.onProgress(progress);
    } catch {
      // listener errors are not job errors
    }
  };
}

/**
 * Fail fast (before decoding or rendering anything) when the output folder
 * does not accept new files: OUTPUT_DIR_NOT_WRITABLE lets main offer another
 * folder. Returns the folder.
 */
export async function writableOutputDir(job: ProcessorJob, input: ProcessorInput): Promise<string> {
  const dir = outputDirFor(job, input);
  await assertWritableDir(dir, job.jobId);
  return dir;
}

/** EXTENSION_MISMATCH when the name's extension disagrees with the sniffed format. */
export function extensionMismatchWarning(input: ProcessorInput): JobWarning | null {
  const ext = splitName(input.displayName).ext;
  const byExt = ext ? formatFromExtension(ext) : undefined;
  if (byExt === input.format) return null;
  return { code: 'EXTENSION_MISMATCH', params: { detected: FORMAT_INFO[input.format].label, extension: ext.slice(0, 16) || '-' } };
}

interface CommittedFile {
  readonly output: ProcessorOutput;
  readonly identity: { readonly dev: number; readonly ino: number; readonly size: number } | null;
}

/**
 * Outputs a job has committed so far. A multi-output job (PDF → pages) that
 * fails or is cancelled calls `rollback()`, which removes exactly the files
 * this job created — and only if they are still the same files (device, inode
 * and size unchanged since commit). Nothing else is ever deleted.
 */
export class OutputLedger {
  readonly #files: CommittedFile[] = [];

  async commit(
    dir: string,
    name: string,
    jobId: string,
    data: Uint8Array,
    signal: AbortSignal,
    describe: Omit<ProcessorOutput, 'path' | 'bytes'>,
  ): Promise<ProcessorOutput> {
    const path = await writeBytes(dir, name, jobId, data, signal);
    let identity: CommittedFile['identity'] = null;
    try {
      const info = await lstat(path);
      identity = { dev: info.dev, ino: info.ino, size: info.size };
    } catch {
      identity = null;
    }
    const output: ProcessorOutput = { ...describe, path, bytes: data.byteLength };
    this.#files.push({ output, identity });
    return output;
  }

  get outputs(): ProcessorOutput[] {
    return this.#files.map((f) => f.output);
  }

  /** Remove committed outputs (best effort). Returns how many were removed. */
  async rollback(): Promise<number> {
    let removed = 0;
    for (const file of this.#files.splice(0)) {
      if (!file.identity) continue;
      try {
        const info = await lstat(file.output.path);
        if (!info.isFile() || info.dev !== file.identity.dev || info.ino !== file.identity.ino || info.size !== file.identity.size) continue;
        await unlink(file.output.path);
        removed += 1;
      } catch {
        // already gone or not removable: leave it
      }
    }
    return removed;
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight, results in input order.
 * On the first failure no new items start, in-flight items are awaited (so
 * every committed output is known before a rollback), then the first error is
 * thrown.
 */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const state: { next: number; failure: { error: unknown } | null } = { next: 0, failure: null };
  const worker = async (): Promise<void> => {
    while (state.failure === null && state.next < items.length) {
      const index = state.next;
      state.next += 1;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        state.failure ??= { error };
      }
    }
  };
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  if (state.failure) throw state.failure.error;
  return results;
}

export function isImageTarget(target: FileFormat): boolean {
  return FORMAT_INFO[target].kind === 'image';
}
