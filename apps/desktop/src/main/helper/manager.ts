import type { Readable, Writable } from 'node:stream';
import {
  HELPER_MAX_LINE_BYTES,
  HELPER_PROTOCOL_VERSION,
  parseHelperLine,
  utf8ByteLength,
  type HelperConfigureMessage,
  type HelperDropMessage,
  type HelperReadyMessage,
  type HelperStatus,
  type HelperToMainMessage,
  type MainToHelperMessage,
} from '@orbitdrop/contracts';
import { DragSessionTracker } from '@orbitdrop/core';
import { describeError, redactPaths, silentLogger, type Logger } from '../log';
import { LineReader } from './line-reader';
import type { HelperLocation } from './locate';
import { HELPER_REASON_NOT_FOUND } from './status-text';

/**
 * HelperManager: owns the native drag helper process.
 *
 *  - spawn (no shell, stdio pipes, hidden window), bounded NDJSON line reader,
 *    `parseHelperLine` validation (invalid lines are dropped and counted);
 *  - per process: DragSessionTracker.helperRestarted() at spawn; every line of
 *    that process is handled with its generation (`tracker.handle(msg, gen)`);
 *  - on `ready`: send `configure`
 *    (re-sent when settings/locale/theme/capabilities change), query
 *    permissions (macOS), start the ping/pong watchdog;
 *  - drops: the tracker accepts one drop per session; the drop is handed to
 *    main's pipeline on the NEXT tick (setImmediate) so the helper's drop
 *    callback is never blocked by validation, dialogs or window creation;
 *  - crash/hang: restart with exponential backoff, at most `maxRestarts`
 *    within `restartWindowMs`, then status 'crashed';
 *  - sleep / screen lock (`cancelSessions`): every open drag session is
 *    cancelled with `cancelSession` (the helper hides its wheel and answers
 *    `cancelled`); after resume (`recheck`) the helper is pinged, re-configured
 *    (displays may have changed) and asked for its permissions again, and a
 *    helper that had given up is restarted with a fresh budget;
 *  - quit: `shutdown`, close stdin, kill after a timeout.
 * Logs carry session ids, action ids and counts — never file paths.
 */

export interface HelperChild {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export type HelperSpawner = (path: string) => HelperChild;

export interface HelperManagerOptions {
  readonly locate: () => Promise<HelperLocation | null>;
  readonly spawn: HelperSpawner;
  /** Current configure message; null while capabilities are not known yet. */
  readonly configure: () => HelperConfigureMessage | null;
  readonly enabled: () => boolean;
  readonly onDrop: (drop: HelperDropMessage) => void | Promise<void>;
  readonly onStatus?: (status: HelperStatus) => void;
  readonly log?: Logger;
  readonly platform?: NodeJS.Platform;
  readonly readyTimeoutMs?: number;
  readonly pingIntervalMs?: number;
  readonly missedPongLimit?: number;
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly permissionPollMs?: number;
  readonly now?: () => number;
}

type PermissionItems = Extract<HelperToMainMessage, { type: 'permissions' }>['items'];

export class HelperManager {
  readonly tracker = new DragSessionTracker();
  private readonly log: Logger;
  private readonly now: () => number;
  private location: HelperLocation | null = null;
  private child: HelperChild | null = null;
  private childExited = true;
  private generation = 0;
  private readyMessage: HelperReadyMessage | null = null;
  private permissions: PermissionItems | null = null;
  private statusValue: HelperStatus = { state: 'starting' };
  private restartTimes: number[] = [];
  private stopped = false;
  private lastConfigure: string | null = null;
  private nonce = 0;
  private pendingPing: number | null = null;
  private missedPongs = 0;
  private invalidLines = 0;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private permissionTimer: ReturnType<typeof setInterval> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private readyWaiters: ((ready: HelperReadyMessage | null) => void)[] = [];
  /** Sessions of the current process seen in a `state` message and not ended yet (wheel possibly on screen). */
  private readonly openSessions = new Set<string>();

  constructor(private readonly options: HelperManagerOptions) {
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? Date.now;
  }

  get status(): HelperStatus {
    return this.statusValue;
  }

  get helperLocation(): HelperLocation | null {
    return this.location;
  }

  get readyInfo(): HelperReadyMessage | null {
    return this.readyMessage;
  }

  get invalidLineCount(): number {
    return this.invalidLines;
  }

  /** A drag session is open (its wheel may be on screen): a restart to update waits for it. */
  get dragInProgress(): boolean {
    return this.openSessions.size > 0;
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (!this.location) {
      try {
        this.location = await this.options.locate();
      } catch (error) {
        this.log.warn('helper lookup failed', { error: describeError(error) });
        this.location = null;
      }
    }
    if (this.stopped) return;
    if (!this.location) {
      this.log.warn('native helper not found; global drag unavailable (Open File and Drop Zone still work)');
      this.setStatus({ state: 'unavailable', reason: HELPER_REASON_NOT_FOUND });
      this.resolveReadyWaiters(null);
      return;
    }
    this.log.info('starting native helper', { source: this.location.source });
    this.spawnChild();
  }

  /** Resolves with the ready message, or null on timeout / unavailable / crash. */
  waitForReady(timeoutMs: number): Promise<HelperReadyMessage | null> {
    if (this.readyMessage) return Promise.resolve(this.readyMessage);
    if (this.statusValue.state === 'unavailable' || this.statusValue.state === 'crashed') return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== done);
        resolve(null);
      }, timeoutMs);
      const done = (ready: HelperReadyMessage | null): void => {
        clearTimeout(timer);
        resolve(ready);
      };
      this.readyWaiters.push(done);
    });
  }

  /** Re-send `configure` if it changed (settings, locale, theme, capabilities). */
  reconfigure(): void {
    this.sendConfigure(false);
    this.updateStatus();
  }

  /** Manual restart (tray "Restart"): resets the crash budget. */
  async restart(): Promise<void> {
    this.restartTimes = [];
    if (this.child && !this.childExited) {
      await this.stop();
    }
    this.stopped = false;
    await this.start();
  }

  /**
   * Sleep, screen lock or a user switch: ask the helper to cancel every drag
   * session that is still open, so no wheel stays on screen and nothing is
   * dropped on the other side. The helper ends them with `cancelled` (the
   * tracker then closes them); a drop it had already sent still counts — the
   * user made it before the system went away. Returns how many were cancelled.
   */
  cancelSessions(reason: string): number {
    const sessions = [...this.openSessions];
    for (const sessionId of sessions) this.write({ v: HELPER_PROTOCOL_VERSION, type: 'cancelSession', sessionId });
    if (sessions.length > 0) this.log.info('drag sessions cancelled', { reason, sessions: sessions.length });
    return sessions.length;
  }

  /**
   * After resume / unlock: make sure the helper still works. A running helper
   * is pinged at once (the watchdog restarts it if it stays silent), gets its
   * configuration again (the displays may have changed while asleep) and, on
   * macOS, is asked for its permissions again; a helper that had given up
   * ('crashed') gets one more series of attempts with a fresh budget.
   */
  async recheck(reason: string): Promise<void> {
    if (this.stopped) return;
    if (this.statusValue.state === 'crashed') {
      this.log.info('restarting the native helper after resume', { reason });
      await this.restart();
      return;
    }
    if (!this.child || this.childExited || !this.readyMessage) return; // starting, restarting or unavailable
    this.log.debug('re-checking the native helper', { reason });
    if (this.pendingPing === null) {
      this.nonce += 1;
      this.pendingPing = this.nonce;
      this.write({ v: HELPER_PROTOCOL_VERSION, type: 'ping', nonce: this.nonce });
    }
    this.sendConfigure(true);
    if ((this.options.platform ?? process.platform) === 'darwin') this.write({ v: HELPER_PROTOCOL_VERSION, type: 'queryPermissions' });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child || this.childExited) {
      this.child = null;
      return;
    }
    this.write({ v: HELPER_PROTOCOL_VERSION, type: 'shutdown' });
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.log.warn('helper did not exit after shutdown; killing it');
        try {
          child.kill();
        } catch {
          // gone
        }
        setTimeout(finish, 300).unref?.();
      }, this.options.shutdownTimeoutMs ?? 1500);
      child.once('exit', finish);
      if (this.childExited) finish();
    });
    this.child = null;
  }

  // ------------------------------------------------------------------ process

  private spawnChild(): void {
    if (!this.location || this.stopped) return;
    this.generation += 1;
    const generation = this.generation;
    // One tracker generation per helper process: every line of this process is tagged with it, so
    // sessions of an earlier process (even with a reused id) can never produce a drop.
    const sessionGeneration = this.tracker.helperRestarted();
    this.openSessions.clear();
    this.readyMessage = null;
    this.permissions = null;
    this.lastConfigure = null;
    this.setStatus({ state: 'starting' });
    let child: HelperChild;
    try {
      child = this.options.spawn(this.location.path);
    } catch (error) {
      this.childExited = true;
      this.onChildGone(generation, `spawn failed: ${describeError(error)}`);
      return;
    }
    this.child = child;
    this.childExited = false;
    const reader = new LineReader(
      HELPER_MAX_LINE_BYTES,
      (line) => this.onLine(generation, sessionGeneration, line),
      () => this.log.warn('helper line exceeded the size limit; dropped'),
    );
    child.stdout?.on('data', (chunk: Buffer | string) => reader.push(chunk));
    const stderrReader = new LineReader(64 * 1024, (line) => this.log.debug(`helper stderr: ${redactPaths(line).slice(0, 300)}`));
    child.stderr?.on('data', (chunk: Buffer | string) => stderrReader.push(chunk));
    child.stdin?.on('error', () => undefined); // EPIPE after the helper died: the exit handler takes over
    child.once('error', (error) => this.onChildGone(generation, `process error: ${describeError(error)}`));
    child.once('exit', (code, signal) => this.onChildGone(generation, `exited (code ${code ?? 'none'}${signal ? `, ${signal}` : ''})`));
    this.readyTimer = setTimeout(() => {
      if (generation !== this.generation || this.readyMessage) return;
      this.log.warn('helper did not report ready in time; restarting');
      this.killChild();
    }, this.options.readyTimeoutMs ?? 10_000);
    this.readyTimer.unref?.();
  }

  private onChildGone(generation: number, reason: string): void {
    if (generation !== this.generation) return;
    this.generation += 1; // ignore further events of this process
    this.childExited = true;
    this.child = null;
    this.readyMessage = null;
    this.clearTimers();
    this.tracker.helperRestarted(); // sessions of the dead process are closed
    this.openSessions.clear();
    if (this.stopped) return;
    this.log.warn('native helper stopped', { reason });
    const now = this.now();
    const windowMs = this.options.restartWindowMs ?? 10 * 60_000;
    this.restartTimes = this.restartTimes.filter((t) => now - t < windowMs);
    const max = this.options.maxRestarts ?? 5;
    if (this.restartTimes.length >= max) {
      this.log.error('native helper keeps failing; giving up', { restarts: this.restartTimes.length });
      this.setStatus({ state: 'crashed', restarts: this.restartTimes.length, reason });
      this.resolveReadyWaiters(null);
      return;
    }
    this.restartTimes.push(now);
    const delayMs = Math.min(this.options.backoffMaxMs ?? 15_000, (this.options.backoffBaseMs ?? 500) * 2 ** (this.restartTimes.length - 1));
    this.setStatus({ state: 'starting' });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnChild();
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private killChild(): void {
    try {
      this.child?.kill();
    } catch {
      // gone
    }
  }

  // ------------------------------------------------------------------ messages

  private onLine(generation: number, sessionGeneration: number, line: string): void {
    if (generation !== this.generation) return;
    const message = parseHelperLine(line);
    if (!message) {
      this.invalidLines += 1;
      this.log.warn('invalid helper message dropped', { count: this.invalidLines, bytes: utf8ByteLength(line) });
      return;
    }
    switch (message.type) {
      case 'ready':
        this.onReady(message);
        return;
      case 'pong':
        if (message.nonce === this.pendingPing) {
          this.pendingPing = null;
          this.missedPongs = 0;
        }
        return;
      case 'permissions':
        this.permissions = message.items;
        this.updateStatus();
        return;
      case 'log':
        this.log[message.level === 'error' ? 'error' : message.level === 'warn' ? 'warn' : 'debug'](`helper: ${message.message}`);
        return;
      case 'error':
        this.log.error('helper reported an error', { code: message.code, fatal: message.fatal, message: message.message.slice(0, 200) });
        return;
      case 'state':
      case 'cancelled':
      case 'drop': {
        const decision = this.tracker.handle(message, sessionGeneration);
        if (decision.kind === 'stateChanged') {
          if (decision.state === 'Idle' || decision.state === 'Cancelled') this.openSessions.delete(decision.sessionId);
          else this.openSessions.add(decision.sessionId);
          // A helper has one session at a time; never let a misbehaving one grow this set.
          if (this.openSessions.size > 16) this.openSessions.delete(this.openSessions.values().next().value!);
        }
        if (decision.kind === 'acceptDrop') {
          const drop = decision.drop;
          this.openSessions.delete(drop.sessionId);
          this.log.info('drop accepted', { sessionId: drop.sessionId, actionId: drop.actionId, mode: drop.mode, files: drop.files.length });
          // Next tick: the helper's drop callback has long returned before main does any work.
          setImmediate(() => {
            Promise.resolve()
              .then(() => this.options.onDrop(drop))
              .catch((error: unknown) => this.log.error('drop handling failed', { sessionId: drop.sessionId, error: describeError(error) }));
          });
        } else if (decision.kind === 'ignore' && message.type === 'drop') {
          this.log.warn('drop ignored', { sessionId: message.sessionId, reason: decision.reason });
        } else if (message.type === 'cancelled') {
          this.log.debug('drag session cancelled', { sessionId: message.sessionId, reason: message.reason });
        }
        return;
      }
      default:
        return;
    }
  }

  private onReady(message: HelperReadyMessage): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.readyMessage = message;
    // No tracker reset here: this process got its session generation at spawn (a re-announced
    // `ready` from the same process must not invalidate its own sessions).
    this.lastConfigure = null;
    this.log.info('native helper ready', {
      version: message.helperVersion,
      platform: message.platform,
      arch: message.arch,
      globalDrag: message.globalDrag.available,
      reason: message.globalDrag.reason,
    });
    this.sendConfigure(true);
    if ((this.options.platform ?? process.platform) === 'darwin') this.write({ v: HELPER_PROTOCOL_VERSION, type: 'queryPermissions' });
    this.startPing();
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.restartTimes = []; // ran stably: restore the restart budget
    }, 2 * 60_000);
    this.stableTimer.unref?.();
    this.updateStatus();
    this.resolveReadyWaiters(message);
  }

  private sendConfigure(force: boolean): void {
    if (!this.readyMessage || !this.child) return;
    let message: HelperConfigureMessage | null;
    try {
      message = this.options.configure();
    } catch (error) {
      this.log.error('could not build helper configuration', { error: describeError(error) });
      return;
    }
    if (!message) return;
    const json = JSON.stringify(message);
    if (!force && json === this.lastConfigure) return;
    if (this.writeJson(json)) this.lastConfigure = json;
  }

  private write(message: MainToHelperMessage): boolean {
    return this.writeJson(JSON.stringify(message));
  }

  private writeJson(json: string): boolean {
    const child = this.child;
    if (!child?.stdin || this.childExited) return false;
    if (utf8ByteLength(json) > HELPER_MAX_LINE_BYTES) {
      this.log.error('helper message too large; not sent');
      return false;
    }
    try {
      child.stdin.write(`${json}\n`);
      return true;
    } catch (error) {
      this.log.warn('helper write failed', { error: describeError(error) });
      return false;
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pendingPing = null;
    this.missedPongs = 0;
    this.pingTimer = setInterval(() => {
      if (!this.child || !this.readyMessage) return;
      if (this.pendingPing !== null) {
        this.missedPongs += 1;
        if (this.missedPongs >= (this.options.missedPongLimit ?? 3)) {
          this.log.warn('helper stopped answering pings; restarting', { missed: this.missedPongs });
          this.killChild();
          return;
        }
      }
      this.nonce += 1;
      this.pendingPing = this.nonce;
      this.write({ v: HELPER_PROTOCOL_VERSION, type: 'ping', nonce: this.nonce });
    }, this.options.pingIntervalMs ?? 10_000);
    this.pingTimer.unref?.();
  }

  private updateStatus(): void {
    const ready = this.readyMessage;
    if (!ready || !this.child) return;
    let status: HelperStatus;
    const missing = (this.permissions ?? []).filter((item) => item.required && !item.granted).map((item) => item.name);
    if (!this.options.enabled()) status = { state: 'disabled' };
    else if (missing.length > 0) status = { state: 'needsPermission', permissions: missing };
    else {
      status = {
        state: 'running',
        helperVersion: ready.helperVersion,
        globalDrag: ready.globalDrag.available,
        ...(ready.globalDrag.reason ? { reason: ready.globalDrag.reason } : {}),
      };
    }
    this.setStatus(status);
    this.updatePermissionPolling(status.state === 'needsPermission');
  }

  private updatePermissionPolling(active: boolean): void {
    if (active && !this.permissionTimer) {
      this.permissionTimer = setInterval(() => this.write({ v: HELPER_PROTOCOL_VERSION, type: 'queryPermissions' }), this.options.permissionPollMs ?? 15_000);
      this.permissionTimer.unref?.();
    } else if (!active && this.permissionTimer) {
      clearInterval(this.permissionTimer);
      this.permissionTimer = null;
    }
  }

  private setStatus(status: HelperStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.statusValue)) return;
    this.statusValue = status;
    try {
      this.options.onStatus?.(status);
    } catch (error) {
      this.log.error('helper status listener failed', { error: describeError(error) });
    }
  }

  private resolveReadyWaiters(ready: HelperReadyMessage | null): void {
    const waiters = this.readyWaiters.splice(0);
    waiters.forEach((resolve) => resolve(ready));
  }

  private clearTimers(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.permissionTimer) clearInterval(this.permissionTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.readyTimer = null;
    this.pingTimer = null;
    this.permissionTimer = null;
    this.stableTimer = null;
    this.pendingPing = null;
    this.missedPongs = 0;
  }
}
