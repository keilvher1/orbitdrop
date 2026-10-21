/**
 * libuv thread pool size for the main process. Must be the FIRST import of the
 * main entry: libuv reads UV_THREADPOOL_SIZE once, on the first thread-pool
 * use (any async fs call). Measured in Electron 44: setting it before that
 * point takes effect (with the default of 4, four hung reads of online-only
 * cloud files or a dead network share would stall every fs call in main —
 * settings, history, validation; validateInputFile gives up after its timeout
 * but the blocked read keeps its thread until the OS returns).
 *
 * A value the user set is respected. Processor workers get the original value
 * back (see processing/electron-worker.ts), so their behaviour is unchanged.
 */
export const ORIGINAL_UV_THREADPOOL_SIZE: string | undefined = process.env.UV_THREADPOOL_SIZE;

export const MAIN_UV_THREADPOOL_SIZE = 16;

if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = String(MAIN_UV_THREADPOOL_SIZE);

/** Effective size for this process (libuv default 4, max 1024). */
export function threadpoolSize(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const n = Number.parseInt(env.UV_THREADPOOL_SIZE ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(1024, n) : 4;
}
