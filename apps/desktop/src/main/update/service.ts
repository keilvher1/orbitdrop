import type { Settings, UpdatePhase, UpdateState } from '@orbitdrop/contracts';
import { describeError, silentLogger, type Logger } from '../log';
import { classifyUpdateError } from './errors';
import type { UpdateSupport } from './support';

/**
 * Automatic updates (electron-updater, GitHub Releases of keilvher1/orbitdrop).
 *
 *   unsupported                          (decided at startup: never a request, see support.ts)
 *   idle → checking → upToDate | error   (error: quiet — About + log, never a dialog)
 *                   → available → downloading → downloaded (→ restartPending → restart)
 *
 * Checks: 60 s after launch and every 6 h while settings.updates.autoCheck is on (after waking
 * from sleep, as soon as one is due), and whenever the user asks (About, tray). A found update is
 * downloaded at once and installed when the app quits; "restart to update" installs it now.
 *
 * Restarting never loses work and never asks with a dialog: while jobs are queued or running, an
 * editor or the format picker is open, or a drag (the wheel) is in progress, the restart waits
 * (`restartPending`, shown in About and the tray, cancellable from the tray) and happens once all
 * of that has been over for RESTART_IDLE_MS. Asked while nothing runs, it restarts at once.
 */

export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/**
 * A check that has not finished after this long is given up (shown as a network problem). Electron's
 * `net` requests that electron-updater makes have no timeout of their own, so a stalled connection
 * would otherwise hang the check forever; the stalled updater instance is dropped and the next
 * check starts with a new one.
 */
export const CHECK_WATCHDOG_MS = 5 * 60_000;
/** A download without any progress for this long is given up the same way. */
export const DOWNLOAD_STALL_MS = 10 * 60_000;
/** A manual check this soon after a successful one answers from the last result. */
export const MANUAL_CHECK_MIN_INTERVAL_MS = 10_000;
export const RESTART_POLL_MS = 1000;
/** A waiting restart happens once nothing has been running for this long. */
export const RESTART_IDLE_MS = 3000;
/** Still running this long after handing over to the installer: the handover failed. */
export const RESTART_FALLBACK_MS = 30_000;

/** What electron-updater reports (driver.ts maps its events to these). */
export interface UpdaterEvents {
  checking(): void;
  available(version: string): void;
  notAvailable(): void;
  /** 0–100. */
  progress(percent: number): void;
  /** The update is downloaded, verified and ready to install (macOS: Squirrel.Mac accepted it). */
  downloaded(version: string): void;
  error(error: unknown): void;
}

export interface UpdaterDriver {
  /** Look for an update; resolves when the check is done. A download it starts goes on and reports through the events. */
  check(): Promise<void>;
  /** Install the downloaded update: the app quits and the new version starts. */
  quitAndInstall(): void;
  /** Windows: the NSIS installer stops a still-running app about a second after it starts, so OrbitDrop shuts down first. */
  readonly shutdownBeforeInstall: boolean;
  /** Given up (stalled): stop reporting events; the service creates a new driver for the next check. */
  dispose?(): void;
}

export type UpdaterDriverFactory = (events: UpdaterEvents) => Promise<UpdaterDriver>;

/** What a restart right now would interrupt. */
export interface WorkInProgress {
  /** Jobs queued or running, and files handed over that are still being validated or submitted (no job yet). */
  readonly jobs: number;
  /** Open editor and format-picker windows. */
  readonly windows: number;
  /** A drag session of the native helper is open (the wheel may be on screen). */
  readonly drag: boolean;
}

export interface UpdateServiceDeps {
  readonly support: UpdateSupport;
  readonly currentVersion: string;
  readonly settings: {
    get(): Settings;
    onChange(listener: (next: Settings, previous: Settings) => void): () => void;
  };
  /** Called at the first check only (electron-updater is never loaded by a build that cannot update). */
  readonly createDriver: UpdaterDriverFactory;
  readonly work: () => WorkInProgress;
  /** Once per downloaded version: the system notification (the app decides whether notifications are on). */
  readonly announceDownloaded: (version: string) => void;
  /** The app's orderly shutdown (Windows, before the installer takes over). */
  readonly shutdown: () => Promise<void>;
  /** After a failed handover on Windows (the app is already shut down): start this version again. */
  readonly relaunch: () => void;
  readonly now?: () => number;
  readonly log?: Logger;
}

export interface TrayUpdate {
  /** A downloaded update can be installed by restarting. */
  readonly ready: boolean;
  /** The restart waits for running work. */
  readonly restartPending: boolean;
  readonly version: string | null;
}

type Timer = ReturnType<typeof setTimeout>;

export class UpdateService {
  private phase: UpdatePhase;
  private lastCheckedAt: number | null = null;
  private lastCheckStartedAt: number | null = null;
  private startedAt: number;
  private driverPromise: Promise<UpdaterDriver> | null = null;
  private inFlight: Promise<void> | null = null;
  private checkToken: symbol | null = null;
  private checkTimer: Timer | null = null;
  private watchdog: Timer | null = null;
  private stallTimer: Timer | null = null;
  private restartPoll: ReturnType<typeof setInterval> | null = null;
  private restartFallback: Timer | null = null;
  private idleSince: number | null = null;
  private restarting = false;
  private shutDown = false;
  private started = false;
  private disposed = false;
  private readonly announced = new Set<string>();
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private unsubscribeSettings: (() => void) | null = null;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? silentLogger;
    this.startedAt = this.now();
    this.phase = deps.support.supported ? { state: 'idle' } : { state: 'unsupported', reason: deps.support.reason };
  }

  // ------------------------------------------------------------------ public

  state(): UpdateState {
    return { ...this.phase, currentVersion: this.deps.currentVersion, autoCheck: this.autoCheck, lastCheckedAt: this.lastCheckedAt };
  }

  onChange(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Begin the automatic schedule (the app's UI is up). */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.startedAt = this.now();
    this.unsubscribeSettings = this.deps.settings.onChange((next, previous) => this.settingsChanged(next, previous));
    if (!this.deps.support.supported) {
      this.log.info('automatic updates are not available for this build', { reason: this.deps.support.reason });
      return;
    }
    if (this.autoCheck) this.schedule(FIRST_CHECK_DELAY_MS);
  }

  /** A check the user asked for (About, tray). Resolves once the check itself is done. */
  async checkNow(): Promise<UpdateState> {
    if (this.phase.state === 'upToDate' && this.lastCheckedAt !== null && this.now() - this.lastCheckedAt < MANUAL_CHECK_MIN_INTERVAL_MS) return this.state();
    await this.runCheck('manual');
    return this.state();
  }

  /** "Restart to update": now when nothing runs, otherwise once it is over (no dialog). */
  requestRestart(): UpdateState {
    if (this.phase.state !== 'downloaded' || this.restarting || this.disposed) return this.state();
    if (!this.phase.restartPending) {
      this.log.info('restart to update requested', { version: this.phase.version });
      this.setPhase({ ...this.phase, restartPending: true });
    }
    this.idleSince = null;
    this.evaluateRestart(true);
    return this.state();
  }

  /** Tray: the user changed their mind about a waiting restart. */
  cancelRestart(): void {
    if (this.phase.state !== 'downloaded' || !this.phase.restartPending || this.restarting) return;
    this.stopRestartPoll();
    this.log.info('waiting restart cancelled');
    this.setPhase({ ...this.phase, restartPending: false });
  }

  /** The computer woke up: timers did not run during sleep, so check now (after the usual delay) if one is due. */
  resumed(): void {
    if (!this.canCheckAutomatically() || this.inFlight) return;
    const last = this.lastCheckStartedAt ?? this.startedAt;
    if (this.now() - last >= CHECK_INTERVAL_MS) this.schedule(FIRST_CHECK_DELAY_MS);
  }

  /** A requested restart is waiting for running work (not yet handing over to the installer). */
  get restartWaiting(): boolean {
    return this.phase.state === 'downloaded' && this.phase.restartPending && !this.restarting;
  }

  trayState(): TrayUpdate {
    const phase = this.phase;
    return phase.state === 'downloaded'
      ? { ready: true, restartPending: phase.restartPending, version: phase.version }
      : { ready: false, restartPending: false, version: null };
  }

  /** App shutdown: no further checks. A restart that is under way keeps its handover. */
  dispose(): void {
    this.disposed = true;
    this.clearCheckTimer();
    this.clearWatchdog();
    this.clearStallTimer();
    this.stopRestartPoll();
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
  }

  // ------------------------------------------------------------------ checks

  private get autoCheck(): boolean {
    return this.deps.settings.get().updates.autoCheck;
  }

  private canCheckAutomatically(): boolean {
    if (!this.deps.support.supported || !this.started || this.disposed || this.restarting || !this.autoCheck) return false;
    const state = this.phase.state;
    return state !== 'downloaded' && state !== 'available' && state !== 'downloading';
  }

  private runCheck(origin: 'auto' | 'manual'): Promise<void> {
    if (!this.deps.support.supported || this.disposed || this.restarting) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const state = this.phase.state;
    // Ready to install on quit: nothing to look for. A download under way reports by itself.
    if (state === 'downloaded') return Promise.resolve();
    if (state === 'available' || state === 'downloading') {
      if (origin === 'auto') this.scheduleNext();
      return Promise.resolve();
    }
    this.clearCheckTimer();
    this.lastCheckStartedAt = this.now();
    this.setPhase({ state: 'checking' });
    this.log.info('checking for an update', { origin });
    const token = Symbol('check');
    this.checkToken = token;
    // Settles when the check ends or when the watchdog gives up on it (a stalled request never ends).
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.inFlight = done;
    this.performCheck(token).then(settle, settle);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.checkToken !== token) return;
      this.checkToken = null;
      this.inFlight = null;
      this.log.warn('update check did not finish; given up');
      this.abandonDriver();
      this.lastCheckedAt = this.now();
      this.setPhase({ state: 'error', error: 'network' });
      this.scheduleNext();
      settle();
    }, CHECK_WATCHDOG_MS);
    this.watchdog.unref?.();
    return done;
  }

  private async performCheck(token: symbol): Promise<void> {
    try {
      const driver = await this.driver();
      await driver.check();
    } catch (error) {
      // Usually reported as an 'error' event already; this catches failures that are not (driver creation).
      if (this.checkToken === token && this.phase.state === 'checking') this.failed(error);
    } finally {
      if (this.checkToken === token) {
        this.checkToken = null;
        this.inFlight = null;
        this.clearWatchdog();
        // The driver finished without saying anything (it should not): nothing new.
        if (this.phase.state === 'checking') this.noUpdate();
        this.scheduleNext();
      }
    }
  }

  /**
   * Drop the current driver (a stalled electron-updater instance keeps returning its pending check
   * and could report it much later): it stops reporting, and the next check creates a new one.
   */
  private abandonDriver(): void {
    const abandoned = this.driverPromise;
    this.driverPromise = null;
    abandoned?.then(
      (driver) => driver.dispose?.(),
      () => undefined,
    );
  }

  private driver(): Promise<UpdaterDriver> {
    if (!this.driverPromise) {
      // Always asynchronous, so a check's bookkeeping is in place before anything can fail.
      const creating = Promise.resolve().then(() => this.deps.createDriver(this.events));
      this.driverPromise = creating;
      // A driver that could not be created is tried again at the next check.
      creating.catch(() => {
        if (this.driverPromise === creating) this.driverPromise = null;
      });
    }
    return this.driverPromise;
  }

  private readonly events: UpdaterEvents = {
    checking: () => {
      if (this.phase.state !== 'checking' && !this.busyWithUpdate()) this.setPhase({ state: 'checking' });
    },
    available: (version) => {
      this.lastCheckedAt = this.now();
      this.log.info('update available', { version });
      this.setPhase({ state: 'available', version });
      this.armStallTimer();
    },
    notAvailable: () => {
      this.noUpdate();
    },
    progress: (percent) => {
      const phase = this.phase;
      if (phase.state !== 'available' && phase.state !== 'downloading') return;
      this.armStallTimer(); // any progress counts, also within the same whole percent
      const rounded = Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.floor(percent))) : 0;
      if (phase.state === 'downloading' && phase.percent === rounded) return;
      this.setPhase({ state: 'downloading', version: phase.version, percent: rounded });
    },
    downloaded: (version) => {
      if (this.phase.state === 'downloaded' && this.phase.version === version) return;
      this.log.info('update downloaded; installed when OrbitDrop quits', { version });
      this.clearCheckTimer();
      this.clearStallTimer();
      this.setPhase({ state: 'downloaded', version, restartPending: false });
      if (!this.announced.has(version)) {
        this.announced.add(version);
        try {
          this.deps.announceDownloaded(version);
        } catch (error) {
          this.log.warn('could not announce the update', { error: describeError(error) });
        }
      }
    },
    error: (error) => {
      this.failed(error);
    },
  };

  private busyWithUpdate(): boolean {
    const state = this.phase.state;
    return state === 'available' || state === 'downloading' || state === 'downloaded';
  }

  private noUpdate(): void {
    this.lastCheckedAt = this.now();
    this.setPhase({ state: 'upToDate' });
  }

  private failed(error: unknown): void {
    if (this.restarting) {
      this.restartFailed(error);
      return;
    }
    if (this.phase.state === 'downloaded') {
      // The update is ready (its installer is on disk); a later, unrelated error does not take that away.
      this.log.warn('updater error after the download', { error: describeError(error) });
      return;
    }
    const kind = classifyUpdateError(error);
    this.clearStallTimer();
    this.lastCheckedAt = this.now();
    if (kind === 'noRelease') {
      this.log.info('no release to update to', { detail: describeError(error) });
      this.setPhase({ state: 'upToDate' });
      this.scheduleNext();
      return;
    }
    this.log.warn('update check or download failed', { kind, error: describeError(error) });
    this.setPhase({ state: 'error', error: kind });
    // A failed download happens after its check finished: keep the schedule going.
    this.scheduleNext();
  }

  private armStallTimer(): void {
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      const state = this.phase.state;
      if (state !== 'available' && state !== 'downloading') return;
      this.log.warn('update download stalled; given up');
      this.abandonDriver();
      this.lastCheckedAt = this.now();
      this.setPhase({ state: 'error', error: 'network' });
      this.scheduleNext();
    }, DOWNLOAD_STALL_MS);
    this.stallTimer.unref?.();
  }

  private clearStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  /** The next automatic check, CHECK_INTERVAL_MS from now — unless one is running or already planned. */
  private scheduleNext(): void {
    if (this.canCheckAutomatically() && !this.inFlight && !this.checkTimer) this.schedule(CHECK_INTERVAL_MS);
  }

  private schedule(delayMs: number): void {
    this.clearCheckTimer();
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      void this.runCheck('auto');
    }, delayMs);
    this.checkTimer.unref?.();
  }

  private settingsChanged(next: Settings, previous: Settings): void {
    if (next.updates.autoCheck === previous.updates.autoCheck) return;
    this.log.info('automatic update checks switched', { on: next.updates.autoCheck });
    if (!next.updates.autoCheck) this.clearCheckTimer();
    else if (this.canCheckAutomatically() && !this.inFlight) this.schedule(FIRST_CHECK_DELAY_MS);
    this.emit();
  }

  // ------------------------------------------------------------------ restart

  private evaluateRestart(requestedNow: boolean): void {
    if (this.restarting || this.disposed || this.phase.state !== 'downloaded' || !this.phase.restartPending) {
      this.stopRestartPoll();
      return;
    }
    const idle = this.isIdle();
    if (idle && requestedNow) {
      void this.beginRestart();
      return;
    }
    if (idle) {
      this.idleSince ??= this.now();
      if (this.now() - this.idleSince >= RESTART_IDLE_MS) {
        void this.beginRestart();
        return;
      }
    } else {
      this.idleSince = null;
    }
    if (!this.restartPoll) {
      this.restartPoll = setInterval(() => this.evaluateRestart(false), RESTART_POLL_MS);
      this.restartPoll.unref?.();
    }
  }

  private isIdle(): boolean {
    try {
      const work = this.deps.work();
      return work.jobs === 0 && work.windows === 0 && !work.drag;
    } catch (error) {
      this.log.warn('could not tell whether work is running; the restart waits', { error: describeError(error) });
      return false;
    }
  }

  private async beginRestart(): Promise<void> {
    if (this.restarting || this.phase.state !== 'downloaded') return;
    this.restarting = true;
    this.stopRestartPoll();
    this.clearCheckTimer();
    this.log.info('restarting to install the update', { version: this.phase.version });
    try {
      const driver = await this.driver();
      if (driver.shutdownBeforeInstall) {
        this.shutDown = true;
        await this.deps.shutdown();
      }
      driver.quitAndInstall();
    } catch (error) {
      this.restartFailed(error);
      return;
    }
    if (!this.restarting) return; // the handover already failed (reported synchronously)
    this.restartFallback = setTimeout(() => this.restartFailed(new Error('the installer did not take over')), RESTART_FALLBACK_MS);
    this.restartFallback.unref?.();
  }

  private restartFailed(error: unknown): void {
    if (!this.restarting) return;
    this.restarting = false;
    if (this.restartFallback) clearTimeout(this.restartFallback);
    this.restartFallback = null;
    this.log.error('the update could not be installed', { error: describeError(error) });
    if (this.shutDown) {
      // Windows: OrbitDrop already shut down for the installer — start this version again.
      try {
        this.deps.relaunch();
      } catch (relaunchError) {
        this.log.error('could not start OrbitDrop again', { error: describeError(relaunchError) });
      }
      return;
    }
    this.lastCheckedAt = this.now();
    this.setPhase({ state: 'error', error: 'failed' });
  }

  // ------------------------------------------------------------------ plumbing

  private setPhase(next: UpdatePhase): void {
    this.phase = next;
    this.emit();
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        this.log.warn('update state listener failed', { error: describeError(error) });
      }
    }
  }

  private clearCheckTimer(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private stopRestartPoll(): void {
    if (this.restartPoll) clearInterval(this.restartPoll);
    this.restartPoll = null;
    this.idleSince = null;
  }
}
