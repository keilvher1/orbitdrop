import { DEFAULT_SETTINGS, applySettingsPatch, type Settings, type UpdateState } from '@orbitdrop/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  CHECK_WATCHDOG_MS,
  DOWNLOAD_STALL_MS,
  FIRST_CHECK_DELAY_MS,
  RESTART_FALLBACK_MS,
  RESTART_IDLE_MS,
  UpdateService,
  type UpdaterDriver,
  type UpdaterEvents,
  type WorkInProgress,
} from '../../src/main/update/service';
import type { UpdateSupport } from '../../src/main/update/support';

/** electron-updater stand-in: every check waits until the test answers it. */
class FakeDriver implements UpdaterDriver {
  checks = 0;
  installs = 0;
  disposed = false;
  private answer: { resolve(): void; reject(error: unknown): void } | null = null;
  installError: Error | null = null;

  constructor(
    readonly events: UpdaterEvents,
    readonly shutdownBeforeInstall: boolean,
  ) {}

  check(): Promise<void> {
    this.checks += 1;
    this.events.checking();
    return new Promise<void>((resolve, reject) => {
      this.answer = { resolve, reject };
    });
  }

  quitAndInstall(): void {
    this.installs += 1;
    if (this.installError) throw this.installError;
  }

  /** Like the real driver: a given-up driver reports nothing any more. */
  dispose(): void {
    this.disposed = true;
  }

  /** The check found nothing newer. */
  upToDate(): void {
    if (!this.disposed) this.events.notAvailable();
    this.answer?.resolve();
  }

  /** The check found `version`; its download goes on after the check resolved. */
  found(version: string): void {
    if (!this.disposed) this.events.available(version);
    this.answer?.resolve();
  }

  /** electron-updater emits 'error' and rejects the check. */
  fail(error: unknown): void {
    if (!this.disposed) this.events.error(error);
    this.answer?.reject(error);
  }
}

interface Harness {
  service: UpdateService;
  drivers: FakeDriver[];
  driver(): FakeDriver;
  work: { -readonly [K in keyof WorkInProgress]: WorkInProgress[K] };
  states: UpdateState[];
  setAutoCheck(on: boolean): void;
  announceDownloaded: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  relaunch: ReturnType<typeof vi.fn>;
  createDriver: ReturnType<typeof vi.fn>;
}

function setup(options: { support?: UpdateSupport; autoCheck?: boolean; windowsDriver?: boolean; start?: boolean } = {}): Harness {
  let settings: Settings = applySettingsPatch(DEFAULT_SETTINGS, { updates: { autoCheck: options.autoCheck ?? true } })!;
  const listeners = new Set<(next: Settings, previous: Settings) => void>();
  const drivers: FakeDriver[] = [];
  const work = { jobs: 0, windows: 0, drag: false };
  const createDriver = vi.fn(async (events: UpdaterEvents) => {
    const driver = new FakeDriver(events, options.windowsDriver === true);
    drivers.push(driver);
    return driver;
  });
  const announceDownloaded = vi.fn();
  const shutdown = vi.fn(async () => undefined);
  const relaunch = vi.fn();
  const service = new UpdateService({
    support: options.support ?? { supported: true },
    currentVersion: '0.1.0',
    settings: {
      get: () => settings,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    createDriver,
    work: () => ({ ...work }),
    announceDownloaded,
    shutdown,
    relaunch,
  });
  const states: UpdateState[] = [];
  service.onChange((state) => states.push(state));
  if (options.start !== false) service.start();
  return {
    service,
    drivers,
    driver: () => {
      const driver = drivers.at(-1);
      if (!driver) throw new Error('no driver was created');
      return driver;
    },
    work,
    states,
    setAutoCheck(on) {
      const previous = settings;
      settings = applySettingsPatch(settings, { updates: { autoCheck: on } })!;
      for (const listener of listeners) listener(settings, previous);
    },
    announceDownloaded,
    shutdown,
    relaunch,
    createDriver,
  };
}

/** A harness whose first automatic check found `version` and downloaded it. */
async function downloaded(options: Parameters<typeof setup>[0] = {}, version = '0.2.0'): Promise<Harness> {
  const h = setup(options);
  await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
  h.driver().found(version);
  h.driver().events.progress(42.7);
  h.driver().events.downloaded(version);
  await vi.advanceTimersByTimeAsync(0);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 12, 9, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UpdateService gating', () => {
  it('an unsupported build reports why and never creates a driver or schedules a check', async () => {
    const h = setup({ support: { supported: false, reason: 'notSigned' } });
    expect(h.service.state()).toEqual({ state: 'unsupported', reason: 'notSigned', currentVersion: '0.1.0', autoCheck: true, lastCheckedAt: null });
    expect(await h.service.checkNow()).toMatchObject({ state: 'unsupported', reason: 'notSigned' });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    h.service.resumed();
    expect(h.service.requestRestart()).toMatchObject({ state: 'unsupported' });
    expect(h.createDriver).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('switching automatic checks still updates the state of an unsupported build', () => {
    const h = setup({ support: { supported: false, reason: 'development' } });
    h.setAutoCheck(false);
    expect(h.states.at(-1)).toMatchObject({ state: 'unsupported', autoCheck: false });
    expect(h.createDriver).not.toHaveBeenCalled();
  });
});

describe('UpdateService schedule', () => {
  it('checks 60 s after launch, then every 6 h', async () => {
    const h = setup();
    expect(h.service.state().state).toBe('idle');
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(h.createDriver).not.toHaveBeenCalled(); // electron-updater is not even loaded yet
    await vi.advanceTimersByTimeAsync(1);
    expect(h.driver().checks).toBe(1);
    expect(h.service.state().state).toBe('checking');
    h.driver().upToDate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.state()).toMatchObject({ state: 'upToDate', lastCheckedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(h.driver().checks).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.driver().checks).toBe(2);
    expect(h.drivers).toHaveLength(1); // one driver for the whole run
  });

  it('with automatic checks off nothing is scheduled; a manual check still works; switching on checks 60 s later', async () => {
    const h = setup({ autoCheck: false });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(h.createDriver).not.toHaveBeenCalled();
    expect(h.service.state()).toMatchObject({ state: 'idle', autoCheck: false });

    const manual = h.service.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    h.driver().upToDate();
    expect(await manual).toMatchObject({ state: 'upToDate' });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(h.driver().checks).toBe(1); // still off: no follow-up check

    h.setAutoCheck(true);
    expect(h.states.at(-1)).toMatchObject({ autoCheck: true });
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(h.driver().checks).toBe(2);
    h.driver().upToDate();
    await vi.advanceTimersByTimeAsync(0);

    h.setAutoCheck(false); // the next 6-hour check is dropped
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(h.driver().checks).toBe(2);
  });

  it('a manual check during a running check joins it; one right after a successful check answers from it', async () => {
    const h = setup();
    const first = h.service.checkNow();
    const second = h.service.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.driver().checks).toBe(1);
    h.driver().upToDate();
    await Promise.all([first, second]);
    await h.service.checkNow();
    expect(h.driver().checks).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    void h.service.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.driver().checks).toBe(2);
  });

  it('after waking from sleep, a check that is due runs 60 s later', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    h.driver().upToDate();
    await vi.advanceTimersByTimeAsync(0);
    h.service.resumed(); // not due yet
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(h.driver().checks).toBe(1);
    // Timers do not run while the computer sleeps: only the wall clock moves.
    vi.setSystemTime(Date.now() + CHECK_INTERVAL_MS + 1);
    h.service.resumed();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(h.driver().checks).toBe(2);
  });

  it('dispose stops the schedule', async () => {
    const h = setup();
    h.service.dispose();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(h.createDriver).not.toHaveBeenCalled();
  });
});

describe('UpdateService download', () => {
  it('available → downloading (whole percents) → downloaded: one notification, tray item, no further checks', async () => {
    const h = await downloaded();
    const kinds = h.states.map((s) => s.state);
    expect(kinds).toEqual(['checking', 'available', 'downloading', 'downloaded']);
    expect(h.states.find((s) => s.state === 'downloading')).toMatchObject({ version: '0.2.0', percent: 42 });
    expect(h.service.state()).toMatchObject({ state: 'downloaded', version: '0.2.0', restartPending: false });
    expect(h.announceDownloaded).toHaveBeenCalledTimes(1);
    expect(h.announceDownloaded).toHaveBeenCalledWith('0.2.0');
    expect(h.service.trayState()).toEqual({ ready: true, restartPending: false, version: '0.2.0' });

    h.driver().events.downloaded('0.2.0'); // reported again: still one notification
    expect(h.announceDownloaded).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    await h.service.checkNow();
    expect(h.driver().checks).toBe(1); // installed on quit: nothing more to look for
  });

  it('progress with the same whole percent is not broadcast again', async () => {
    const h = setup();
    void h.service.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    h.driver().found('0.2.0');
    for (const percent of [10.1, 10.6, 10.9, 11]) h.driver().events.progress(percent);
    expect(h.states.filter((s) => s.state === 'downloading').map((s) => (s.state === 'downloading' ? s.percent : -1))).toEqual([10, 11]);
  });

  it('a failed download is a quiet error state and the schedule goes on', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    h.driver().found('0.2.0');
    await vi.advanceTimersByTimeAsync(0);
    h.driver().events.error(new Error('net::ERR_CONNECTION_RESET'));
    expect(h.service.state()).toMatchObject({ state: 'error', error: 'network' });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(h.driver().checks).toBe(2);
  });
});

describe('UpdateService errors', () => {
  it('offline, network and other failures are states, never exceptions', async () => {
    const h = setup();
    for (const [error, kind] of [
      [new Error('net::ERR_INTERNET_DISCONNECTED'), 'offline'],
      [Object.assign(new Error('HttpError: 503 Service Unavailable'), { statusCode: 503 }), 'network'],
      [new Error('sha512 checksum mismatch'), 'failed'],
    ] as const) {
      await vi.advanceTimersByTimeAsync(10_000);
      const result = h.service.checkNow();
      await vi.advanceTimersByTimeAsync(0);
      h.driver().fail(error);
      await expect(result).resolves.toMatchObject({ state: 'error', error: kind, lastCheckedAt: Date.now() });
    }
  });

  it('no published release (or none for this OS yet) is "up to date", not an error', async () => {
    const h = setup();
    const result = h.service.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    h.driver().fail(Object.assign(new Error('Cannot find latest-mac.yml in the latest release artifacts'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }));
    await expect(result).resolves.toMatchObject({ state: 'upToDate' });
  });

  it('a check that never finishes is given up after 5 minutes: the request settles, the next check gets a new updater', async () => {
    const h = setup();
    let answered: UpdateState | null = null;
    void h.service.checkNow().then((state) => (answered = state));
    await vi.advanceTimersByTimeAsync(CHECK_WATCHDOG_MS - 1);
    expect(answered).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    // The About button gets its answer (an IPC call never hangs on a stalled request).
    expect(answered).toMatchObject({ state: 'error', error: 'network' });
    const stalled = h.driver();
    expect(stalled.disposed).toBe(true);

    const next = h.service.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.drivers).toHaveLength(2); // a stalled electron-updater keeps returning its pending check
    stalled.found('9.9.9'); // a late answer of the given-up instance is ignored
    expect(h.service.state().state).toBe('checking');
    h.driver().upToDate();
    await expect(next).resolves.toMatchObject({ state: 'upToDate' });
  });

  it('a download without progress for 10 minutes is given up; progress keeps it alive', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    h.driver().found('0.2.0');
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1000);
    h.driver().events.progress(10.2);
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1000);
    h.driver().events.progress(10.4); // the same whole percent still counts as progress
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1000);
    expect(h.service.state()).toMatchObject({ state: 'downloading', percent: 10 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.service.state()).toMatchObject({ state: 'error', error: 'network' });
    expect(h.drivers[0]!.disposed).toBe(true);
    // Manual checks work again, with a new updater.
    const retry = h.service.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.drivers).toHaveLength(2);
    h.driver().upToDate();
    await expect(retry).resolves.toMatchObject({ state: 'upToDate' });
  });

  it('electron-updater that cannot be loaded is an error; the next check tries again', async () => {
    const h = setup();
    h.createDriver.mockRejectedValueOnce(new Error('Cannot find module electron-updater'));
    await expect(h.service.checkNow()).resolves.toMatchObject({ state: 'error', error: 'failed' });
    const retry = h.service.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    h.driver().upToDate();
    await expect(retry).resolves.toMatchObject({ state: 'upToDate' });
    expect(h.createDriver).toHaveBeenCalledTimes(2);
  });

  it('an error after the download does not take the ready update away', async () => {
    const h = await downloaded();
    h.driver().events.error(new Error('net::ERR_NETWORK_CHANGED'));
    expect(h.service.state()).toMatchObject({ state: 'downloaded', version: '0.2.0' });
  });
});

describe('UpdateService restart', () => {
  it('nothing running: restarts at once (macOS: no shutdown first, the quit runs it)', async () => {
    const h = await downloaded();
    expect(h.service.requestRestart()).toMatchObject({ state: 'downloaded', restartPending: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.driver().installs).toBe(1);
    expect(h.shutdown).not.toHaveBeenCalled();
    expect(h.service.restartWaiting).toBe(false);
  });

  it('Windows: shuts OrbitDrop down before the installer takes over', async () => {
    const h = await downloaded({ windowsDriver: true });
    const order: string[] = [];
    h.shutdown.mockImplementation(async () => {
      order.push(`shutdown (installs: ${h.driver().installs})`);
    });
    h.service.requestRestart();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['shutdown (installs: 0)']);
    expect(h.driver().installs).toBe(1);
  });

  it('waits for running jobs, open editors and drags — no dialog — then restarts once all is done for 3 s', async () => {
    const h = await downloaded();
    h.work.jobs = 2;
    h.work.windows = 1;
    h.work.drag = true;
    h.service.requestRestart();
    expect(h.service.restartWaiting).toBe(true);
    expect(h.service.trayState()).toEqual({ ready: true, restartPending: true, version: '0.2.0' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.driver().installs).toBe(0);

    h.work.jobs = 0;
    h.work.windows = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.driver().installs).toBe(0); // the drag is still going on

    h.work.drag = false;
    await vi.advanceTimersByTimeAsync(RESTART_IDLE_MS - 1000);
    expect(h.driver().installs).toBe(0);
    h.work.jobs = 1; // something new started before the quiet period ended
    await vi.advanceTimersByTimeAsync(5000);
    h.work.jobs = 0;
    await vi.advanceTimersByTimeAsync(RESTART_IDLE_MS + 1000);
    expect(h.driver().installs).toBe(1);
  });

  it('a waiting restart can be cancelled; restart does nothing before an update is downloaded', async () => {
    const plain = setup();
    expect(plain.service.requestRestart()).toMatchObject({ state: 'idle' });

    const h = await downloaded();
    h.work.jobs = 1;
    h.service.requestRestart();
    h.service.cancelRestart();
    expect(h.service.state()).toMatchObject({ state: 'downloaded', restartPending: false });
    h.work.jobs = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.driver().installs).toBe(0);
  });

  it('when the work cannot be read, the restart keeps waiting', async () => {
    const h = await downloaded();
    Object.defineProperty(h.work, 'jobs', {
      get() {
        throw new Error('jobs unavailable');
      },
    });
    h.service.requestRestart();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.driver().installs).toBe(0);
  });

  it('macOS: an installer that does not take over leaves the app running with an error state', async () => {
    const h = await downloaded();
    h.service.requestRestart();
    await vi.advanceTimersByTimeAsync(RESTART_FALLBACK_MS);
    expect(h.service.state()).toMatchObject({ state: 'error', error: 'failed' });
    expect(h.relaunch).not.toHaveBeenCalled();

    const failing = await downloaded({}, '0.3.0');
    failing.driver().installError = new Error('Could not locate update bundle');
    failing.service.requestRestart();
    await vi.advanceTimersByTimeAsync(0);
    expect(failing.service.state()).toMatchObject({ state: 'error', error: 'failed' });
  });

  it('Windows: a failed handover after the shutdown starts this version again', async () => {
    const h = await downloaded({ windowsDriver: true });
    h.service.requestRestart();
    await vi.advanceTimersByTimeAsync(0);
    h.driver().events.error(new Error('spawn EACCES'));
    expect(h.relaunch).toHaveBeenCalledTimes(1);
  });
});
