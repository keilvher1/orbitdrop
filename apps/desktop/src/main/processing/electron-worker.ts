import { utilityProcess } from 'electron';
import { createLogger, redactPaths } from '../log';
import { ORIGINAL_UV_THREADPOOL_SIZE } from '../uv-threadpool';
import type { WorkerFactory, WorkerProcess } from './pool';

const log = createLogger('worker');

/** Spawns processor workers as Electron utility processes running out/main/processor-host.js. */
export function createUtilityWorkerFactory(options: { readonly hostPath: string; readonly env: Readonly<Record<string, string>> }): WorkerFactory {
  return (role, index): WorkerProcess => {
    const name = role === 'aux' ? 'OrbitDrop Preview Worker' : `OrbitDrop Processor ${index + 1}`;
    const child = utilityProcess.fork(options.hostPath, [], {
      serviceName: name,
      stdio: 'pipe',
      env: { ...options.env },
    });
    // Worker output is diagnostics only; forward it to the main log (debug level, paths redacted).
    const forward = (stream: NodeJS.ReadableStream | null, level: 'debug' | 'warn'): void => {
      stream?.on('data', (chunk: Buffer | string) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim().length > 0) log[level](`${role}${index}: ${redactPaths(line).slice(0, 400)}`);
        }
      });
    };
    forward(child.stdout, 'debug');
    forward(child.stderr, 'warn');
    // 'error' (e.g. V8 out of memory) comes before 'exit'; without a listener the EventEmitter would throw in main.
    child.on('error', (type, location) => {
      log.warn(`${role}${index} fatal error`, { type, location: redactPaths(String(location)).slice(0, 200) });
    });
    return {
      get pid() {
        return child.pid;
      },
      postMessage: (message) => child.postMessage(message),
      kill: () => child.kill(),
      onMessage: (listener) => {
        child.on('message', listener);
      },
      onExit: (listener) => {
        child.on('exit', listener);
      },
    };
  };
}

/** Variables only main may set for workers; inherited values are dropped (another process could plant them). */
const MAIN_OWNED_WORKER_VARS: ReadonlySet<string> = new Set(['ORBITDROP_IMAGEIO_HELPER', 'ORBITDROP_PARENT_PID']);

/**
 * Environment for workers: the parent's environment plus OrbitDrop variables.
 * UV_THREADPOOL_SIZE goes back to what the user had (main raises its own).
 * Packaged builds pass no inherited ORBITDROP_* variable at all: the
 * processors honour development overrides such as ORBITDROP_PDFJS_DIR (the
 * folder PDF.js is imported from), and a value planted with
 * `launchctl setenv` would otherwise load foreign code into a process that
 * reads files with OrbitDrop's permissions. Names are compared case-
 * insensitively: on Windows `orbitdrop_pdfjs_dir` is the same variable.
 */
export function workerEnv(extra: Readonly<Record<string, string | undefined>>, packaged = false, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = key.toUpperCase();
    if (MAIN_OWNED_WORKER_VARS.has(name) || (packaged && name.startsWith('ORBITDROP_'))) continue;
    env[key] = value;
  }
  if (ORIGINAL_UV_THREADPOOL_SIZE === undefined) delete env.UV_THREADPOOL_SIZE;
  else env.UV_THREADPOOL_SIZE = ORIGINAL_UV_THREADPOOL_SIZE;
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  return env;
}
