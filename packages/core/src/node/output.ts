import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { link, lstat, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { OrbitError } from '@orbitdrop/contracts';
import { numberedName, splitName, utf8Length } from '../naming';

/**
 * Safe output writing:
 *  1. The result is written to a hidden temp file in the destination folder
 *     (same volume, so committing never copies across devices).
 *  2. Commit claims the final name exclusively with a hard link (fails if the
 *     name exists, atomically), then removes the temp name. On macOS it instead
 *     reserves the final name with an exclusive create (O_EXCL, an empty
 *     placeholder) and renames the finished temp file over it: macOS asks the
 *     user before an app makes a hard link in Desktop, Documents or Downloads,
 *     while creating and renaming its own files there needs no consent. On file
 *     systems without hard links (or rename) it falls back to an exclusive
 *     create + copy; a partially copied file is removed again.
 *  3. If the name is taken, "name (2).ext", "name (3).ext"… are tried.
 * Existing user files are never overwritten, moved or deleted; only temp files
 * created by this module (tagged with the job id) and files this module created
 * exclusively are ever removed.
 *
 * Temp file names: `.orbitdrop.<tag>.<8 hex>[.<start of the base, ≤ 60 bytes>]<ext>`
 * — the tag cannot contain '.', so a tag never matches another tag's files
 * ("job" does not match "job-1"). The real extension stays last so encoders that
 * infer the format from it still work.
 */

const MAX_ATTEMPTS = 999;
export const TEMP_FILE_PREFIX = '.orbitdrop.';
const TEMP_NAME = /^\.orbitdrop\.([A-Za-z0-9_-]{1,64})\.([0-9a-f]{8})(?:\.|$)/;
/** UTF-8 bytes of the desired base kept in a temp name (keeps temp names far below 255 bytes). */
const TEMP_HINT_BYTES = 60;
const COPY_CHUNK = 1024 * 1024;

type FsFallback = 'OUTPUT_WRITE_FAILED' | 'READ_PERMISSION_DENIED';

/** Error codes from Node fs mapped to OrbitDrop codes (`fallback` decides read vs write semantics). */
export function mapFsError(error: unknown, fallback: FsFallback = 'OUTPUT_WRITE_FAILED'): OrbitError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = code ?? (error instanceof Error ? error.message : String(error));
  const reading = fallback === 'READ_PERMISSION_DENIED';
  switch (code) {
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return reading
        ? new OrbitError('READ_PERMISSION_DENIED', 'Permission denied', { detail, cause: error })
        : new OrbitError('OUTPUT_DIR_NOT_WRITABLE', 'Output folder is not writable', { detail, cause: error });
    case 'EBUSY':
      // Windows sharing violation (file locked by another program).
      return reading
        ? new OrbitError('READ_PERMISSION_DENIED', 'File is in use by another program', { detail, cause: error })
        : new OrbitError('OUTPUT_WRITE_FAILED', 'File is in use by another program', { detail, cause: error });
    case 'ENOSPC':
    case 'EDQUOT':
      return new OrbitError('DISK_FULL', 'Not enough disk space', { detail, cause: error });
    case 'ENAMETOOLONG':
      return new OrbitError('PATH_TOO_LONG', 'Path is too long', { detail, cause: error });
    case 'ENOENT':
    case 'ENOTDIR':
      return new OrbitError(reading ? 'FILE_NOT_FOUND' : 'OUTPUT_WRITE_FAILED', 'File or folder not found', { detail, cause: error });
    case 'EISDIR':
      return reading
        ? new OrbitError('NOT_A_FILE', 'Not a regular file', { detail, cause: error })
        : new OrbitError('OUTPUT_WRITE_FAILED', 'Output path is a folder', { detail, cause: error });
    case 'ELOOP':
      return new OrbitError('SYMLINK_LOOP', 'Symbolic link loop', { detail, cause: error });
    case 'EHOSTDOWN':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ENETDOWN':
    case 'ENETRESET':
    case 'ETIMEDOUT':
    case 'ECONNRESET':
    case 'ECONNABORTED':
    case 'ECONNREFUSED':
    case 'ENOTCONN':
    case 'ESTALE':
    case 'EBADF':
      return new OrbitError('NETWORK_PATH_FAILED', 'Network location failed', { detail, cause: error });
    default:
      return new OrbitError(fallback, reading ? 'Read failed' : 'Write failed', { detail, cause: error });
  }
}

/** Job ids are contracts `Id`s ([A-Za-z0-9_-]{1,64}); anything else is reduced to those characters. */
function safeTag(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'job';
}

/** Start of the desired base name kept in the temp name (readable in a folder listing, Windows-safe). */
function tempBaseHint(base: string): string {
  let out = '';
  for (const ch of base) {
    if (utf8Length(out + ch) > TEMP_HINT_BYTES) break;
    out += ch;
  }
  return out.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '_').replace(/[ .]+$/u, '');
}

/**
 * Hidden temp path next to the final output (see the module doc for the format).
 */
export function makeTempPath(dir: string, desiredName: string, tag: string): string {
  const { base, ext } = splitName(desiredName);
  const hint = tempBaseHint(base);
  return join(dir, `${TEMP_FILE_PREFIX}${safeTag(tag)}.${randomBytes(4).toString('hex')}${hint === '' ? '' : `.${hint}`}${ext}`);
}

const tempFileReporter = new AsyncLocalStorage<(tempPath: string) => void>();

/**
 * Run `fn` with `report` called for every temp file this module creates within it (before
 * anything is written to the file) — the processor host forwards them to main, which removes
 * exactly those files after a worker crash instead of listing the output folder.
 */
export function withTempFileReporter<T>(report: (tempPath: string) => void, fn: () => T): T {
  return tempFileReporter.run(report, fn);
}

function reportTempFile(tempPath: string): void {
  const report = tempFileReporter.getStore();
  if (!report) return;
  try {
    report(tempPath);
  } catch {
    // reporting is best effort; the write goes ahead
  }
}

/** Whether `name` (a file name, not a path) is a temp file of this module, optionally of one tag. */
export function isTempFileName(name: string, tag?: string): boolean {
  const match = TEMP_NAME.exec(name);
  if (match === null) return false;
  return tag === undefined || match[1] === safeTag(tag);
}

async function claimByLink(tempPath: string, finalPath: string): Promise<'ok' | 'exists' | 'unsupported'> {
  try {
    await link(tempPath, finalPath);
    return 'ok';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return 'exists';
    // EISDIR: libuv's translation of ERROR_INVALID_FUNCTION (CreateHardLinkW on FAT/exFAT).
    if (
      code === 'EPERM' ||
      code === 'ENOTSUP' ||
      code === 'EOPNOTSUPP' ||
      code === 'EXDEV' ||
      code === 'ENOSYS' ||
      code === 'EINVAL' ||
      code === 'EISDIR' ||
      code === 'EMLINK'
    ) {
      return 'unsupported';
    }
    throw error;
  }
}

/**
 * Reserve, then rename (the default on macOS, see the module doc). The empty
 * placeholder is checked again right before the rename and removed after a
 * failed rename — in both cases only while it is still ours (same device and
 * inode, still empty), so a file someone else put under that name is never
 * replaced or deleted. Measured on macOS 14.8 in Desktop, Documents and
 * Downloads: `link` shows the "would like to access files in your … folder"
 * prompt and blocks until it is answered; exclusive create, rename and copy
 * show nothing.
 */
async function claimByReserveRename(tempPath: string, finalPath: string): Promise<'ok' | 'exists' | 'unsupported'> {
  let placeholder: { dev: number; ino: number };
  try {
    const handle = await open(finalPath, 'wx');
    try {
      const info = await handle.stat();
      placeholder = { dev: info.dev, ino: info.ino };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw error;
  }
  const stillOurs = async (): Promise<boolean> => {
    try {
      const info = await lstat(finalPath);
      return info.isFile() && info.size === 0 && info.dev === placeholder.dev && info.ino === placeholder.ino;
    } catch {
      return false;
    }
  };
  // Replaced meanwhile (another program writing that name without O_EXCL): leave it and try the next name.
  if (!(await stillOurs())) return 'exists';
  try {
    await rename(tempPath, finalPath);
    return 'ok';
  } catch (error) {
    if (await stillOurs()) await unlink(finalPath).catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS' || code === 'EINVAL') return 'unsupported';
    throw error;
  }
}

/**
 * Exclusive copy: create the final name with O_EXCL (atomic "fail if it
 * exists"), then copy the temp file's bytes into it. If copying fails the file
 * we just created is removed again, so no partial output is left behind.
 */
async function claimByExclusiveCopy(tempPath: string, finalPath: string): Promise<'ok' | 'exists'> {
  let target;
  try {
    target = await open(finalPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw error;
  }
  let completed = false;
  try {
    const source = await open(tempPath, 'r');
    try {
      const buffer = new Uint8Array(COPY_CHUNK);
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, COPY_CHUNK, null);
        if (bytesRead === 0) break;
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await target.write(buffer, offset, bytesRead - offset);
          offset += bytesWritten;
        }
      }
    } finally {
      await source.close().catch(() => undefined);
    }
    completed = true;
  } finally {
    await target.close().catch(() => undefined);
    if (!completed) await unlink(finalPath).catch(() => undefined);
  }
  return 'ok';
}

export type CommitStrategy = 'auto' | 'link' | 'rename' | 'copy';

export interface CommitOptions {
  /**
   * 'auto' (default): 'rename' on macOS, 'link' elsewhere. 'link': hard link;
   * 'rename': reserve the name (O_EXCL), then rename over it; both fall back to
   * an exclusive copy where unsupported. 'copy': always copy.
   */
  readonly strategy?: CommitStrategy;
}

function resolveStrategy(strategy: CommitStrategy | undefined): 'link' | 'rename' | 'copy' {
  if (strategy === undefined || strategy === 'auto') return process.platform === 'darwin' ? 'rename' : 'link';
  return strategy;
}

/**
 * Give a finished temp file its final name in `dir`, choosing the first free
 * name among desiredName, "desired (2)", …  Returns the final path. Never
 * replaces an existing file, including one created after the temp file.
 */
export async function commitTempFile(tempPath: string, dir: string, desiredName: string, options: CommitOptions = {}): Promise<string> {
  let strategy = resolveStrategy(options.strategy);
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    const finalPath = join(dir, numberedName(desiredName, n));
    try {
      if (strategy !== 'copy') {
        const outcome = strategy === 'rename' ? await claimByReserveRename(tempPath, finalPath) : await claimByLink(tempPath, finalPath);
        if (outcome === 'exists') continue;
        if (outcome === 'ok') {
          // A rename moved the temp file; a link left its old name behind.
          if (strategy === 'link') await unlink(tempPath).catch(() => undefined);
          return finalPath;
        }
        strategy = 'copy';
      }
      if ((await claimByExclusiveCopy(tempPath, finalPath)) === 'exists') continue;
      await unlink(tempPath).catch(() => undefined);
      return finalPath;
    } catch (error) {
      throw mapFsError(error);
    }
  }
  throw new OrbitError('OUTPUT_WRITE_FAILED', 'Could not find a free output name');
}

/** Remove a temp file created by makeTempPath; never touches other files. */
export async function discardTempFile(tempPath: string): Promise<void> {
  if (!isTempFileName(basename(tempPath))) return;
  await unlink(tempPath).catch(() => undefined);
}

/**
 * Check early (before heavy work) that `dir` accepts new files, by creating and
 * removing a tagged temp file. A missing folder or a path that is not a folder
 * is reported as OUTPUT_DIR_NOT_WRITABLE so the UI offers another folder.
 */
export async function assertWritableDir(dir: string, tag: string): Promise<void> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new OrbitError('OUTPUT_DIR_NOT_WRITABLE', 'Output location is not a folder');
  } catch (error) {
    if (error instanceof OrbitError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new OrbitError('OUTPUT_DIR_NOT_WRITABLE', 'Output folder does not exist', { detail: code, cause: error });
    }
    throw mapFsError(error);
  }
  const probe = makeTempPath(dir, 'write-check.tmp', tag);
  reportTempFile(probe);
  try {
    const handle = await open(probe, 'wx');
    await handle.close();
  } catch (error) {
    throw mapFsError(error);
  } finally {
    await unlink(probe).catch(() => undefined);
  }
}

/**
 * Write one output safely: `write` receives a temp path and must create the
 * file there. On success the file is committed under a free name; on failure
 * or cancellation (signal aborted before or right after `write`) the temp file
 * is removed and the error rethrown (CANCELLED for aborts unless the abort
 * reason is already an OrbitError such as TIMEOUT). Once committed, the output
 * stays even if the signal fires afterwards.
 */
export async function writeOutput(
  dir: string,
  desiredName: string,
  tag: string,
  write: (tempPath: string) => Promise<void>,
  signal?: AbortSignal,
  options: CommitOptions = {},
): Promise<string> {
  const tempPath = makeTempPath(dir, desiredName, tag);
  reportTempFile(tempPath);
  try {
    signal?.throwIfAborted();
    await write(tempPath);
    signal?.throwIfAborted();
    return await commitTempFile(tempPath, dir, desiredName, options);
  } catch (error) {
    await discardTempFile(tempPath);
    if (error instanceof OrbitError) throw error;
    if (signal?.aborted) throw new OrbitError('CANCELLED', 'Cancelled', { cause: error });
    throw mapFsError(error);
  }
}

/**
 * After a worker crash: remove temp files of `tag` left in `dir`. Returns how many were removed.
 * Lists the folder, which on macOS asks the user for access in Desktop/Documents/Downloads —
 * prefer removeTempFiles with the paths the worker reported (withTempFileReporter).
 */
/**
 * After a worker crash: remove the temp files it reported (withTempFileReporter) — only names
 * this module makes for `tag`, only regular files; one already committed or discarded is
 * simply gone. Returns how many were removed. Never lists a folder.
 */
export async function removeTempFiles(paths: readonly string[], tag: string): Promise<number> {
  let removed = 0;
  for (const path of new Set(paths)) {
    if (!isTempFileName(basename(path), tag)) continue;
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      await unlink(path);
      removed += 1;
    } catch {
      // already gone or not removable: leave it
    }
  }
  return removed;
}

export async function cleanupTempFiles(dir: string, tag: string): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!isTempFileName(name, tag)) continue;
    try {
      const info = await lstat(join(dir, name));
      if (!info.isFile()) continue;
      await unlink(join(dir, name));
      removed += 1;
    } catch {
      // already gone or not removable: leave it
    }
  }
  return removed;
}
