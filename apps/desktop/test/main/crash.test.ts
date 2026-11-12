import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { HelperStatus, RendererErrorReport } from '@orbitdrop/contracts';
import { bindTranslate } from '../../src/main/i18n';
import type { LogData, Logger } from '../../src/main/log';
import {
  HelperCrashNotifier,
  RendererErrorLog,
  componentSummary,
  createMainErrorHandlers,
  installMainErrorHandlers,
  isBenignStdioError,
  stackSummary,
  startCrashReporter,
  type ProcessEventsLike,
} from '../../src/main/support/crash';
import { crashStep, windowNoticeFor } from '../../src/main/windows/crash';

interface Entry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data?: LogData;
}

function recordingLogger(): Logger & { readonly entries: Entry[] } {
  const entries: Entry[] = [];
  const at =
    (level: Entry['level']) =>
    (message: string, data?: LogData): void => {
      entries.push({ level, message, ...(data ? { data } : {}) });
    };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('crash dumps', () => {
  it('stay on this computer: the crash reporter never uploads', () => {
    const reporter = { start: vi.fn() };
    expect(startCrashReporter(reporter)).toBe(true);
    expect(reporter.start).toHaveBeenCalledWith(expect.objectContaining({ uploadToServer: false }));
    expect(reporter.start.mock.calls[0]![0]).not.toHaveProperty('submitURL');
  });

  it('a crash reporter that cannot start is logged, never fatal', () => {
    const log = recordingLogger();
    const reporter = {
      start: vi.fn(() => {
        throw new Error('no crashpad');
      }),
    };
    expect(startCrashReporter(reporter, log)).toBe(false);
    expect(log.entries[0]).toMatchObject({ level: 'warn', message: 'crash reporter not started' });
  });
});

describe('uncaught errors in main', () => {
  it('an uncaught exception is logged (stack redacted) and shows the dialog once; more while it is open are only logged', async () => {
    const log = recordingLogger();
    let close!: () => void;
    const showDialog = vi.fn(() => new Promise<void>((resolve) => (close = resolve)));
    let now = 1_000;
    const handlers = createMainErrorHandlers({ log, showDialog, now: () => now });
    const error = new TypeError('boom at /Users/someone/Desktop/x.png');
    error.stack = 'TypeError: boom\n    at handle (/Users/someone/app/out/main/index.js:10:5)\n    at run (node:internal/x:1:1)';
    handlers.uncaughtException(error, 'uncaughtException');
    handlers.uncaughtException(new Error('again'));
    expect(showDialog).toHaveBeenCalledTimes(1);
    expect(log.entries.filter((e) => e.message === 'uncaught exception in main')).toHaveLength(2);
    const first = log.entries[0]!;
    expect(first.level).toBe('error');
    expect(String(first.data?.error)).not.toContain('someone');
    expect(String(first.data?.stack)).toContain('at handle (<path>');
    expect(String(first.data?.stack)).not.toContain('someone');
    close();
    await flush();
    // Within a minute of the last dialog: logged only. After that: a dialog again.
    now += 30_000;
    handlers.uncaughtException(new Error('third'));
    expect(showDialog).toHaveBeenCalledTimes(1);
    now += 31_000;
    handlers.uncaughtException(new Error('fourth'));
    expect(showDialog).toHaveBeenCalledTimes(2);
  });

  it('a closed stdout/stderr (EPIPE) is not worth a dialog', () => {
    const log = recordingLogger();
    const showDialog = vi.fn(async () => undefined);
    const handlers = createMainErrorHandlers({ log, showDialog });
    handlers.uncaughtException(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(showDialog).not.toHaveBeenCalled();
    expect(log.entries[0]).toMatchObject({ level: 'warn' });
    expect(isBenignStdioError({ code: 'EIO' })).toBe(true);
    expect(isBenignStdioError(new Error('x'))).toBe(false);
  });

  it('unhandled rejections are logged only; the smoke test (no dialog) logs uncaught exceptions only', () => {
    const log = recordingLogger();
    const handlers = createMainErrorHandlers({ log, showDialog: null });
    handlers.unhandledRejection(new Error('rejected'));
    handlers.unhandledRejection('a string reason');
    handlers.uncaughtException(new Error('boom'));
    expect(log.entries.map((e) => e.message)).toEqual(['unhandled promise rejection in main', 'unhandled promise rejection in main', 'uncaught exception in main']);
  });

  it('a dialog that fails to show is logged, and the next exception may try again', async () => {
    const log = recordingLogger();
    const showDialog = vi.fn(async () => {
      throw new Error('no display');
    });
    let now = 0;
    const handlers = createMainErrorHandlers({ log, showDialog, now: () => now, dialogIntervalMs: 10 });
    handlers.uncaughtException(new Error('a'));
    await flush();
    expect(log.entries.some((e) => e.message === 'could not show the error dialog')).toBe(true);
    now += 20;
    handlers.uncaughtException(new Error('b'));
    expect(showDialog).toHaveBeenCalledTimes(2);
  });

  it('installs on the process emitter (which replaces Electron\'s own dialog)', () => {
    const proc = new EventEmitter();
    const log = recordingLogger();
    installMainErrorHandlers(proc as unknown as ProcessEventsLike, { log, showDialog: null });
    proc.emit('uncaughtException', new Error('x'), 'uncaughtException');
    proc.emit('unhandledRejection', new Error('y'));
    expect(log.entries.map((e) => e.message)).toEqual(['uncaught exception in main', 'unhandled promise rejection in main']);
  });

  it('stack summaries keep frames, drop paths and stay short', () => {
    expect(stackSummary(undefined)).toBeUndefined();
    const stack = ['Error: x', ...Array.from({ length: 20 }, (_, i) => `    at f${i} (C:\\Users\\me\\app\\x.js:${i}:1)`)].join('\n');
    const summary = stackSummary(stack)!;
    expect(summary.split(' | ')).toHaveLength(4);
    expect(summary).not.toContain('me\\app');
  });
});

describe('renderer error reports', () => {
  const report = (overrides: Partial<RendererErrorReport> = {}): RendererErrorReport => ({
    source: 'boundary',
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'x') in /Users/someone/Pictures/secret.png",
    stack: 'TypeError: boom\n    at Wheel (file:///Applications/OrbitDrop.app/Contents/Resources/app.asar/out/renderer/assets/index-abc.js:1:2345)',
    componentStack: '\n    at Wheel (file:///x.js:1:1)\n    at PickerView (file:///x.js:2:2)\n    at ErrorBoundary',
    ...overrides,
  });

  it('are logged with the window kind, redacted and short', () => {
    const log = recordingLogger();
    expect(new RendererErrorLog(log).report({ kind: 'picker', windowId: 3 }, report())).toBe(true);
    const entry = log.entries[0]!;
    expect(entry).toMatchObject({ level: 'error', message: 'renderer view crashed', data: { kind: 'picker', source: 'boundary', components: 'Wheel < PickerView < ErrorBoundary' } });
    expect(String(entry.data?.error)).toMatch(/^TypeError: Cannot read properties/);
    expect(String(entry.data?.error)).not.toContain('someone');
    expect(String(entry.data?.stack)).toContain('at Wheel (<path>');
    expect(String(entry.data?.error).length).toBeLessThanOrEqual(300);
  });

  it('a view that keeps failing cannot flood main.log (per window and minute)', () => {
    const log = recordingLogger();
    let now = 0;
    const errors = new RendererErrorLog(log, () => now, 3, 60_000);
    const results = Array.from({ length: 5 }, () => errors.report({ kind: 'editor', windowId: 1 }, report()));
    expect(results).toEqual([true, true, true, false, false]);
    expect(errors.report({ kind: 'jobs', windowId: 2 }, report())).toBe(true); // other windows are counted on their own
    now += 61_000;
    expect(errors.report({ kind: 'editor', windowId: 1 }, report())).toBe(true);
  });

  it('component names only from the component stack', () => {
    expect(componentSummary('\n    in Foo\n    in Bar (created by Baz)')).toBe('Foo < Bar');
    expect(componentSummary(undefined)).toBeUndefined();
    expect(componentSummary('no components here')).toBeUndefined();
  });
});

describe('drag helper gave up', () => {
  const t = bindTranslate(() => 'ko');
  const crashed: HelperStatus = { state: 'crashed', restarts: 5, reason: 'x' };
  const running: HelperStatus = { state: 'running', helperVersion: '1', globalDrag: true };

  it('one notification per episode; its click restarts the helper', () => {
    const notify = vi.fn();
    const restart = vi.fn();
    const notifier = new HelperCrashNotifier({ notify, enabled: () => true, restart, t });
    notifier.onStatus({ state: 'starting' });
    notifier.onStatus(crashed);
    notifier.onStatus(crashed);
    notifier.onStatus({ state: 'starting' });
    notifier.onStatus(crashed); // a restart that failed again: still the same episode
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe('전역 드래그가 멈췄습니다');
    expect(notify.mock.calls[0]![1]).toContain('이 알림을 누르면 다시 시작합니다');
    (notify.mock.calls[0]![2] as () => void)();
    expect(restart).toHaveBeenCalledTimes(1);
    notifier.onStatus(running); // ran again: a later crash is a new episode
    notifier.onStatus(crashed);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('notifications switched off: nothing is shown (the tray and Settings › Drag still offer the restart)', () => {
    const notify = vi.fn();
    const notifier = new HelperCrashNotifier({ notify, enabled: () => false, restart: vi.fn(), t });
    notifier.onStatus(crashed);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('a crashed window page', () => {
  it('is reloaded with a notice, then shows only the crash screen, then is closed', () => {
    expect([1, 2, 3, 4].map(crashStep)).toEqual(['reload', 'reloadFailed', 'close', 'close']);
    expect(windowNoticeFor({ count: 0, unsavedLost: false })).toBeNull();
    expect(windowNoticeFor({ count: 1, unsavedLost: true })).toEqual({ kind: 'recovered', unsavedLost: true });
    expect(windowNoticeFor({ count: 2, unsavedLost: false })).toEqual({ kind: 'failed', unsavedLost: false });
  });
});
