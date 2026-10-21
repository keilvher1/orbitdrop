import { OrbitError } from '@orbitdrop/contracts';

/**
 * Concurrency limit for background work on the preview worker: file-list
 * thumbnails and the per-file estimates of a batch Compress. At most `limit`
 * tasks run at once (across all editors); the others wait in FIFO order. A
 * waiting task whose signal is aborted leaves the queue at once and rejects
 * with CANCELLED — it never starts. Editor tool previews and source previews do
 * not go through it, so they never wait behind a long list of thumbnails.
 */
export class BackgroundLimiter {
  private active = 0;
  private readonly waiting: { readonly start: () => void; readonly cancel: () => void; readonly signal: AbortSignal }[] = [];

  constructor(private readonly limit = 2) {}

  run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.active += 1;
        let promise: Promise<T>;
        try {
          promise = task();
        } catch (error) {
          promise = Promise.reject(error);
        }
        promise.then(resolve, reject).finally(() => {
          this.active -= 1;
          this.next();
        });
      };
      if (this.active < this.limit) {
        start();
        return;
      }
      const entry = {
        start,
        signal,
        cancel: (): void => {
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(cancelled());
        },
      };
      signal.addEventListener('abort', entry.cancel, { once: true });
      this.waiting.push(entry);
    });
  }

  /** Tasks running now. */
  get running(): number {
    return this.active;
  }

  /** Tasks waiting for a slot. */
  get queued(): number {
    return this.waiting.length;
  }

  private next(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      entry.signal.removeEventListener('abort', entry.cancel);
      entry.start();
    }
  }
}

function cancelled(): OrbitError {
  return new OrbitError('CANCELLED', 'Cancelled');
}
