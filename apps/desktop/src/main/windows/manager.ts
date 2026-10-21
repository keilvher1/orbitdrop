import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, screen, type WebContents } from 'electron';
import type { Point, WheelMode, WindowContext, WindowKind } from '@orbitdrop/contracts';
import { describeError, silentLogger, type Logger } from '../log';
import { WINDOW_MARGIN, placeCentered, rectCenter, resizeWithin } from './placement';
import { MAX_EDITOR_WINDOWS, WINDOW_SPECS } from './specs';

/**
 * BrowserWindow factory and registry. Every renderer window is sandboxed
 * (contextIsolation, sandbox, no nodeIntegration, webSecurity) and loads the
 * single renderer bundle; `getWindowContext()` tells it what to show. Main
 * maps each webContents to its WindowContext and IPC accepts only senders
 * that are registered here and whose main frame shows our renderer URL.
 */

export interface WindowRecord {
  readonly windowId: number;
  readonly webContentsId: number;
  readonly kind: WindowKind;
  readonly context: WindowContext;
  readonly window: BrowserWindow;
  readonly createdAt: number;
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
  readonly devTools: boolean;
  readonly onClosed?: (record: WindowRecord) => void;
  readonly onOpened?: (record: WindowRecord) => void;
  readonly log?: Logger;
}

export class WindowManager {
  private readonly records = new Map<number, WindowRecord>();
  private readonly log: Logger;

  constructor(private readonly deps: WindowManagerDeps) {
    this.log = deps.log ?? silentLogger;
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
    const editors = this.list('editor').sort((a, b) => a.createdAt - b.createdAt);
    while (editors.length >= MAX_EDITOR_WINDOWS) {
      const oldest = editors.shift();
      if (oldest) this.closeRecord(oldest);
    }
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
    };
    this.records.set(record.webContentsId, record);

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
      this.log.error('renderer process gone', { kind, reason: details.reason, exitCode: details.exitCode });
    });
    window.on('closed', () => {
      clearTimeout(fallback);
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
    if (window.isDestroyed()) return;
    if (this.deps.quiet || !focus) {
      if (!window.isVisible()) window.showInactive();
      return;
    }
    if (process.platform === 'darwin') app.focus({ steal: true });
    window.show();
    window.focus();
  }

  private closeRecord(record: WindowRecord): void {
    if (!record.window.isDestroyed()) record.window.close();
  }
}
