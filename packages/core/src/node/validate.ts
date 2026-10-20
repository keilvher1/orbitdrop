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
import { SNIFF_BYTES, detectFormatFromHeader } from '../sniff';
import { mapFsError } from './output';

export interface ValidatedInput {
  /** Path as received (what the user dragged). */
  readonly originalPath: string;
  /** Canonical path after resolving symbolic links; used for reading. */
  readonly realPath: string;
  readonly displayName: string;
  /** Folder of the original path: outputs go next to what the user dragged. */
  readonly sourceDir: string;
  readonly format: FileFormat;
  readonly kind: InputKind;
  readonly bytes: number;
  readonly extensionMismatch: boolean;
}

export interface ValidateOptions {
  readonly limits?: ProcessingLimits;
  /** How long to wait for the first bytes (cloud placeholders / network shares can hang). */
  readonly headerTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
}

function isNetworkPath(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? path.startsWith('\\\\') : path.startsWith('/Volumes/') || path.startsWith('/net/');
}

async function readHeaderWithTimeout(path: string, timeoutMs: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = new Uint8Array(SNIFF_BYTES);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OrbitError('TIMEOUT', 'Reading the file header timed out')), timeoutMs);
    });
    try {
      const { bytesRead } = await Promise.race([handle.read(buffer, 0, SNIFF_BYTES, 0), timeout]);
      return buffer.subarray(0, bytesRead);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Validate a path received from a drop or dialog before any job is created.
 * Accepts local regular files (resolving symlinks with loop detection),
 * rejects folders, empty/oversized files and unknown formats, and detects the
 * real format from the header.
 */
export async function validateInputFile(inputPath: string, options: ValidateOptions = {}): Promise<ValidatedInput> {
  const limits = options.limits ?? DEFAULT_PROCESSING_LIMITS;
  const platform = options.platform ?? process.platform;
  if (!isAbsolute(inputPath)) throw new OrbitError('FILE_NOT_FOUND', 'Path must be absolute');

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
  if (info.isDirectory()) throw new OrbitError('NOT_A_FILE', 'Folders are not supported');
  if (!info.isFile()) throw new OrbitError('NOT_A_FILE', 'Not a regular file');
  if (info.size === 0) throw new OrbitError('IMAGE_CORRUPT', 'File is empty');
  if (info.size > limits.maxInputBytes) {
    throw new OrbitError('FILE_TOO_LARGE', 'File is larger than the limit', { detail: `${info.size} > ${limits.maxInputBytes}` });
  }

  // Dataless cloud files (iCloud "Optimize Storage", OneDrive Files On-Demand)
  // report their full size but have no local blocks; reading would start a
  // download that can hang, so give it a short timeout and say why.
  const maybePlaceholder = platform !== 'win32' && info.blocks === 0 && info.size > 0;
  let header: Uint8Array;
  try {
    header = await readHeaderWithTimeout(realPath, options.headerTimeoutMs ?? 5000);
  } catch (error) {
    if (error instanceof OrbitError && error.code === 'TIMEOUT') {
      if (maybePlaceholder) throw new OrbitError('CLOUD_PLACEHOLDER', 'File is not downloaded yet');
      if (isNetworkPath(realPath, platform)) throw new OrbitError('NETWORK_PATH_FAILED', 'Network location did not respond');
      throw error;
    }
    throw mapFsError(error, 'READ_PERMISSION_DENIED');
  }

  const format = detectFormatFromHeader(header);
  const kind = format === null ? undefined : inputKindOf(format);
  if (format === null || kind === undefined) throw new OrbitError('UNSUPPORTED_FORMAT', 'Unsupported or unknown file type');

  const displayName = basename(inputPath);
  const extFormat = formatFromExtension(splitName(displayName).ext);
  return {
    originalPath: inputPath,
    realPath,
    displayName,
    sourceDir: dirname(inputPath),
    format,
    kind,
    bytes: info.size,
    extensionMismatch: extFormat !== format,
  };
}
