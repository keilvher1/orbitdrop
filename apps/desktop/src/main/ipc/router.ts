import { OrbitError, type ErrorCode } from '@orbitdrop/contracts';
import { describeError, silentLogger, type Logger } from '../log';

/**
 * IPC plumbing shared by every channel:
 *  1. the sender must be one of our registered windows, the message must come
 *     from its main frame, and that frame must show our renderer URL;
 *  2. the payload is validated with the channel's zod schema;
 *  3. errors are converted to `Error("<ErrorCode>: <message>")` — the code
 *     prefix survives Electron's IPC error serialization (the preload strips
 *     Electron's own prefix), and unexpected errors never leak details such as
 *     file paths to the renderer.
 * Kept free of runtime Electron imports so it can be unit-tested.
 */

export interface FrameLike {
  readonly url: string;
  readonly processId: number;
  readonly routingId: number;
}

export interface SenderLike {
  readonly id: number;
  readonly mainFrame: FrameLike;
}

export interface IpcEventLike {
  readonly sender: SenderLike;
  readonly senderFrame: FrameLike | null;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: never, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: never, ...args: unknown[]) => void): unknown;
  removeHandler(channel: string): void;
  removeAllListeners(channel: string): unknown;
}

export interface SafeParser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface SenderGuard<R> {
  lookup(sender: SenderLike): R | undefined;
  isTrustedUrl(url: string): boolean;
}

export class IpcRejection extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'IpcRejection';
  }
}

/** Resolve the window record of a sender or throw. */
export function resolveSender<R>(event: IpcEventLike, guard: SenderGuard<R>): R {
  const record = guard.lookup(event.sender);
  if (record === undefined) throw new IpcRejection('INTERNAL', 'Untrusted sender');
  const frame = event.senderFrame;
  const main = event.sender.mainFrame;
  if (!frame || frame.processId !== main.processId || frame.routingId !== main.routingId) {
    throw new IpcRejection('INTERNAL', 'Only the main frame may call OrbitDrop');
  }
  if (!guard.isTrustedUrl(frame.url)) throw new IpcRejection('INTERNAL', 'Untrusted page');
  return record;
}

/** Error to throw back to the renderer. */
export function toIpcError(error: unknown, log: Logger, channel: string): Error {
  if (error instanceof IpcRejection) return new Error(error.message);
  if (error instanceof OrbitError) return new Error(`${error.code}: ${error.message}`);
  log.error('ipc handler failed', { channel, error: describeError(error) });
  return new Error('INTERNAL: Unexpected error');
}

export class IpcRouter<R> {
  private readonly channels: { channel: string; kind: 'handle' | 'on' }[] = [];
  private readonly log: Logger;

  constructor(
    private readonly ipc: IpcMainLike,
    private readonly guard: SenderGuard<R>,
    log?: Logger,
  ) {
    this.log = log ?? silentLogger;
  }

  /** Request/response channel (ipcRenderer.invoke). `schema` null = the channel takes no payload. */
  handle<T>(channel: string, schema: SafeParser<T> | null, fn: (payload: T, record: R) => unknown): void {
    this.ipc.handle(channel, async (rawEvent: never, raw?: unknown) => {
      const event = rawEvent as IpcEventLike;
      let record: R;
      try {
        record = resolveSender(event, this.guard);
      } catch (error) {
        this.log.warn('ipc call rejected', { channel, reason: error instanceof Error ? error.message : 'sender' });
        throw toIpcError(error, this.log, channel);
      }
      try {
        return await fn(this.parse(channel, schema, raw), record);
      } catch (error) {
        throw toIpcError(error, this.log, channel);
      }
    });
    this.channels.push({ channel, kind: 'handle' });
  }

  /** Fire-and-forget channel (ipcRenderer.send). Invalid calls are dropped. */
  on<T>(channel: string, schema: SafeParser<T> | null, fn: (payload: T, record: R) => void): void {
    this.ipc.on(channel, (rawEvent: never, raw?: unknown) => {
      const event = rawEvent as IpcEventLike;
      try {
        const record = resolveSender(event, this.guard);
        fn(this.parse(channel, schema, raw), record);
      } catch (error) {
        this.log.warn('ipc message dropped', { channel, reason: error instanceof Error ? error.message.slice(0, 120) : 'error' });
      }
    });
    this.channels.push({ channel, kind: 'on' });
  }

  dispose(): void {
    for (const { channel, kind } of this.channels) {
      if (kind === 'handle') this.ipc.removeHandler(channel);
      else this.ipc.removeAllListeners(channel);
    }
    this.channels.length = 0;
  }

  private parse<T>(channel: string, schema: SafeParser<T> | null, raw: unknown): T {
    if (schema === null) return undefined as T;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn('ipc payload rejected', { channel });
      throw new IpcRejection('INVALID_OPTIONS', 'Invalid request');
    }
    return parsed.data;
  }
}
