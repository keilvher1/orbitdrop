import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, screen, type WebContents } from 'electron';
import { IPC_CHANNELS, type Point, type WheelMode, type WindowContext, type WindowKind, type WindowNotice } from '@orbitdrop/contracts';
import { describeError, silentLogger, type Logger } from '../log';
import { crashStep, windowNoticeFor, type WindowCrashState } from './crash';
import { WINDOW_MARGIN, placeCentered, rectCenter, resizeWithin } from './placement';
import { WINDOW_SPECS, editorsToEvict } from './specs';

/**
 * BrowserWindow factory and registry. Every renderer window is sandboxed
 * (contextIsolation, sandbox, no nodeIntegration, webSecurity) and loads the
 * single renderer bundle; `getWindowContext()` tells it what to show. Main
 * maps each webContents to its WindowContext and IPC accepts only senders
 * that are registered here and whose main frame shows our renderer URL.
 *
 * Close guard: a window with unsaved work (Annotate shapes, Redact regions —
 * the renderer reports it with setCloseGuard) is not closed by an OS-level
 * close (close button, ⌘W, Alt+F4): the close is held back and the renderer
 * asks the user with the same dialog as its own × / Esc. Closes the window
 * itself or main asked for are not held back, nor is anything once the app
 * quits, the session ends, or the renderer died or hangs.
 *
 * A crashed page (render-process-gone) is logged and reloaded with a notice
 * the page asks for (getWindowNotice): first the view comes back and says
 * what happened, after a second crash only a crash screen is shown, a third
 * closes the window (onPageCrashClosed tells the user) — see windows/crash.ts.
 */

/** Per-window close guard state (mutable; see the class comment). */
export interface CloseGuardState {
  /** The renderer reported unsaved work. */
  unsaved: boolean;
  /** A close the window or main asked for is under way: not held back. */
  approved: boolean;
  /** Electron reported the renderer hung: it could not ask, so closes pass. */
  unresponsive: boolean;
  /**
   * A held-back close was not acknowledged within CLOSE_ACK_MS (a hung renderer: Electron's own
   * unresponsive timer only runs for closes that are not held back), so the next close passes.
   */
  noAck: boolean;
  /** Pending acknowledgement timer of a held-back close. */
  ackTimer: ReturnType<typeof setTimeout> | null;
}

/** How long a renderer has to acknowledge a held-back close (setCloseGuard) before it counts as hung. */
export const CLOSE_ACK_MS = 5000;

export interface WindowRecord {
  readonly windowId: number;
  readonly webContentsId: number;
  readonly kind: WindowKind;
  readonly context: WindowContext;
  readonly window: BrowserWindow;
  readonly createdAt: number;
  readonly guard: CloseGuardState;
  /** Crashes of this window's page (mutable; see windows/crash.ts). */
  readonly crash: WindowCrashState;
}

export interface WindowManagerDeps {
  readonly preloadPath: string;
  /** Dev server URL (electron-vite dev), or null to load the built file. */
  readonly rendererUrl: string | null;
  readonly rendererFile: string;
  /** Window background until the renderer paints (the windowBg of the theme it will use). */
  readonly background: () => string;
  readonly title: (context: WindowContext) => string;
  /** E2E/automation: show windows without taking focus. */
  readonly quiet: boolean;
  /** Smoke test: windows are created and loaded but never shown (nothing on screen, no focus). */
  readonly hidden?: boolean;
  readonly devTools: boolean;
  readonly onClosed?: (record: WindowRecord) => void;
  readonly onOpened?: (record: WindowRecord) => void;
  /** The window was closed because its page kept crashing (the user is told by main). */
  readonly onPageCrashClosed?: (record: WindowRecord) => void;
  readonly log?: Logger;
}

export class WindowManager {
  private readonly records = new Map<number, WindowRecord>();
  private readonly log: Logger;
  /** Quitting, or the OS session ends: no close is held back any more. */
  private ending = false;

  constructor(private readonly deps: WindowManagerDeps) {
    this.log = deps.log ?? silentLogger;
  }

  /** The app is quitting: let every close through (unsaved-work guards included). */
  setQuitting(): void {
    this.ending = true;
  }

  /** setCloseGuard from a window's renderer (also its acknowledgement of a held-back close). */
  setCloseGuard(record: WindowRecord, unsaved: boolean): void {
    const { guard } = record;
    guard.unsaved = unsaved;
    guard.noAck = false;
    if (guard.ackTimer) clearTimeout(guard.ackTimer);
    guard.ackTimer = null;
  }

  /** The window asked to close itself (closeWindow): never held back. */
  closeWindow(record: WindowRecord): void {
    this.closeRecord(record);
  }

  /**
   * Open (or focus) a single-instance window. `inactive`: show it without
   * taking focus (e.g. a job started by a global drag needs attention while
   * the user works in another app); an already visible window is left as is.
   */
  open(kind: Exclude<WindowKind, 'picker' | 'editor'>, anchor?: Point, options: { readonly inactive?: boolean } = {}): BrowserWindow {
    const focus = WINDOW_SPECS[kind].focus && options.inactive !== true;
    const existing = this.find(kind);
    if (existing) {
      this.reveal(existing.window, focus);
      return existing.window;
    }
    return this.create({ kind } as WindowContext, anchor, focus);
  }

  openPicker(selectionId: string, initialMode: WheelMode, anchor?: Point): BrowserWindow {
    for (const record of this.list('picker')) this.closeRecord(record);
    return this.create({ kind: 'picker', selectionId, initialMode }, anchor);
  }

  /** Open an editor; `replace` (a picker window id) is closed once the editor is visible. */
  openEditor(editorId: string, anchor?: Point, replace?: number): BrowserWindow {
    // Beyond the limit the oldest editors go — except ones with unsaved work (then the limit is exceeded).
    for (const record of editorsToEvict(this.list('editor'))) this.closeRecord(record);
    const window = this.create({ kind: 'editor', editorId }, anchor);
    if (replace !== undefined) {
      const closeReplaced = (): void => {
        const record = this.byWindowId(replace);
        if (record && record.kind === 'picker') this.closeRecord(record);
      };
      window.once('show', closeReplaced);
      window.once('closed', closeReplaced);
    }
    return window;
  }

  close(kind: WindowKind): void {
    for (const record of this.list(kind)) this.closeRecord(record);
  }

  closeEditor(editorId: string): void {
    for (const record of this.list('editor')) {
      if (record.context.kind === 'editor' && record.context.editorId === editorId) this.closeRecord(record);
    }
  }

  closeAll(): void {
    for (const record of [...this.records.values()]) this.closeRecord(record);
  }

  isOpen(kind: WindowKind): boolean {
    return this.find(kind) !== undefined;
  }

  find(kind: WindowKind): WindowRecord | undefined {
    return this.list(kind)[0];
  }

  list(kind?: WindowKind): WindowRecord[] {
    return [...this.records.values()].filter((record) => !record.window.isDestroyed() && (kind === undefined || record.kind === kind));
  }

  byWindowId(windowId: number): WindowRecord | undefined {
    return this.list().find((record) => record.windowId === windowId);
  }

  /** The registered window of an IPC sender, if it is one of ours showing our renderer. */
  recordFor(sender: WebContents): WindowRecord | undefined {
    const record = this.records.get(sender.id);
    if (!record || record.window.isDestroyed() || record.window.webContents !== sender) return undefined;
    return record;
  }

  isTrustedUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (this.deps.rendererUrl) return parsed.origin === new URL(this.deps.rendererUrl).origin;
      if (parsed.protocol !== 'file:') return false;
      const path = fileURLToPath(parsed);
      // Windows paths are case-insensitive (drive letters may differ in case).
      return process.platform === 'win32' ? path.toLowerCase() === this.deps.rendererFile.toLowerCase() : path === this.deps.rendererFile;
    } catch {
      return false;
    }
  }

  broadcast(channel: string, payload: unknown): void {
    for (const record of this.list()) {
      try {
        if (!record.window.webContents.isDestroyed()) record.window.webContents.send(channel, payload);
      } catch (error) {
        this.log.debug('broadcast failed', { channel, error: describeError(error) });
      }
    }
  }

  /** Renderer resize request: clamp to the window minimum and the work area of its display. */
  resize(record: WindowRecord, width: number, height: number): void {
    const window = record.window;
    if (window.isDestroyed()) return;
    const spec = WINDOW_SPECS[record.kind];
    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const next = resizeWithin(bounds, { width, height }, display.workArea, { width: spec.minWidth, height: spec.minHeight });
    window.setBounds(next, false);
  }

  center(record: WindowRecord): Point {
    return rectCenter(record.window.getBounds());
  }

  /** getWindowNotice: why this window's page was reloaded (it had crashed), or null. */
  notice(record: WindowRecord): WindowNotice | null {
    return windowNoticeFor(record.crash);
  }

  private create(context: WindowContext, anchor?: Point, focus = WINDOW_SPECS[context.kind].focus): BrowserWindow {
    const kind = context.kind;
    const spec = WINDOW_SPECS[kind];
    const point = anchor ?? screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const bounds = placeCentered(point, spec, display.workArea, WINDOW_MARGIN);
    const window = new BrowserWindow({
      ...bounds,
      minWidth: Math.min(spec.minWidth, bounds.width),
      minHeight: Math.min(spec.minHeight, bounds.height),
      show: false,
      frame: false,
      resizable: spec.resizable,
      maximizable: false,
      fullscreenable: false,
      minimizable: kind !== 'picker' && kind !== 'dropzone',
      skipTaskbar: spec.skipTaskbar,
      alwaysOnTop: spec.alwaysOnTop,
      title: this.deps.title(context),
      backgroundColor: this.deps.background(),
      hasShadow: true,
      autoHideMenuBar: true,
      acceptFirstMouse: spec.acceptFirstMouse,
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        safeDialogs: true,
        devTools: this.deps.devTools,
      },
    });
    if (spec.alwaysOnTop) window.setAlwaysOnTop(true, 'floating');
    const record: WindowRecord = {
      windowId: window.id,
      webContentsId: window.webContents.id,
      kind,
      context,
      window,
      createdAt: Date.now(),
      guard: { unsaved: false, approved: false, unresponsive: false, noAck: false, ackTimer: null },
      crash: { count: 0, unsavedLost: false },
    };
    this.records.set(record.webContentsId, record);
    window.on('close', (event) => this.onCloseAttempt(record, event));
    window.on('unresponsive', () => {
      record.guard.unresponsive = true;
    });
    window.on('responsive', () => {
      record.guard.unresponsive = false;
    });
    // Windows log-off / shutdown: never hold the session up. ('query-session-end' can still be cancelled by
    // another app; 'session-end' is final.)
    window.on('session-end', () => {
      this.ending = true;
    });
    // A reload starts a fresh page that has nothing unsaved yet.
    window.webContents.on('did-navigate', () => {
      record.guard.unsaved = false;
    });

    let shown = false;
    const show = (): void => {
      if (shown || window.isDestroyed()) return;
      shown = true;
      this.reveal(window, focus);
    };
    window.once('ready-to-show', show);
    const fallback = setTimeout(show, 4000); // never leave a window invisible if ready-to-show does not come
    fallback.unref?.();
    window.webContents.on('render-process-gone', (_event, details) => {
      // Whatever was unsaved went with the renderer; the dead window must stay closable.
      const unsaved = record.guard.unsaved;
      record.guard.unsaved = false;
      this.log.error('renderer process gone', { kind, reason: details.reason, exitCode: details.exitCode, unsaved });
      if (details.reason === 'clean-exit' || this.ending || window.isDestroyed()) return;
      // A frameless window with a dead page has no close button: load it again (main still has its context —
      // an editor comes back without its unsaved shapes) and the page says what happened (getWindowNotice).
      record.crash.count += 1;
      record.crash.unsavedLost ||= unsaved;
      if (crashStep(record.crash.count) !== 'close') {
        window.webContents.reload();
        return;
      }
      this.closeRecord(record);
      try {
        this.deps.onPageCrashClosed?.(record);
      } catch (error) {
        this.log.error('crash close handler failed', { kind, error: describeError(error) });
      }
    });
    window.on('closed', () => {
      clearTimeout(fallback);
      if (record.guard.ackTimer) clearTimeout(record.guard.ackTimer);
      this.records.delete(record.webContentsId);
      try {
        this.deps.onClosed?.(record);
      } catch (error) {
        this.log.error('window close handler failed', { kind, error: describeError(error) });
      }
    });

    const load = this.deps.rendererUrl ? window.loadURL(this.deps.rendererUrl) : window.loadFile(this.deps.rendererFile);
    load.catch((error: unknown) => this.log.error('renderer failed to load', { kind, error: describeError(error) }));
    this.log.debug('window created', { kind, windowId: window.id });
    this.deps.onOpened?.(record);
    return window;
  }

  private reveal(window: BrowserWindow, focus: boolean): void {
    if (window.isDestroyed() || this.deps.hidden === true) return;
    if (this.deps.quiet || !focus) {
      if (!window.isVisible()) window.showInactive();
      return;
    }
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.show();
    window.focus();
  }

  /**
   * 'close' of one of our windows. Held back only when the renderer reported
   * unsaved work and nobody approved this close (OS close button, ⌘W,
   * Alt+F4…): the window is brought forward and its renderer asks the user —
   * keep editing, or close without saving (which then closes through
   * cancelEditor / closeWindow, approved). Repeated closes while it asks just
   * ask again; the renderer shows one dialog. The renderer acknowledges each
   * request with setCloseGuard; one that does not within CLOSE_ACK_MS is hung,
   * and the next close goes through.
   */
  private onCloseAttempt(record: WindowRecord, event: { preventDefault(): void }): void {
    const { guard, window } = record;
    if (!guard.unsaved || guard.approved || this.ending || guard.unresponsive || guard.noAck) return;
    const contents = window.webContents;
    if (contents.isDestroyed() || contents.isCrashed()) return;
    event.preventDefault();
    this.log.info('close held back: unsaved work', { kind: record.kind, windowId: record.windowId });
    this.reveal(window, true);
    try {
      contents.send(IPC_CHANNELS.windowCloseRequested);
    } catch (error) {
      this.log.warn('could not ask the window about its unsaved work', { error: describeError(error) });
    }
    guard.ackTimer ??= setTimeout(() => {
      guard.ackTimer = null;
      guard.noAck = true;
      this.log.warn('window did not answer a close request; the next close goes through', { kind: record.kind, windowId: record.windowId });
    }, CLOSE_ACK_MS);
    guard.ackTimer.unref?.();
  }

  /** A close the window itself or main decided on: never held back by the close guard. */
  private closeRecord(record: WindowRecord): void {
    if (record.window.isDestroyed()) return;
    record.guard.approved = true;
    record.window.close();
  }
}
