import type { MainToProcessorMessage, ProcessorToMainMessage } from '@orbitdrop/contracts';
import type { WorkerFactory, WorkerProcess, WorkerRole } from '../../src/main/processing/pool';

export type Behavior = (message: MainToProcessorMessage, worker: FakeWorker) => void;

/** Scriptable stand-in for a utilityProcess running processor-host.js. */
export class FakeWorker implements WorkerProcess {
  static nextPid = 1000;
  readonly pid: number;
  readonly received: MainToProcessorMessage[] = [];
  alive = true;
  killCalls = 0;
  /** When true, kill() does not terminate the process (stuck native code). */
  ignoreKill = false;
  private readonly messageListeners: ((message: unknown) => void)[] = [];
  private readonly exitListeners: ((code: number) => void)[] = [];

  constructor(
    readonly role: WorkerRole,
    readonly index: number,
    private readonly behavior: Behavior,
    readyDelayMs = 0,
  ) {
    FakeWorker.nextPid += 1;
    this.pid = FakeWorker.nextPid;
    setTimeout(() => this.emit({ type: 'ready', pid: this.pid }), readyDelayMs);
  }

  postMessage(message: MainToProcessorMessage): void {
    if (!this.alive) throw new Error('worker is dead');
    this.received.push(message);
    setImmediate(() => {
      if (this.alive) this.behavior(message, this);
    });
  }

  kill(): boolean {
    this.killCalls += 1;
    if (!this.alive || this.ignoreKill) return !this.ignoreKill;
    setTimeout(() => this.exit(-15), 1);
    return true;
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListeners.push(listener);
  }

  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener);
  }

  emit(message: ProcessorToMainMessage): void {
    if (!this.alive) return;
    for (const listener of this.messageListeners) listener(message);
  }

  exit(code: number): void {
    if (!this.alive) return;
    this.alive = false;
    for (const listener of this.exitListeners) listener(code);
  }

  ofType<T extends MainToProcessorMessage['type']>(type: T): Extract<MainToProcessorMessage, { type: T }>[] {
    return this.received.filter((m): m is Extract<MainToProcessorMessage, { type: T }> => m.type === type);
  }
}

export interface FakeFleet {
  readonly fork: WorkerFactory;
  readonly workers: FakeWorker[];
  jobs(): FakeWorker[];
  aux(): FakeWorker[];
}

export function fakeFleet(behavior: Behavior, readyDelayMs = 0): FakeFleet {
  const workers: FakeWorker[] = [];
  return {
    workers,
    fork: (role, index) => {
      const worker = new FakeWorker(role, index, behavior, readyDelayMs);
      workers.push(worker);
      return worker;
    },
    jobs: () => workers.filter((w) => w.role === 'job'),
    aux: () => workers.filter((w) => w.role === 'aux'),
  };
}

/** Default behavior: shutdown exits, probes report nothing special; jobs/previews handled by `extra`. */
export function standardBehavior(extra: Behavior): Behavior {
  return (message, worker) => {
    if (message.type === 'shutdown') {
      setTimeout(() => worker.exit(0), 1);
      return;
    }
    extra(message, worker);
  };
}
