import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { OrbitError } from '@orbitdrop/contracts';

/**
 * Bridge to the macOS helper's optional ImageIO codec mode (P2 HEIC), see
 * docs/architecture.md "Shared paths":
 *   <helper> imageio --probe                                   → {"decode":[…],"encode":[…]}
 *   <helper> imageio --decode <in> --out <out.png>
 *   <helper> imageio --encode heic --quality <0..1> <in.png> --out <out.heic>
 * Main points workers at the binary with ORBITDROP_IMAGEIO_HELPER. Data is
 * exchanged through files in a private temp folder that is always removed.
 */

export const IMAGEIO_HELPER_ENV = 'ORBITDROP_IMAGEIO_HELPER';

const PROBE_TIMEOUT_MS = 3000;
const CODEC_TIMEOUT_MS = 60_000;
const MAX_STDIO_BYTES = 64 * 1024;

export interface ImageIOProbe {
  readonly decode: readonly string[];
  readonly encode: readonly string[];
}

export interface ImageIOCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Helper binary; defaults to $ORBITDROP_IMAGEIO_HELPER. */
  readonly helperPath?: string;
}

/** Configured helper path (absolute) or null. Does not check the file. */
export function imageIOHelperPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[IMAGEIO_HELPER_ENV]?.trim();
  return value && isAbsolute(value) ? value : null;
}

/** True when `path` is an executable regular file. */
export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, process.platform === 'win32' ? fsConstants.R_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveHelper(explicit?: string): Promise<string> {
  const helper = explicit ?? imageIOHelperPath();
  if (!helper || !(await isExecutableFile(helper))) {
    throw new OrbitError('ENGINE_UNAVAILABLE', 'The ImageIO codec helper is not available');
  }
  return helper;
}

interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runHelper(helper: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OrbitError('CANCELLED', 'Cancelled'));
      return;
    }
    let child;
    try {
      child = spawn(helper, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(new OrbitError('ENGINE_UNAVAILABLE', 'Could not start the ImageIO codec helper', { cause: error }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new OrbitError('TIMEOUT', 'The ImageIO codec helper did not respond in time')));
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish(() => reject(new OrbitError('CANCELLED', 'Cancelled')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_STDIO_BYTES) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDIO_BYTES) stderr += chunk;
    });
    child.on('error', (error) => {
      finish(() => reject(new OrbitError('ENGINE_UNAVAILABLE', 'Could not start the ImageIO codec helper', { detail: (error as NodeJS.ErrnoException).code ?? error.message, cause: error })));
    });
    child.on('close', (code, sig) => {
      finish(() => resolve({ code, signal: sig, stdout, stderr }));
    });
  });
}

function shortDetail(result: RunResult): string {
  const firstLine = result.stderr.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  return `exit=${result.code ?? result.signal ?? '?'} ${firstLine.slice(0, 200)}`.trim();
}

function parseFormatList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase());
}

/** Ask the helper which formats ImageIO can decode/encode on this Mac (3 s timeout). */
export async function probeImageIO(options: ImageIOCallOptions = {}): Promise<ImageIOProbe> {
  const helper = await resolveHelper(options.helperPath);
  const result = await runHelper(helper, ['imageio', '--probe'], options.timeoutMs ?? PROBE_TIMEOUT_MS, options.signal);
  if (result.code !== 0) throw new OrbitError('ENGINE_UNAVAILABLE', 'ImageIO probe failed', { detail: shortDetail(result) });
  // The JSON object is the last non-empty line of stdout.
  const line = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  if (!line) throw new OrbitError('ENGINE_UNAVAILABLE', 'ImageIO probe returned no JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new OrbitError('ENGINE_UNAVAILABLE', 'ImageIO probe returned invalid JSON', { cause: error });
  }
  const obj = parsed as { decode?: unknown; encode?: unknown };
  return { decode: parseFormatList(obj.decode), encode: parseFormatList(obj.encode) };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'orbitdrop-imageio-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readNonEmpty(path: string, what: string): Promise<Buffer> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (error) {
    throw new OrbitError('INTERNAL', `The ImageIO codec helper produced no ${what}`, { cause: error });
  }
  if (data.length === 0) throw new OrbitError('INTERNAL', `The ImageIO codec helper produced an empty ${what}`);
  return data;
}

/** Decode an image ImageIO understands (HEIC/HEIF…) to PNG bytes. */
export async function decodeWithImageIO(input: Buffer, options: ImageIOCallOptions & { readonly ext?: string } = {}): Promise<Buffer> {
  const helper = await resolveHelper(options.helperPath);
  return withTempDir(async (dir) => {
    const ext = (options.ext ?? '.heic').replace(/[^.a-z0-9]/gi, '') || '.heic';
    const inPath = join(dir, `input${ext.startsWith('.') ? ext : `.${ext}`}`);
    const outPath = join(dir, 'output.png');
    await writeFile(inPath, input);
    const result = await runHelper(helper, ['imageio', '--decode', inPath, '--out', outPath], options.timeoutMs ?? CODEC_TIMEOUT_MS, options.signal);
    if (result.code !== 0) throw new OrbitError('IMAGE_CORRUPT', 'Image could not be decoded', { detail: shortDetail(result) });
    return readNonEmpty(outPath, 'PNG');
  });
}

/** Encode PNG bytes to HEIC with ImageIO. `quality` is 1–100 (mapped to 0–1 for the helper). */
export async function encodeWithImageIO(png: Buffer, format: 'heic', quality: number, options: ImageIOCallOptions = {}): Promise<Buffer> {
  const helper = await resolveHelper(options.helperPath);
  const q = Math.min(1, Math.max(0, quality / 100));
  return withTempDir(async (dir) => {
    const inPath = join(dir, 'input.png');
    const outPath = join(dir, `output.${format}`);
    await writeFile(inPath, png);
    const result = await runHelper(
      helper,
      ['imageio', '--encode', format, '--quality', q.toFixed(2), inPath, '--out', outPath],
      options.timeoutMs ?? CODEC_TIMEOUT_MS,
      options.signal,
    );
    if (result.code !== 0) throw new OrbitError('INTERNAL', 'HEIC encoding failed', { detail: shortDetail(result) });
    return readNonEmpty(outPath, format.toUpperCase());
  });
}
