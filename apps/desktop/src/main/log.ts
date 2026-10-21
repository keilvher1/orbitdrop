import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Minimal structured logger for the main process.
 *
 * Rules (docs/architecture.md): never log document contents and avoid file
 * paths — log ids, codes and counts. Data values are restricted to primitives
 * and every string goes through `redactPaths` as a last line of defense.
 * Output goes to stderr (stdout is reserved for the smoke-test line) and,
 * when configured, to a small rotating file in the app data folder.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;
export type LogData = Readonly<Record<string, LogValue>>;

export interface Logger {
  debug(message: string, data?: LogData): void;
  info(message: string, data?: LogData): void;
  warn(message: string, data?: LogData): void;
  error(message: string, data?: LogData): void;
}

// A quoted absolute path, spaces included ("…", '…' or `…`).
const QUOTED_PATH_PATTERN = /(["'`])(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|~\/|\/(?=[^\s/]))[^"'`\n]*\1/g;
// file:// URLs anywhere; otherwise a path must start a token (after a space, quote, '=', '(', ',', ':' or '[').
const PATH_PATTERN = /file:\/\/[^\s"'<>]*|(?<=^|[\s"'=(,:[])(?:[A-Za-z]:[\\/]|\\\\|~\/|\/(?=[^\s/]))[^\s"'<>|*?]*/g;

/** Replace anything that looks like an absolute path (POSIX, Windows, UNC, ~/, file://) with <path>. */
export function redactPaths(text: string): string {
  return text.replace(QUOTED_PATH_PATTERN, '$1<path>$1').replace(PATH_PATTERN, (match) => (match.length <= 1 ? match : '<path>'));
}

// An unquoted absolute path may contain spaces: take everything up to a quote, bracket or line end.
const PATH_TO_LINE_END_PATTERN = /file:\/\/[^\n"'`<>]*|(?<=^|[\s=(,:[])(?:[A-Za-z]:[\\/]|\\\\|~\/|\/(?=[^\s/]))[^\n"'`<>|*?]*/g;

/**
 * Stricter variant for text that reaches the renderer or history (error
 * messages/details): quoted paths, unquoted paths through the end of the line
 * (spaces included — error text usually ends with the path) and any remaining
 * token with a path separator are replaced.
 */
export function scrubPaths(text: string): string {
  return text
    .replace(QUOTED_PATH_PATTERN, '$1<path>$1')
    .replace(PATH_TO_LINE_END_PATTERN, '<path>')
    .replace(/[^\s"'`]*[\\/][^\s"'`]*/g, '<path>');
}

interface Sink {
  debug: boolean;
  stderr: boolean;
  file: WriteStream | null;
}

const sink: Sink = { debug: process.env.ORBITDROP_DEBUG === '1', stderr: true, file: null };

const MAX_LOG_BYTES = 1024 * 1024;

export function configureLogSink(options: { readonly file?: string; readonly debug?: boolean; readonly stderr?: boolean }): void {
  if (options.debug !== undefined) sink.debug = options.debug;
  if (options.stderr !== undefined) sink.stderr = options.stderr;
  if (options.file) {
    try {
      mkdirSync(dirname(options.file), { recursive: true });
      try {
        if (statSync(options.file).size > MAX_LOG_BYTES) renameSync(options.file, `${options.file}.1`);
      } catch {
        // no previous log
      }
      sink.file?.end();
      sink.file = createWriteStream(options.file, { flags: 'a', mode: 0o600 });
      sink.file.on('error', () => {
        sink.file = null;
      });
    } catch {
      sink.file = null;
    }
  }
}

export function closeLogSink(): void {
  sink.file?.end();
  sink.file = null;
}

function format(level: LogLevel, scope: string, message: string, data?: LogData): string {
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${redactPaths(message)}`;
  if (data) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      parts.push(`${key}=${typeof value === 'string' ? JSON.stringify(redactPaths(value).slice(0, 300)) : String(value)}`);
    }
    if (parts.length > 0) line += ` ${parts.join(' ')}`;
  }
  return line;
}

function write(level: LogLevel, scope: string, message: string, data?: LogData): void {
  if (level === 'debug' && !sink.debug) return;
  const line = format(level, scope, message, data);
  if (sink.stderr) {
    try {
      process.stderr.write(`${line}\n`);
    } catch {
      // stderr closed
    }
  }
  sink.file?.write(`${line}\n`);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, data) => write('debug', scope, message, data),
    info: (message, data) => write('info', scope, message, data),
    warn: (message, data) => write('warn', scope, message, data),
    error: (message, data) => write('error', scope, message, data),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Short, path-free description of an unknown error for logs. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return redactPaths(`${error.name}${typeof code === 'string' ? `(${code})` : ''}: ${error.message}`).slice(0, 500);
  }
  return redactPaths(String(error)).slice(0, 500);
}
