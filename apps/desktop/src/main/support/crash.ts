import type { HelperStatus, RendererErrorReport, WindowKind } from '@orbitdrop/contracts';
import type { Translate } from '../i18n';
import { describeError, redactPaths, silentLogger, type Logger } from '../log';

/**
 * Crash handling in main, kept free of runtime Electron imports (tests):
 *  - crash dumps stay on this computer (crashReporter, uploadToServer false);
 *  - uncaught exceptions and unhandled rejections are logged; an uncaught
 *    exception also shows a translated dialog (keep using / open the log
 *    folder / quit) — at most one at a time, at most one a minute;
 *  - errors a window's view reports (ErrorBoundary) reach main.log —
 *    redacted, size-capped and rate-limited per window;
 *  - the drag helper giving up ('crashed') is announced once, with a click
 *    that restarts it.
 */

export interface CrashReporterLike {
  start(options: { readonly uploadToServer: boolean; readonly compress?: boolean }): void;
}

/** Local crash dumps only (Electron's crashDumps folder, inside the app data folder). Nothing is uploaded. */
export function startCrashReporter(reporter: CrashReporterLike, log: Logger = silentLogger): boolean {
  try {
    reporter.start({ uploadToServer: false, compress: true });
    return true;
  } catch (error) {
    log.warn('crash reporter not started', { error: describeError(error) });
    return false;
  }
}

/** The first frames of a stack, path-redacted, on one line (the logger caps it further). */
export function stackSummary(stack: string | undefined, frames = 4): string | undefined {
  if (typeof stack !== 'string' || stack.trim() === '') return undefined;
  const lines = stack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') || line.includes('@'))
    .slice(0, frames);
  return lines.length > 0 ? redactPaths(lines.join(' | ')).slice(0, 600) : undefined;
}

/** A closed stdout/stderr (EPIPE, EIO: the terminal that started us went away) is not worth a dialog. */
export function isBenignStdioError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'EPIPE' || code === 'EIO';
}

/** `process` (its listeners have event-specific parameters). */
export interface ProcessEventsLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface MainErrorHandlerDeps {
  readonly log: Logger;
  /** Shows the translated dialog; resolves when it is closed. Null: log only (smoke test, before a UI exists). */
  readonly showDialog: (() => Promise<void>) | null;
  readonly now?: () => number;
  /** Minimum time between two dialogs. */
  readonly dialogIntervalMs?: number;
}

export interface MainErrorHandlers {
  uncaughtException(error: unknown, origin?: string): void;
  unhandledRejection(reason: unknown): void;
}

export function createMainErrorHandlers(deps: MainErrorHandlerDeps): MainErrorHandlers {
  const now = deps.now ?? Date.now;
  const interval = deps.dialogIntervalMs ?? 60_000;
  let dialogOpen = false;
  let lastDialogAt = Number.NEGATIVE_INFINITY;
  return {
    uncaughtException(error, origin) {
      const benign = isBenignStdioError(error);
      const data = { origin, error: describeError(error), stack: stackSummary(error instanceof Error ? error.stack : undefined) };
      if (benign) {
        deps.log.warn('uncaught stdio error in main (ignored)', data);
        return;
      }
      deps.log.error('uncaught exception in main', data);
      if (deps.showDialog === null || dialogOpen || now() - lastDialogAt < interval) return;
      dialogOpen = true;
      lastDialogAt = now();
      let shown: Promise<void>;
      try {
        shown = deps.showDialog();
      } catch (dialogError) {
        shown = Promise.reject(dialogError);
      }
      void shown
        .catch((dialogError: unknown) => deps.log.warn('could not show the error dialog', { error: describeError(dialogError) }))
        .finally(() => {
          dialogOpen = false;
        });
    },
    unhandledRejection(reason) {
      deps.log.error('unhandled promise rejection in main', {
        error: describeError(reason),
        stack: stackSummary(reason instanceof Error ? reason.stack : undefined),
      });
    },
  };
}

/** Wires the handlers to `process`. Registering them replaces Electron's own uncaught-exception dialog. */
export function installMainErrorHandlers(proc: ProcessEventsLike, deps: MainErrorHandlerDeps): MainErrorHandlers {
  const handlers = createMainErrorHandlers(deps);
  proc.on('uncaughtException', (error: unknown, origin?: string) => handlers.uncaughtException(error, origin));
  proc.on('unhandledRejection', (reason: unknown) => handlers.unhandledRejection(reason));
  return handlers;
}

// ------------------------------------------------------------------ renderer errors

/**
 * reportRendererError: one log line per crashed view, path-redacted and
 * shortened (the logger also caps every value at 300 characters); at most
 * `limit` per window and minute, so a view that keeps failing cannot flood
 * main.log.
 */
export class RendererErrorLog {
  private readonly recent = new Map<number, number[]>();

  constructor(
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    private readonly limit = 5,
    private readonly windowMs = 60_000,
  ) {}

  /** Returns whether the report was logged (false: over the limit). */
  report(source: { readonly kind: WindowKind; readonly windowId: number }, report: RendererErrorReport): boolean {
    const now = this.now();
    const times = (this.recent.get(source.windowId) ?? []).filter((time) => now - time < this.windowMs);
    if (times.length >= this.limit) {
      this.recent.set(source.windowId, times);
      return false;
    }
    times.push(now);
    this.recent.set(source.windowId, times);
    if (this.recent.size > 64) {
      for (const [windowId, list] of this.recent) if (list.every((time) => now - time >= this.windowMs)) this.recent.delete(windowId);
    }
    const name = (report.name ?? 'Error').replace(/[^\w.$-]/g, '').slice(0, 60) || 'Error';
    this.log.error('renderer view crashed', {
      kind: source.kind,
      source: report.source,
      error: redactPaths(`${name}: ${report.message}`).replace(/\s+/g, ' ').slice(0, 300),
      stack: stackSummary(report.stack),
      components: componentSummary(report.componentStack),
    });
    return true;
  }
}

/** React's component stack ("at Wheel (…)", "in Wheel") as a short list of component names. */
export function componentSummary(componentStack: string | undefined, max = 6): string | undefined {
  if (typeof componentStack !== 'string') return undefined;
  const names = componentStack
    .split(/\r?\n/)
    .map((line) => /^\s*(?:at|in)\s+([A-Za-z_$][\w$.]*)/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
    .slice(0, max);
  return names.length > 0 ? names.join(' < ') : undefined;
}

// ------------------------------------------------------------------ drag helper gave up

export interface HelperCrashNotifierDeps {
  /** Shows a system notification (or records it in automation). */
  readonly notify: (title: string, body: string, onClick: () => void) => void;
  /** settings.notifications */
  readonly enabled: () => boolean;
  readonly restart: () => void;
  readonly t: Translate;
  readonly log?: Logger;
}

/**
 * The helper gave up after repeated crashes ('crashed'): one notification per
 * episode — clicking it restarts the helper (the tray and Settings › Drag
 * offer the same). A new episode starts once the helper ran again.
 */
export class HelperCrashNotifier {
  private announced = false;

  constructor(private readonly deps: HelperCrashNotifierDeps) {}

  onStatus(status: HelperStatus): void {
    if (status.state === 'running') {
      this.announced = false;
      return;
    }
    if (status.state !== 'crashed' || this.announced) return;
    this.announced = true;
    if (!this.deps.enabled()) return;
    this.deps.log?.info('announcing that the drag helper stopped');
    this.deps.notify(this.deps.t('crash.helper.title'), this.deps.t('crash.helper.body'), () => this.deps.restart());
  }
}
