import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, link, lstat, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { OrbitError } from '@orbitdrop/contracts';
import { numberedName, splitName } from '../naming';

/**
 * Safe output writing:
 *  1. The result is written to a hidden temp file in the destination folder
 *     (same volume, so committing never copies across devices).
 *  2. Commit claims the final name exclusively with a hard link (fails if the
 *     name exists, atomically), then removes the temp name. On file systems
 *     without hard links it falls back to copyFile(COPYFILE_EXCL).
 *  3. If the name is taken, "name (2).ext", "name (3).ext"… are tried.
 * Existing user files are never overwritten, moved or deleted; only temp files
 * created by this module (tagged with the job id) are ever removed.
 */

const MAX_ATTEMPTS = 999;
const TEMP_MARKER = '.orbitdrop-';

/** Error codes from Node fs mapped to OrbitDrop codes. */
export function mapFsError(error: unknown, fallback: 'OUTPUT_WRITE_FAILED' | 'READ_PERMISSION_DENIED' = 'OUTPUT_WRITE_FAILED'): OrbitError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = code ?? (error instanceof Error ? error.message : String(error));
  switch (code) {
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return fallback === 'READ_PERMISSION_DENIED'
        ? new OrbitError('READ_PERMISSION_DENIED', 'Permission denied', { detail, cause: error })
        : new OrbitError('OUTPUT_DIR_NOT_WRITABLE', 'Output folder is not writable', { detail, cause: error });
    case 'ENOSPC':
    case 'EDQUOT':
      return new OrbitError('DISK_FULL', 'Not enough disk space', { detail, cause: error });
    case 'ENAMETOOLONG':
      return new OrbitError('PATH_TOO_LONG', 'Path is too long', { detail, cause: error });
    case 'ENOENT':
      return new OrbitError(fallback === 'READ_PERMISSION_DENIED' ? 'FILE_NOT_FOUND' : 'OUTPUT_WRITE_FAILED', 'File or folder not found', { detail, cause: error });
    case 'ELOOP':
      return new OrbitError('SYMLINK_LOOP', 'Symbolic link loop', { detail, cause: error });
    case 'EHOSTDOWN':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ENETDOWN':
    case 'ETIMEDOUT':
    case 'ECONNRESET':
    case 'EBADF':
      return new OrbitError('NETWORK_PATH_FAILED', 'Network location failed', { detail, cause: error });
    default:
      return new OrbitError(fallback, fallback === 'READ_PERMISSION_DENIED' ? 'Read failed' : 'Write failed', { detail, cause: error });
  }
}

function safeTag(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'job';
}

/**
 * Hidden temp path next to the final output. Keeps the real extension last so
 * encoders that infer the format from the extension still work.
 */
export function makeTempPath(dir: string, desiredName: string, tag: string): string {
  const { base, ext } = splitName(desiredName);
  const shortBase = [...base].slice(0, 40).join('');
  return join(dir, `.${shortBase}${TEMP_MARKER}${safeTag(tag)}-${randomBytes(4).toString('hex')}${ext}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function claimByLink(tempPath: string, finalPath: string): Promise<'ok' | 'exists' | 'unsupported'> {
  try {
    await link(tempPath, finalPath);
    return 'ok';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return 'exists';
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV' || code === 'ENOSYS' || code === 'EINVAL') {
      return 'unsupported';
    }
    throw error;
  }
}

async function claimByExclusiveCopy(tempPath: string, finalPath: string): Promise<'ok' | 'exists'> {
  try {
    await copyFile(tempPath, finalPath, fsConstants.COPYFILE_EXCL);
    return 'ok';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw error;
  }
}

/**
 * Give a finished temp file its final name in `dir`, choosing the first free
 * name among desiredName, "desired (2)", …  Returns the final path.
 */
export async function commitTempFile(tempPath: string, dir: string, desiredName: string): Promise<string> {
  let linkSupported = true;
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    const finalPath = join(dir, numberedName(desiredName, n));
    try {
      if (linkSupported) {
        const outcome = await claimByLink(tempPath, finalPath);
        if (outcome === 'exists') continue;
        if (outcome === 'unsupported') {
          linkSupported = false;
        } else {
          await unlink(tempPath).catch(() => undefined);
          return finalPath;
        }
      }
      if (await exists(finalPath)) continue;
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
  if (!tempPath.includes(TEMP_MARKER)) return;
  await unlink(tempPath).catch(() => undefined);
}

/**
 * Check early (before heavy work) that `dir` accepts new files, by creating and
 * removing a tagged temp file.
 */
export async function assertWritableDir(dir: string, tag: string): Promise<void> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new OrbitError('OUTPUT_WRITE_FAILED', 'Output location is not a folder');
  } catch (error) {
    if (error instanceof OrbitError) throw error;
    throw mapFsError(error);
  }
  const probe = makeTempPath(dir, 'write-check.tmp', tag);
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
 * or cancellation the temp file is removed and the error rethrown.
 */
export async function writeOutput(
  dir: string,
  desiredName: string,
  tag: string,
  write: (tempPath: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<string> {
  const tempPath = makeTempPath(dir, desiredName, tag);
  try {
    signal?.throwIfAborted();
    await write(tempPath);
    signal?.throwIfAborted();
    return await commitTempFile(tempPath, dir, desiredName);
  } catch (error) {
    await discardTempFile(tempPath);
    if (error instanceof OrbitError) throw error;
    if (signal?.aborted) throw new OrbitError('CANCELLED', 'Cancelled', { cause: error });
    throw mapFsError(error);
  }
}

/** After a worker crash: remove temp files of `tag` left in `dir`. Returns how many were removed. */
export async function cleanupTempFiles(dir: string, tag: string): Promise<number> {
  const marker = `${TEMP_MARKER}${safeTag(tag)}-`;
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith('.') || !name.includes(marker)) continue;
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
