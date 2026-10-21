import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
  systemPreferences,
  type OpenDialogOptions,
} from 'electron';
import {
  ACTIONS,
  FORMAT_INFO,
  IMAGE_FORMATS,
  IPC_CHANNELS,
  OrbitError,
  isAllowedExternalUrl,
  type AppInfo,
  type FileSelection,
  type HelperConfigureMessage,
  type HelperDropMessage,
  type HelperStatus,
  type Point,
  type Settings,
  type ThemeName,
  type WindowContext,
  type WindowKind,
} from '@orbitdrop/contracts';
import { CapabilityService } from './capabilities/service';
import { EditorSessions } from './editor/sessions';
import { OutputRegistry } from './files/outputs';
import { FileRegistry, toProcessorInput } from './files/registry';
import { buildConfigureMessage, resolveHighContrast, resolveReduceMotion, resolveTheme } from './helper/configure';
import { locateHelper, type HelperLocation } from './helper/locate';
import { HELPER_REASON_DISABLED_FOR_RUN, localizeHelperStatus } from './helper/status-text';
import { HelperManager, type HelperChild } from './helper/manager';
import { HistoryStore } from './history/store';
import { bindTranslate, type Translate } from './i18n';
import { registerOrbitIpc, type OrbitIpcServices } from './ipc/channels';
import { IpcRouter, type IpcMainLike } from './ipc/router';
import { JobManager } from './jobs/manager';
import { SubmissionService, type SubmitContext } from './jobs/submission';
import type { LaunchOptions } from './launch-options';
import { closeLogSink, configureLogSink, createLogger, describeError, type Logger } from './log';
import { Notifier } from './notifications';
import { createUtilityWorkerFactory, workerEnv } from './processing/electron-worker';
import { ProcessorPool } from './processing/pool';
import { servePreviews } from './preview/protocol';
import { PreviewStore } from './preview/store';
import { hardenSession, installWebContentsHardening } from './security';
import { SettingsStore } from './settings/store';
import { TrayController } from './tray/controller';
import type { RecentItem, TrayState } from './tray/menu';
import { threadpoolSize } from './uv-threadpool';
import { WindowManager, type WindowRecord } from './windows/manager';

/**
 * Composition root of the main process. `startCore()` brings up settings,
 * history, the processor pool and capabilities (enough for the smoke test);
 * `startUi()` adds windows, IPC, the native helper and the tray.
 */

export interface AppPaths {
  readonly preload: string;
  readonly rendererFile: string;
  readonly rendererUrl: string | null;
  readonly processorHost: string;
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly userData: string;
}

const INPUT_EXTENSIONS = [...IMAGE_FORMATS.flatMap((f) => FORMAT_INFO[f].extensions), ...FORMAT_INFO.pdf.extensions].map((ext) => ext.slice(1));
const IMAGE_EXTENSIONS = IMAGE_FORMATS.flatMap((f) => FORMAT_INFO[f].extensions).map((ext) => ext.slice(1));

export class OrbitApp {
  readonly log: Logger = createLogger('app');
  readonly settings: SettingsStore;
  readonly history: HistoryStore;
  readonly files: FileRegistry;
  readonly outputs = new OutputRegistry();
  readonly previews = new PreviewStore();
  readonly pool: ProcessorPool;
  readonly capabilities: CapabilityService;
  readonly jobs: JobManager;
  readonly editors: EditorSessions;
  readonly submission: SubmissionService;
  readonly helper: HelperManager | null;
  readonly t: Translate;
  windows: WindowManager | null = null;
  tray: TrayController | null = null;
  readonly notifier: Notifier;
  private router: IpcRouter<WindowRecord> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private quitting = false;
  private helperLocation: HelperLocation | null = null;
  private helperLookup: Promise<HelperLocation | null> | null = null;
  private readonly liveNotifications = new Set<Notification>();
  /** E2E only: notifications that would have been shown. */
  readonly recordedNotifications: { readonly title: string; readonly body: string }[] = [];
  private markStarted: () => void = () => undefined;
  /** Resolves once startUi() finished (windows, IPC, tray, helper started). */
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  constructor(
    readonly options: LaunchOptions,
    readonly paths: AppPaths,
  ) {
    configureLogSink({ file: join(paths.userData, 'logs', 'main.log'), debug: options.debug });
    this.settings = new SettingsStore(paths.userData, createLogger('settings'));
    this.history = new HistoryStore(paths.userData, createLogger('history'));
    this.t = bindTranslate(() => this.settings.get().locale);

    const imageioHelper = process.platform === 'darwin' ? () => this.helperLocation?.path : () => undefined;
    this.pool = new ProcessorPool({
      fork: createUtilityWorkerFactory({
        hostPath: paths.processorHost,
        get env() {
          return workerEnv({ ORBITDROP_IMAGEIO_HELPER: imageioHelper(), ORBITDROP_PARENT_PID: String(process.pid) });
        },
      }),
      jobWorkers: 1,
      idleShutdownMs: 3 * 60_000,
      log: createLogger('pool'),
    });
    this.capabilities = new CapabilityService(() => this.pool.probe(), createLogger('capabilities'));
    // Validation holds pool threads: 2 at a time, plus up to (pool − 4) timed-out reads that may still be
    // blocked, so at least two threads always remain for settings/history/cleanup.
    this.files = new FileRegistry({
      snapshot: () => this.capabilities.current(),
      concurrency: 2,
      maxHungReads: Math.max(1, threadpoolSize() - 4),
    });
    this.notifier = new Notifier({
      show: (request) => this.showNotification(request.title, request.body, request.onClick),
      enabled: () => this.settings.get().notifications,
      locale: () => this.settings.get().locale,
      t: this.t,
      jobs: { batch: (batchId) => this.jobs.batch(batchId) },
      revealOutput: (outputId) => void this.revealOutput(outputId).catch(() => undefined),
      openJobs: () => this.windows?.open('jobs'),
      log: createLogger('notify'),
    });
    this.jobs = new JobManager({
      run: (job, ctx) => this.pool.run(job, ctx),
      settings: () => this.settings.get(),
      outputs: this.outputs,
      history: this.history,
      onChanged: (jobs) => {
        this.windows?.broadcast(IPC_CHANNELS.jobsChanged, jobs);
        this.tray?.refresh();
      },
      onSettled: (view) => this.notifier.onJobSettled(view),
      log: createLogger('jobs'),
    });
    this.editors = new EditorSessions({ pool: this.pool, store: this.previews, settings: () => this.settings.get(), log: createLogger('editor') });
    this.submission = new SubmissionService({
      files: this.files,
      capabilities: () => this.capabilities.get(),
      settings: () => this.settings.get(),
      jobs: this.jobs,
      editors: this.editors,
      chooseOutputDir: (request) => this.chooseOutputDir(request.windowId, request.reason),
      openEditor: (editorSession, context) => this.openEditorWindow(editorSession.editorId, context),
      log: createLogger('submit'),
    });
    this.helper = options.disableHelper
      ? null
      : new HelperManager({
          locate: () => this.locateHelperBinary(),
          spawn: (path) => this.spawnHelper(path),
          configure: () => this.helperConfigure(),
          enabled: () => this.settings.get().globalDrag.enabled,
          onDrop: (drop) => this.handleDrop(drop),
          onStatus: (status) => this.onHelperStatus(status),
          log: createLogger('helper'),
        });
  }

  // ------------------------------------------------------------------ startup

  /** Path of the native helper binary (also used by the workers for the macOS ImageIO codec mode). */
  private locateHelperBinary(): Promise<HelperLocation | null> {
    this.helperLookup ??= locateHelper({
      // Dev/test only: in a packaged build another same-user process could plant this variable and get its
      // binary launched with OrbitDrop's Accessibility / Input Monitoring grants.
      envPath: app.isPackaged ? undefined : process.env.ORBITDROP_HELPER_PATH,
      packaged: app.isPackaged,
      resourcesPath: this.paths.resourcesPath,
      appPath: this.paths.appPath,
      platform: process.platform,
      arch: process.arch,
    }).then((location) => {
      this.helperLocation = location;
      return location;
    });
    return this.helperLookup;
  }

  async startCore(): Promise<void> {
    const settings = await this.settings.load();
    await this.history.load();
    // Before the first worker is forked: workers get ORBITDROP_IMAGEIO_HELPER, so the engine
    // probe can see the helper's ImageIO codecs (HEIC on macOS).
    await this.locateHelperBinary();
    this.pool.setJobWorkers(settings.processing.concurrency);
    this.jobs.setConcurrency(settings.processing.concurrency);
    this.pool.start();
    // Re-probe once if the first probe failed because the aux worker crashed and came back.
    this.pool.onAuxReady(() => {
      if (this.capabilities.current() && !this.capabilities.lastProbeSucceeded) void this.capabilities.refresh();
    });
    void this.capabilities.refresh();
    this.sweepTimer = setInterval(() => this.previews.sweep(), 60_000);
    this.sweepTimer.unref?.();
    this.log.info('core started', { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch });
  }

  async startUi(): Promise<void> {
    hardenSession(session.defaultSession, createLogger('security'));
    servePreviews(this.previews, session.defaultSession);
    this.setupAppMenu();

    const windows = new WindowManager({
      preloadPath: this.paths.preload,
      rendererUrl: this.paths.rendererUrl,
      rendererFile: this.paths.rendererFile,
      theme: () => this.theme(),
      title: (context) => this.windowTitle(context),
      quiet: this.options.e2e,
      devTools: !app.isPackaged,
      onClosed: (record) => this.onWindowClosed(record),
      onOpened: (record) => {
        if (record.kind === 'dropzone') this.tray?.refresh();
      },
      log: createLogger('windows'),
    });
    this.windows = windows;
    installWebContentsHardening(app, (url) => windows.isTrustedUrl(url), createLogger('security'));

    this.router = new IpcRouter<WindowRecord>(ipcMain as unknown as IpcMainLike, { lookup: (sender) => windows.recordFor(sender as never), isTrustedUrl: (url) => windows.isTrustedUrl(url) }, createLogger('ipc'));
    registerOrbitIpc(this.router, this.ipcServices());

    this.settings.onChange((next, previous) => this.onSettingsChanged(next, previous));
    this.capabilities.onChange(() => this.helper?.reconfigure());
    nativeTheme.on('updated', () => this.helper?.reconfigure());

    if (!this.options.noTray) {
      this.tray = new TrayController({
        iconDirs: [join(this.paths.resourcesPath, 'tray'), join(this.paths.appPath, 'resources', 'tray')],
        platform: process.platform,
        state: () => this.trayState(),
        actions: {
          openFile: () => void this.openFileFromTray(),
          toggleDropZone: () => (windows.isOpen('dropzone') ? windows.close('dropzone') : windows.open('dropzone')),
          revealOutput: (outputId) => void this.revealOutput(outputId).catch(() => undefined),
          openJobs: () => windows.open('jobs'),
          setGlobalDrag: (enabled) => void this.settings.update({ globalDrag: { enabled } }).catch(() => undefined),
          openPermissions: () => this.openPermissionSettings(),
          restartHelper: () => void this.helper?.restart(),
          openSettings: () => windows.open('settings'),
          openAbout: () => windows.open('about'),
          quit: () => app.quit(),
        },
        t: this.t,
        log: createLogger('tray'),
      });
      this.tray.create();
    }

    this.applyLoginItem(this.settings.get().launchAtLogin);
    if (this.helper) void this.helper.start();
    this.log.info('ui started', { tray: this.tray !== null, helper: this.helper !== null });
    this.markStarted();
  }

  /** A second launch (e.g. opening the app again from Finder) shows the Drop Zone. */
  onSecondInstance(): void {
    this.windows?.open('dropzone');
  }

  // ------------------------------------------------------------------ shutdown

  /**
   * Quit sequence: stop taking work first (IPC, tray, helper drops), cancel
   * jobs, let the workers exit (their processors and the pool remove temp
   * files of interrupted jobs), then flush settings/history.
   */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      this.log.info('shutting down');
      this.quitting = true;
      if (this.sweepTimer) clearInterval(this.sweepTimer);
      this.router?.dispose();
      this.tray?.destroy();
      const helperStopped = this.helper?.stop();
      this.jobs.cancelAll();
      await Promise.allSettled([helperStopped, this.pool.shutdown(2500, 3000)]);
      await Promise.allSettled([this.settings.flush(), this.history.flush()]);
      closeLogSink();
    })();
    return this.shutdownPromise;
  }

  // ------------------------------------------------------------------ IPC services

  private ipcServices(): OrbitIpcServices<WindowRecord> {
    const windows = (): WindowManager => {
      if (!this.windows) throw new OrbitError('INTERNAL', 'UI not started');
      return this.windows;
    };
    return {
      windowContext: (record) => record.context,
      closeWindow: (record) => {
        if (!record.window.isDestroyed()) record.window.close();
      },
      resizeWindow: (record, width, height) => windows().resize(record, width, height),
      openWindow: (kind, record) => {
        windows().open(kind, windows().center(record));
      },
      appInfo: () => this.appInfo(),
      capabilities: () => this.capabilities.get(),
      settings: () => this.settings.get(),
      updateSettings: (patch) => this.settings.update(patch),
      helperStatus: () => this.publicHelperStatus(),
      openFileDialog: async (record) => {
        // A sheet on the tiny always-on-top Drop Zone / picker panel would be cramped: float the dialog instead.
        const parent = record.kind === 'dropzone' || record.kind === 'picker' ? null : record.window;
        const paths = await this.showOpenFiles(parent);
        return paths.length === 0 ? null : this.files.registerPaths(paths, 'openDialog');
      },
      registerDroppedPaths: (paths) => this.files.registerPaths(paths, 'dropZone'),
      selection: (selectionId) => {
        const selection = this.files.getSelection(selectionId);
        if (!selection) throw new OrbitError('INTERNAL', 'Unknown or expired selection');
        return selection;
      },
      menu: async (selectionId, mode) => {
        const selection = this.files.getSelection(selectionId);
        if (!selection) throw new OrbitError('INTERNAL', 'Unknown or expired selection');
        const usable = this.files.usableFiles(selectionId).length;
        return this.capabilities.menuFor(selection, usable, mode, this.settings.get().locale, this.t('menu.multiFileUnsupported'));
      },
      submit: (request, record) => {
        const source = this.files.getSelection(request.selectionId)?.source ?? 'openDialog';
        return this.submission.submit(request, { source, sessionId: null, windowId: record.windowId });
      },
      editor: (editorId) => this.editors.context(editorId),
      preview: (request) => this.editors.preview(request),
      inspect: (editorId) => this.editors.inspect(editorId),
      commit: (request, record) => {
        const editorSession = this.editors.get(request.editorId);
        return this.submission.commitEditor(request, {
          source: editorSession?.origin.source ?? 'openDialog',
          sessionId: editorSession?.origin.sessionId ?? null,
          windowId: record.windowId,
        });
      },
      cancelEditor: async (editorId) => {
        this.editors.dispose(editorId);
        this.windows?.closeEditor(editorId);
      },
      pickBackground: (editorId, record) => this.pickBackground(editorId, record.window),
      jobs: () => this.jobs.list(),
      cancelJob: async (jobId) => {
        this.jobs.cancel(jobId);
      },
      retryElsewhere: (jobId, record) => this.submission.retryElsewhere(jobId, { source: 'openDialog', sessionId: null, windowId: record.windowId }),
      revealOutput: (outputId) => this.revealOutput(outputId),
      openOutput: (outputId) => this.openOutput(outputId),
      openExternal: async (url) => {
        if (!isAllowedExternalUrl(url)) {
          this.log.warn('external URL refused');
          return false;
        }
        await shell.openExternal(url);
        return true;
      },
    };
  }

  appInfo(): AppInfo {
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
      arch: process.arch,
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      packaged: app.isPackaged,
      locale: this.settings.get().locale,
    };
  }

  helperStatus(): HelperStatus {
    if (!this.helper) return { state: 'unavailable', reason: HELPER_REASON_DISABLED_FOR_RUN };
    return this.helper.status;
  }

  /** The status as the renderer gets it: reasons are localized (developer text stays in the log). */
  publicHelperStatus(): HelperStatus {
    return localizeHelperStatus(this.helperStatus(), this.t);
  }

  // ------------------------------------------------------------------ flows

  /** Global drag: the helper accepted a drop (already on the next tick). */
  async handleDrop(drop: HelperDropMessage): Promise<void> {
    if (this.quitting) return;
    const anchor = screen.getCursorScreenPoint();
    let selection: FileSelection;
    try {
      selection = await this.files.registerPaths(drop.files, 'globalDrag');
    } catch (error) {
      const code = error instanceof OrbitError ? error.code : 'INTERNAL';
      this.log.warn('drop rejected', { sessionId: drop.sessionId, code });
      this.notifier.rejected(code);
      return;
    }
    const result = await this.submission.submit(
      { selectionId: selection.selectionId, actionId: drop.actionId },
      { source: 'globalDrag', sessionId: drop.sessionId, anchor },
    );
    if (result.kind === 'rejected') {
      this.log.warn('drop could not be submitted', { sessionId: drop.sessionId, code: result.error.code });
      this.notifier.rejected(result.error.code);
    } else {
      this.log.info('drop submitted', { sessionId: drop.sessionId, kind: result.kind });
    }
  }

  async openFileFromTray(): Promise<void> {
    const anchor = screen.getCursorScreenPoint();
    try {
      const paths = await this.showOpenFiles(null);
      if (paths.length === 0) return;
      const selection = await this.files.registerPaths(paths, 'openDialog');
      this.windows?.openPicker(selection.selectionId, 'convert', anchor);
    } catch (error) {
      this.log.error('open file failed', { error: describeError(error) });
    }
  }

  private openEditorWindow(editorId: string, context: SubmitContext): void {
    const windows = this.windows;
    if (!windows) return;
    const sender = context.windowId !== undefined ? windows.byWindowId(context.windowId) : undefined;
    const anchor = context.anchor ?? (sender ? windows.center(sender) : undefined);
    windows.openEditor(editorId, anchor, sender?.kind === 'picker' ? sender.windowId : undefined);
  }

  private onWindowClosed(record: WindowRecord): void {
    if (record.context.kind === 'editor') this.editors.dispose(record.context.editorId);
    if (record.kind === 'dropzone') this.tray?.refresh();
  }

  async revealOutput(outputId: string): Promise<void> {
    const output = this.outputs.get(outputId);
    if (!output) throw new OrbitError('FILE_NOT_FOUND', 'Unknown output');
    if (existsSync(output.path)) shell.showItemInFolder(output.path);
    else if (existsSync(dirname(output.path))) await shell.openPath(dirname(output.path));
    else throw new OrbitError('FILE_NOT_FOUND', 'The output no longer exists');
  }

  async openOutput(outputId: string): Promise<void> {
    const output = this.outputs.get(outputId);
    if (!output || !existsSync(output.path)) throw new OrbitError('FILE_NOT_FOUND', 'The output no longer exists');
    const error = await shell.openPath(output.path);
    if (error) throw new OrbitError('INTERNAL', 'No application could open the file');
  }

  private async pickBackground(editorId: string, parent: BrowserWindow): Promise<{ readonly fileId: string; readonly name: string } | null> {
    this.editors.require(editorId);
    const options: OpenDialogOptions = {
      title: this.t('dialog.background.title'),
      buttonLabel: this.t('dialog.background.button'),
      properties: ['openFile'],
      filters: [{ name: this.t('dialog.filter.images'), extensions: IMAGE_EXTENSIONS }],
    };
    const result = await dialog.showOpenDialog(parent, options);
    const path = result.canceled ? undefined : result.filePaths[0];
    if (!path) return null;
    const file = await this.files.registerFile(path);
    if (file.input.kind !== 'image') throw new OrbitError('UNSUPPORTED_FORMAT', 'Choose an image');
    this.editors.addAsset(editorId, toProcessorInput(file));
    return { fileId: file.fileId, name: file.selected.name };
  }

  private async showOpenFiles(parent: BrowserWindow | null): Promise<string[]> {
    const options: OpenDialogOptions = {
      title: this.t('dialog.openFiles.title'),
      buttonLabel: this.t('dialog.openFiles.button'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: this.t('dialog.filter.supported'), extensions: INPUT_EXTENSIONS },
        { name: this.t('dialog.filter.images'), extensions: IMAGE_EXTENSIONS },
        { name: this.t('dialog.filter.pdf'), extensions: ['pdf'] },
      ],
    };
    if (!parent && process.platform === 'darwin') app.focus({ steal: true });
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths.slice(0, 500);
  }

  private async chooseOutputDir(windowId: number | undefined, reason: 'ask' | 'retry'): Promise<string | null> {
    const parent = windowId !== undefined ? BrowserWindow.fromId(windowId) : null;
    const options: OpenDialogOptions = {
      title: this.t('dialog.outputDir.title'),
      buttonLabel: this.t('dialog.outputDir.button'),
      properties: ['openDirectory', 'createDirectory'],
      ...(reason === 'retry' ? { message: this.t('dialog.outputDir.retryMessage') } : {}),
    };
    if (!parent && process.platform === 'darwin') app.focus({ steal: true });
    const result = parent && !parent.isDestroyed() ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }

  private openPermissionSettings(): void {
    const status = this.helperStatus();
    let url = 'ms-settings:privacy';
    if (process.platform === 'darwin') {
      const pane = status.state === 'needsPermission' && status.permissions.includes('inputMonitoring') && !status.permissions.includes('accessibility') ? 'Privacy_ListenEvent' : 'Privacy_Accessibility';
      url = `x-apple.systempreferences:com.apple.preference.security?${pane}`;
    }
    if (isAllowedExternalUrl(url)) void shell.openExternal(url).catch(() => undefined);
  }

  // ------------------------------------------------------------------ helper

  private spawnHelper(path: string): HelperChild {
    return spawn(path, [], {
      cwd: dirname(path),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: { ...process.env, ORBITDROP_PARENT_PID: String(process.pid) },
    });
  }

  private helperConfigure(): HelperConfigureMessage | null {
    if (this.options.smokeTest) return null; // the smoke test only checks that the helper starts
    const snapshot = this.capabilities.current();
    if (!snapshot) return null;
    const settings = this.settings.get();
    const highContrast = resolveHighContrast(settings.accessibility.highContrast, nativeTheme.shouldUseHighContrastColors);
    const reduceMotion = resolveReduceMotion(settings.accessibility.reduceMotion, this.systemPrefersReducedMotion());
    return buildConfigureMessage({
      settings,
      snapshot,
      theme: resolveTheme(highContrast, nativeTheme.shouldUseDarkColors),
      reduceMotion,
      highContrast,
      strings: {
        dropHint: this.t('helper.dropHint'),
        unsupported: this.t('helper.unsupported'),
        multiFileUnsupported: this.t('helper.multiFileUnsupported'),
        fileCount: this.t('helper.fileCount'),
      },
    });
  }

  private systemPrefersReducedMotion(): boolean {
    try {
      return systemPreferences.getAnimationSettings().prefersReducedMotion;
    } catch {
      return false;
    }
  }

  private onHelperStatus(status: HelperStatus): void {
    this.windows?.broadcast(IPC_CHANNELS.helperStatusChanged, localizeHelperStatus(status, this.t));
    this.tray?.refresh();
  }

  // ------------------------------------------------------------------ settings & UI state

  private onSettingsChanged(next: Settings, previous: Settings): void {
    this.windows?.broadcast(IPC_CHANNELS.settingsChanged, next);
    if (next.processing.concurrency !== previous.processing.concurrency) {
      this.pool.setJobWorkers(next.processing.concurrency);
      this.jobs.setConcurrency(next.processing.concurrency);
    }
    if (
      next.locale !== previous.locale ||
      JSON.stringify(next.globalDrag) !== JSON.stringify(previous.globalDrag) ||
      JSON.stringify(next.accessibility) !== JSON.stringify(previous.accessibility)
    ) {
      this.helper?.reconfigure();
    }
    if (next.locale !== previous.locale || next.globalDrag.enabled !== previous.globalDrag.enabled) this.tray?.refresh();
    if (next.locale !== previous.locale) this.windows?.broadcast(IPC_CHANNELS.helperStatusChanged, this.publicHelperStatus());
    if (next.launchAtLogin !== previous.launchAtLogin) this.applyLoginItem(next.launchAtLogin);
  }

  private applyLoginItem(enabled: boolean): void {
    // Registering the development Electron binary as a login item would be wrong; only packaged builds do it.
    if (!app.isPackaged || this.options.e2e || this.options.smokeTest) return;
    try {
      if (app.getLoginItemSettings().openAtLogin !== enabled) app.setLoginItemSettings({ openAtLogin: enabled });
    } catch (error) {
      this.log.warn('could not update the login item', { error: describeError(error) });
    }
  }

  private trayState(): TrayState {
    const recent: RecentItem[] = this.jobs.recentWithOutputs(10).map((job) => ({
      jobId: job.jobId,
      outputId: job.outputs[0]!.outputId,
      name: job.outputs[0]!.name,
      moreCount: job.outputs.length - 1,
    }));
    return {
      helper: this.helperStatus(),
      globalDragEnabled: this.settings.get().globalDrag.enabled,
      dropZoneOpen: this.windows?.isOpen('dropzone') ?? false,
      recent,
      platform: process.platform,
    };
  }

  private theme(): ThemeName {
    const settings = this.settings.get();
    const highContrast = resolveHighContrast(settings.accessibility.highContrast, nativeTheme.shouldUseHighContrastColors);
    return resolveTheme(highContrast, nativeTheme.shouldUseDarkColors);
  }

  private windowTitle(context: WindowContext): string {
    const locale = this.settings.get().locale;
    if (context.kind === 'editor') {
      const editorSession = this.editors.get(context.editorId);
      return editorSession ? ACTIONS[editorSession.actionId].title[locale] : this.t('window.editor');
    }
    const keys: Record<Exclude<WindowKind, 'editor'>, Parameters<Translate>[0]> = {
      picker: 'window.picker',
      jobs: 'window.jobs',
      settings: 'window.settings',
      dropzone: 'window.dropzone',
      about: 'window.about',
    };
    return this.t(keys[context.kind]);
  }

  private setupAppMenu(): void {
    if (process.platform === 'darwin') {
      // Accessory app: the menu bar is not shown, but Edit/Window key equivalents (⌘C/⌘V/⌘W…) need a menu.
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    } else {
      Menu.setApplicationMenu(null);
    }
  }

  private showNotification(title: string, body: string, onClick: () => void): void {
    if (this.options.e2e) {
      // Automation: record instead of showing OS notifications on the tester's desktop.
      this.recordedNotifications.push({ title, body });
      return;
    }
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body, silent: false });
    this.liveNotifications.add(notification);
    const release = (): void => {
      this.liveNotifications.delete(notification);
    };
    notification.on('click', () => {
      release();
      onClick();
    });
    notification.on('close', release);
    notification.show();
    if (this.liveNotifications.size > 20) {
      const oldest = this.liveNotifications.values().next().value;
      if (oldest) this.liveNotifications.delete(oldest);
    }
  }
}
