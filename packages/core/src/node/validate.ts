import { homedir } from 'node:os';
import { open, realpath, stat, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import {
  DEFAULT_PROCESSING_LIMITS,
  OrbitError,
  formatFromExtension,
  inputKindOf,
  type FileFormat,
  type InputKind,
  type ProcessingLimits,
} from '@orbitdrop/contracts';
import { splitName } from '../naming';
import { SNIFF_BYTES, detectFormatFromHeader, detectLinkFile } from '../sniff';
import { mapFsError } from './output';

export interface ValidatedInput {
  /** Path as received (what the user dragged). */
  readonly originalPath: string;
  /** Canonical path after resolving symbolic links; used for reading. */
  readonly realPath: string;
  readonly displayName: string;
  /** Folder of the original path: outputs go next to what the user dragged (the symlink's folder for symlinks). */
  readonly sourceDir: string;
  readonly format: FileFormat;
  readonly kind: InputKind;
  readonly bytes: number;
  /** The name has an extension and it does not name the detected format (processing follows the header). */
  readonly extensionMismatch: boolean;
}

export interface ValidateOptions {
  readonly limits?: ProcessingLimits;
  /** How long to wait for opening the file and reading its first bytes (cloud placeholders / network shares can hang). Default 5000. */
  readonly headerTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  /**
   * Folders synced by cloud providers whose files may be online-only
   * placeholders. Default: defaultCloudRoots() for this machine.
   */
  readonly cloudRoots?: readonly string[];
}

/**
 * Folders where online-only cloud files commonly live:
 *  - macOS: iCloud Drive (~/Library/Mobile Documents) and File Provider
 *    domains (~/Library/CloudStorage: OneDrive, Dropbox, Google Drive, Box…)
 *  - Windows: OneDrive folders from the OneDrive* environment variables and
 *    iCloud for Windows (~\iCloudDrive)
 */
export function defaultCloudRoots(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') return [`${home}/Library/Mobile Documents`, `${home}/Library/CloudStorage`];
  if (platform === 'win32') {
    const roots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((v): v is string => typeof v === 'string' && v.length > 0);
    return [...new Set([...roots, `${home}\\iCloudDrive`])];
  }
  return [];
}

function normalizeForPrefix(path: string, platform: NodeJS.Platform): string {
  const unified = platform === 'win32' ? path.replace(/\//g, '\\') : path;
  // macOS and Windows volumes are case-insensitive by default; this is only a heuristic.
  return unified.toLowerCase();
}

function isUnder(path: string, root: string, platform: NodeJS.Platform): boolean {
  const sep = platform === 'win32' ? '\\' : '/';
  const p = normalizeForPrefix(path, platform);
  let r = normalizeForPrefix(root, platform);
  while (r.length > 1 && r.endsWith(sep)) r = r.slice(0, -1);
  return p === r || p.startsWith(r + sep);
}

/** NTFS / Win32 limits in UTF-16 code units: one name, and a whole path in the `\\?\` form Node uses. */
const WIN32_MAX_NAME = 255;
const WIN32_MAX_PATH = 32_767;

/**
 * Whether a Windows path exceeds what NTFS and the Win32 API accept. Windows reports such a
 * path as "not found" (ERROR_INVALID_NAME / ERROR_PATH_NOT_FOUND → ENOENT) where macOS says
 * ENAMETOOLONG, so validateInputFile checks it first and both report PATH_TOO_LONG. Paths of
 * more than MAX_PATH (260) characters are fine: Node opens files through `\\?\` paths.
 */
export function exceedsWin32PathLimits(path: string): boolean {
  if (path.length > WIN32_MAX_PATH) return true;
  return path.split(/[\\/]/).some((name) => name.length > WIN32_MAX_NAME);
}

/** Heuristic only (used to explain a hanging read): see validateInputFile. */
export function isNetworkPath(path: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return path.startsWith('\\\\') || path.startsWith('//');
  return path.startsWith('/Volumes/') || path.startsWith('/net/') || path.startsWith('/Network/');
}

/**
 * Open the file and read its first bytes, giving up after `timeoutMs`. On
 * timeout the pending open/read keeps running in the background and its handle
 * is closed when it completes (FileHandle.close() waits for pending reads, so
 * it is never awaited on the timeout path).
 */
async function readHeaderWithTimeout(path: string, timeoutMs: number): Promise<Uint8Array> {
  let timer: NodeJS.Timeout | undefined;
  const work = (async () => {
    const handle = await open(path, 'r');
    try {
      const buffer = new Uint8Array(SNIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close().catch(() => undefined);
    }
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OrbitError('TIMEOUT', 'Reading the file header timed out')), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined);
  }
}

/** Error for a zero-byte file: FILE_EMPTY if its extension is one we accept. */
function emptyFileError(displayName: string): OrbitError {
  const claimed = formatFromExtension(splitName(displayName).ext);
  const kind = claimed === undefined ? undefined : inputKindOf(claimed);
  if (kind === 'pdf' || kind === 'image') return new OrbitError('FILE_EMPTY', 'File is empty');
  return new OrbitError('UNSUPPORTED_FORMAT', 'File is empty');
}

/**
 * Validate a path received from a drop or dialog before any job is created.
 *
 *  - must be absolute; on Windows a name over 255 or a path over 32,767 UTF-16 units is
 *    PATH_TOO_LONG (Windows itself only says "not found"); symbolic links are resolved (realpath) with loop
 *    detection (SYMLINK_LOOP); a dangling link is FILE_NOT_FOUND
 *  - folders (also via a link) and other non-regular files → NOT_A_FILE
 *  - 0 bytes → FILE_EMPTY for a supported extension, else UNSUPPORTED_FORMAT;
 *    larger than limits.maxInputBytes → FILE_TOO_LARGE
 *  - the format comes from the first SNIFF_BYTES bytes, never the extension;
 *    unknown or output-only formats → UNSUPPORTED_FORMAT; Finder aliases and
 *    Windows .lnk shortcuts → UNSUPPORTED_FORMAT with a hint
 *  - opening + reading the header is limited to headerTimeoutMs. A timeout is
 *    reported as CLOUD_PLACEHOLDER when the file looks like an online-only cloud
 *    file, NETWORK_PATH_FAILED on a network path, otherwise TIMEOUT.
 *
 * Cloud placeholder heuristic (limits): Node does not expose st_flags
 * (SF_DATALESS) on macOS nor FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS on Windows, so
 * a file "looks like" a placeholder when it reports size > 0 with 0 allocated
 * blocks (macOS/Linux; also true for sparse or decmpfs-compressed files) or lies
 * under a known cloud folder (`cloudRoots`). It is only consulted after the
 * header read timed out or failed with a generic I/O error, so a false positive
 * only changes the error message; files that download quickly validate normally.
 * A hung read keeps one libuv thread-pool thread busy until the OS gives up.
 */
export async function validateInputFile(inputPath: string, options: ValidateOptions = {}): Promise<ValidatedInput> {
  const limits = options.limits ?? DEFAULT_PROCESSING_LIMITS;
  const platform = options.platform ?? process.platform;
  if (!isAbsolute(inputPath)) throw new OrbitError('FILE_NOT_FOUND', 'Path must be absolute');
  if (platform === 'win32' && exceedsWin32PathLimits(inputPath)) {
    throw new OrbitError('PATH_TOO_LONG', 'Path is too long', { detail: `${inputPath.length} UTF-16 units` });
  }

  let realPath: string;
  try {
    await lstat(inputPath);
    realPath = await realpath(inputPath);
  } catch (error) {
    throw mapFsError(error, 'READ_PERMISSION_DENIED');
  }

  let info;
  try {
    info = await stat(realPath);
  } catch (error) {
    throw mapFsError(error, 'READ_PERMISSION_DENIED');
  }
  const displayName = basename(inputPath);
  if (info.isDirectory()) throw new OrbitError('NOT_A_FILE', 'Folders are not supported');
  if (!info.isFile()) throw new OrbitError('NOT_A_FILE', 'Not a regular file');
  if (info.size === 0) throw emptyFileError(displayName);
  if (info.size > limits.maxInputBytes) {
    throw new OrbitError('FILE_TOO_LARGE', 'File is larger than the limit', { detail: `${info.size} > ${limits.maxInputBytes}` });
  }

  const cloudRoots = options.cloudRoots ?? defaultCloudRoots(platform);
  const maybePlaceholder =
    (platform !== 'win32' && info.blocks === 0 && info.size > 0) || cloudRoots.some((root) => isUnder(realPath, root, platform) || isUnder(inputPath, root, platform));
  let header: Uint8Array;
  try {
    header = await readHeaderWithTimeout(realPath, options.headerTimeoutMs ?? 5000);
  } catch (error) {
    if (error instanceof OrbitError && error.code === 'TIMEOUT') {
      if (maybePlaceholder) throw new OrbitError('CLOUD_PLACEHOLDER', 'File is not downloaded yet', { cause: error });
      if (isNetworkPath(realPath, platform)) throw new OrbitError('NETWORK_PATH_FAILED', 'Network location did not respond', { cause: error });
      throw error;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (maybePlaceholder && (code === 'EIO' || code === 'UNKNOWN' || code === 'ECANCELED' || code === 'ETIMEDOUT')) {
      throw new OrbitError('CLOUD_PLACEHOLDER', 'File is not downloaded yet', { detail: code, cause: error });
    }
    throw mapFsError(error, 'READ_PERMISSION_DENIED');
  }

  const link = detectLinkFile(header);
  if (link !== null) {
    throw new OrbitError('UNSUPPORTED_FORMAT', link === 'macAlias' ? 'Finder aliases are not supported; use the original file' : 'Shortcuts are not supported; use the original file', {
      detail: link,
    });
  }
  const format = detectFormatFromHeader(header);
  const kind = format === null ? undefined : inputKindOf(format);
  if (format === null || kind === undefined) throw new OrbitError('UNSUPPORTED_FORMAT', 'Unsupported or unknown file type');

  const ext = splitName(displayName).ext;
  return {
    originalPath: inputPath,
    realPath,
    displayName,
    sourceDir: dirname(inputPath),
    format,
    kind,
    bytes: info.size,
    extensionMismatch: ext !== '' && formatFromExtension(ext) !== format,
  };
}
