import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  clipboard,
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
  DESIGN_TOKENS,
  FORMAT_INFO,
  IMAGE_FORMATS,
  IPC_CHANNELS,
  OrbitError,
  TERMINAL_JOB_STATES,
  isAllowedExternalUrl,
  type AppInfo,
  type BuildSummary,
  type FileSelection,
  type HelperConfigureMessage,
  type HelperDropMessage,
  type HelperStatus,
  type Point,
  type ProcessorJob,
  type ProcessorResult,
  type Settings,
  type StartupNotice,
  type WindowContext,
  type WindowKind,
  colorTokens,
} from '@orbitdrop/contracts';
import { appMenuTemplate } from './app-menu';
import { CapabilityService } from './capabilities/service';
import { EditorSessions } from './editor/sessions';
import { OutputRegistry, isOpenableOutput } from './files/outputs';
import { FileRegistry, MAX_SELECTION_FILES, toProcessorInput } from './files/registry';
import { buildConfigureMessage, resolveHighContrast, resolveReduceMotion, resolveTheme } from './helper/configure';
import { locateHelper, type HelperLocation } from './helper/locate';
import { HELPER_REASON_DISABLED_FOR_RUN, localizeHelperStatus } from './helper/status-text';
import { HelperManager, type HelperChild } from './helper/manager';
import { HistoryStore } from './history/store';
import { bindTranslate, type Translate } from './i18n';
import { registerOrbitIpc, type OrbitIpcServices } from './ipc/channels';
import { IpcRouter, type IpcMainLike } from './ipc/router';
import { registerSupportIpc, type SupportIpcServices } from './ipc/support';
import { JobManager, type JobRecordView } from './jobs/manager';
import { SubmissionService, type SubmitContext } from './jobs/submission';
import type { LaunchOptions } from './launch-options';
import { ReopenFilter, type LifecycleTarget, type PowerTarget } from './lifecycle';
import { closeLogSink, configureLogSink, createLogger, describeError, type Logger } from './log';
import { applyLoginItem, loginItemToAdopt, type LoginItems } from './login-item';
import { Notifier, needsAnotherFolder } from './notifications';
import { runOnboarding, type MoveToApplications } from './onboarding';
import { createUtilityWorkerFactory, workerEnv } from './processing/electron-worker';
import { ProcessorPool, type PoolRunContext } from './processing/pool';
import { servePreviews } from './preview/protocol';
import { PreviewStore } from './preview/store';
import { hardenSession, installWebContentsHardening, isRendererExternalUrl } from './security';
import { SettingsStore } from './settings/store';
import { SupportController } from './support/controller';
import { HelperCrashNotifier, RendererErrorLog } from './support/crash';
import { trayTooltip } from './support/keys';
import { TrayController } from './tray/controller';
import type { RecentItem, TrayState } from './tray/menu';
import type { UpdateService } from './update/service';
import { createAppUpdates } from './update/wiring';
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

/** The x64 macOS build running under Rosetta 2 on Apple silicon (an arm64 build exists for that Mac). */
function runningTranslated(): boolean {
  return process.platform === 'darwin' && app.runningUnderARM64Translation === true;
}

/** The OS's preferred languages, most preferred first (a first run takes the UI language from them). */
function systemLanguages(): string[] {
  const languages = app.getPreferredSystemLanguages();
  return languages.length > 0 ? languages : [app.getLocale()];
}

function homeFolder(): string | null {
  try {
    return homedir();
  } catch {
    return null;
  }
}

/**
 * E2E only (ORBITDROP_E2E=1, unpackaged builds — see test-hooks.ts): decides
 * what happens before a job attempt reaches the processor pool, so tests can
 * produce retryable failures and long-running jobs deterministically.
 */
export interface JobRunScript {
  /** Called once per attempt; may reject (scripted failure) or wait (scripted hold, ends on abort). */
  beforeRun(signal: AbortSignal): Promise<void>;
}

export class OrbitApp implements LifecycleTarget, PowerTarget {
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
  /** Help menu, diagnostics, data folder, licence files. */
  readonly support: SupportController;
  /** The drag helper gave up: one notification per episode, a click restarts it. */
  private readonly helperCrash: HelperCrashNotifier;
  /** Views that crashed (ErrorBoundary) → main.log, rate-limited. */
  private readonly rendererErrors = new RendererErrorLog(createLogger('renderer'));
  /** Automatic updates (update/service.ts); unsupported builds never touch the network. */
  readonly updates: UpdateService;
  /** What the package was built from (Resources/build-info.json); null in development runs. */
  private readonly build: BuildSummary | null;
  /** Files handed over (drop, Drop Zone, Open File, the OS) still being validated or submitted: no job yet. */
  private intake = 0;
  private router: IpcRouter<WindowRecord> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Windows: re-reads the OS animation setting (no change event exists). */
  private motionTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private quitting = false;
  private helperLocation: HelperLocation | null = null;
  private helperLookup: Promise<HelperLocation | null> | null = null;
  private readonly liveNotifications = new Set<Notification>();
  /** E2E only: notifications that would have been shown. */
  readonly recordedNotifications: { readonly title: string; readonly body: string }[] = [];
  /** E2E only (set by installTestHooks): scripts job attempts (injected failures, holds); null otherwise. */
  testJobScript: JobRunScript | null = null;
  /** Drops (session/batch ids) whose "needs another folder" failure already opened the Jobs window. */
  private readonly surfacedFailures = new Set<string>();
  /** macOS workspace notification id (accessibility display options), unsubscribed on quit. */
  private accessibilityNotification: number | null = null;
  /** Problems handled at startup that the user is told about (notification + Settings). */
  readonly startupNotices: StartupNotice[] = [];
  /** macOS follows a notification click with a reopen: that one must not open the Drop Zone. */
  private readonly reopenFilter = new ReopenFilter(() => void this.showDropZone());
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
    // First run: the UI language follows the OS (automation keeps Korean, the app default, for stable tests).
    this.settings = new SettingsStore(paths.userData, createLogger('settings'), process.platform, {
      systemLanguages: options.e2e || options.smokeTest ? () => [] : systemLanguages,
    });
    this.history = new HistoryStore(paths.userData, createLogger('history'));
    this.t = bindTranslate(() => this.settings.get().locale);

    const imageioHelper = process.platform === 'darwin' ? () => this.helperLocation?.path : () => undefined;
    this.pool = new ProcessorPool({
      fork: createUtilityWorkerFactory({
        hostPath: paths.processorHost,
        get env() {
          return workerEnv({ ORBITDROP_IMAGEIO_HELPER: imageioHelper(), ORBITDROP_PARENT_PID: String(process.pid) }, app.isPackaged);
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
      run: (job, ctx) => this.runJob(job, ctx),
      settings: () => this.settings.get(),
      outputs: this.outputs,
      history: this.history,
      onChanged: (jobs) => {
        this.windows?.broadcast(IPC_CHANNELS.jobsChanged, jobs);
        this.tray?.refresh();
      },
      onSettled: (view) => {
        this.notifier.onJobSettled(view);
        this.surfaceDragFailure(view);
      },
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
          onDrop: (drop) => this.tracked(() => this.handleDrop(drop)),
          onStatus: (status) => this.onHelperStatus(status),
          log: createLogger('helper'),
        });
    this.support = new SupportController({
      platform: process.platform,
      arch: process.arch,
      translated: runningTranslated(),
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      versions: { electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '', node: process.versions.node },
      osVersion: () => process.getSystemVersion(),
      homeDir: homeFolder(),
      paths: { userData: paths.userData, logFile: join(paths.userData, 'logs', 'main.log'), resourcesPath: paths.resourcesPath, appPath: paths.appPath },
      locale: () => this.settings.get().locale,
      t: this.t,
      helperStatus: () => this.helperStatus(),
      capabilities: () => this.capabilities.current(),
      shell: { openExternal: (url) => shell.openExternal(url), openPath: (path) => shell.openPath(path), showItemInFolder: (path) => shell.showItemInFolder(path) },
      writeClipboard: (text) => clipboard.writeText(text),
      exists: (path) => existsSync(path),
      ensureDir: (path) => mkdirSync(path, { recursive: true }),
      log: createLogger('support'),
    });
    this.helperCrash = new HelperCrashNotifier({
      notify: (title, body, onClick) => this.showNotification(title, body, onClick),
      enabled: () => this.settings.get().notifications,
      restart: () => void this.helper?.restart().catch((error: unknown) => this.log.warn('helper restart failed', { error: describeError(error) })),
      t: this.t,
      log: createLogger('helper'),
    });
    const updates = createAppUpdates({
      smokeTest: options.smokeTest,
      resourcesPath: paths.resourcesPath,
      settings: this.settings,
      work: () => ({
        jobs: this.jobs.list().filter((job) => !TERMINAL_JOB_STATES.has(job.state)).length + this.intake,
        windows: (this.windows?.list('editor').length ?? 0) + (this.windows?.list('picker').length ?? 0),
        drag: this.helper?.dragInProgress ?? false,
      }),
      announceDownloaded: (version) => {
        if (!this.settings.get().notifications) return;
        this.showNotification(this.t('update.notify.title', { version }), this.t('update.notify.body'), () => this.windows?.open('about'));
      },
      shutdown: () => this.shutdown(),
    });
    this.updates = updates.service;
    this.build = updates.build;
    this.updates.onChange((state) => {
      this.windows?.broadcast(IPC_CHANNELS.updateStateChanged, state);
      this.tray?.refresh();
    });
  }

  /** Counts `work` as intake while it runs (a restart to update waits for it; update/service.ts). */
  private async tracked<T>(work: () => Promise<T>): Promise<T> {
    this.intake += 1;
    try {
      return await work();
    } finally {
      this.intake -= 1;
    }
  }

  /** JobManager's runner: the processor pool (an E2E script may act on the attempt first). */
  private async runJob(job: ProcessorJob, ctx: PoolRunContext): Promise<ProcessorResult> {
    if (this.testJobScript) await this.testJobScript.beforeRun(ctx.signal);
    return this.pool.run(job, ctx);
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
    // An unusable settings/history file was kept aside and replaced by defaults: the user is told (startUi).
    if (this.settings.loadIssue) this.startupNotices.push({ code: 'settingsReset', backup: this.settings.loadIssue.backup });
    if (this.history.loadIssue) this.startupNotices.push({ code: 'historyReset', backup: this.history.loadIssue.backup });
    // The x64 build on an Apple silicon Mac (a wrong download): it works under Rosetta 2, but the first launch
    // waits for translation and macOS is ending Intel app support — point the user to the arm64 build. Not on
    // Windows: there is no arm64 Windows build to switch to.
    if (runningTranslated()) {
      this.startupNotices.push({ code: 'translated' });
      this.log.warn('x64 build running under Rosetta 2 on Apple silicon; the arm64 build is the right one here');
    }
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

  /**
   * Windows and what they need: session hardening, the preview protocol, the
   * WindowManager, web-contents guards and the IPC router. Part of startUi();
   * the smoke test runs it alone with `hidden` (its window loads and renders
   * but is never shown).
   */
  startWindows(options: { readonly hidden?: boolean } = {}): WindowManager {
    if (this.windows) return this.windows;
    hardenSession(session.defaultSession, createLogger('security'));
    servePreviews(this.previews, session.defaultSession);

    const windows = new WindowManager({
      preloadPath: this.paths.preload,
      rendererUrl: this.paths.rendererUrl,
      rendererFile: this.paths.rendererFile,
      background: () => this.windowBackground(),
      title: (context) => this.windowTitle(context),
      quiet: this.options.e2e,
      hidden: options.hidden === true,
      devTools: !app.isPackaged,
      onClosed: (record) => this.onWindowClosed(record),
      onOpened: (record) => {
        if (record.kind === 'dropzone') this.tray?.refresh();
      },
      onPageCrashClosed: (record) => this.onPageCrashClosed(record),
      log: createLogger('windows'),
    });
    this.windows = windows;
    installWebContentsHardening(app, (url) => windows.isTrustedUrl(url), createLogger('security'));

    this.router = new IpcRouter<WindowRecord>(ipcMain as unknown as IpcMainLike, { lookup: (sender) => windows.recordFor(sender as never), isTrustedUrl: (url) => windows.isTrustedUrl(url) }, createLogger('ipc'));
    registerOrbitIpc(this.router, this.ipcServices());
    registerSupportIpc(this.router, this.supportIpcServices());
    return windows;
  }

  async startUi(): Promise<void> {
    const windows = this.startWindows();
    this.setupAppMenu();

    this.settings.onChange((next, previous) => this.onSettingsChanged(next, previous));
    this.capabilities.onChange(() => this.helper?.reconfigure());
    // OS appearance changes reach the helper's wheel when the settings say "system": dark mode and high
    // contrast through nativeTheme; on macOS also Reduce motion / Increase contrast (Accessibility › Display),
    // which nativeTheme does not report. `reconfigure` sends only when the configure message really changed.
    nativeTheme.on('updated', () => this.helper?.reconfigure());
    if (process.platform === 'darwin') {
      try {
        this.accessibilityNotification = systemPreferences.subscribeWorkspaceNotification('NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification', () =>
          this.helper?.reconfigure(),
        );
      } catch (error) {
        this.log.warn('could not watch the accessibility display options', { error: describeError(error) });
      }
    } else if (process.platform === 'win32') {
      // Windows reports no change of "Animation effects" (the OS reduce-motion setting): read it again when one
      // of our windows gets focus and every 30 s — `reconfigure` sends only when the message really changed.
      app.on('browser-window-focus', () => this.helper?.reconfigure());
      this.motionTimer = setInterval(() => this.helper?.reconfigure(), 30_000);
      this.motionTimer.unref?.();
    }

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
          checkForUpdates: () => {
            windows.open('about');
            void this.updates.checkNow();
          },
          restartToUpdate: () => {
            this.updates.requestRestart();
            // Waiting for running work: About says so (nothing to show when the restart starts at once).
            if (this.updates.restartWaiting) windows.open('about');
          },
          cancelRestartToUpdate: () => this.updates.cancelRestart(),
          quit: () => app.quit(),
          openGuide: () => this.openWelcome(),
          openWebsite: () => void this.support.openWebsite().catch((error: unknown) => this.log.warn('could not open the website', { error: describeError(error) })),
          reportProblem: () => void this.support.reportProblem().catch((error: unknown) => this.log.warn('could not open the issue form', { error: describeError(error) })),
          openLogFolder: () => void this.support.openLogFolder().catch(() => undefined),
        },
        t: this.t,
        tooltip: () => trayTooltip(this.settings.get(), process.platform, this.t),
        log: createLogger('tray'),
      });
      this.tray.create();
    }

    this.adoptLoginItem();
    this.updates.start();
    if (this.helper) void this.helper.start();
    this.announceStartupNotices();
    this.log.info('ui started', { tray: this.tray !== null, helper: this.helper !== null });
    this.markStarted();
    void this.runFirstRun();
  }

  /**
   * First run (onboarding.ts): macOS — offer once to move the app into Applications; then the welcome
   * window until it was closed once. Never in automation.
   */
  private async runFirstRun(): Promise<void> {
    try {
      await runOnboarding({
        settings: this.settings,
        automated: this.options.e2e || this.options.smokeTest,
        moveToApplications: process.platform === 'darwin' && app.isPackaged ? this.moveToApplications() : null,
        openWelcome: () => this.openWelcome(),
        log: this.log,
      });
    } catch (error) {
      this.log.warn('first-run flow failed', { error: describeError(error) });
    }
  }

  /** The welcome window (first run, Help › 사용법), centred on the display with the pointer. */
  openWelcome(): void {
    if (this.quitting || !this.windows) return;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    this.windows.open('welcome', { x: Math.round(area.x + area.width / 2), y: Math.round(area.y + area.height / 2) });
  }

  /** macOS, packaged, outside Applications (DMG, Downloads…): 이동 / 나중에, asked once. */
  private moveToApplications(): MoveToApplications {
    return {
      needed: () => !app.isInApplicationsFolder(),
      ask: async () => {
        app.focus({ steal: true });
        const { response } = await dialog.showMessageBox({
          type: 'question',
          buttons: [this.t('welcome.move.move'), this.t('welcome.move.later')],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          message: this.t('welcome.move.title'),
          detail: this.t('welcome.move.body'),
        });
        return response === 0;
      },
      move: () =>
        app.moveToApplicationsFolder({
          // An older OrbitDrop in Applications (not running — that one would hold the single-instance lock):
          // replaced (Electron moves it to the Trash) only if the user says so.
          conflictHandler: (conflict) =>
            conflict !== 'exists' ||
            dialog.showMessageBoxSync({
              type: 'question',
              buttons: [this.t('welcome.move.replace'), this.t('welcome.move.cancel')],
              defaultId: 0,
              cancelId: 1,
              noLink: true,
              message: this.t('welcome.move.replaceTitle'),
              detail: this.t('welcome.move.replaceBody'),
            }) === 0,
        }),
    };
  }

  /** A second launch without files, or (macOS) re-opening the running app from Finder: the Drop Zone (also when it comes during startup). */
  async showDropZone(): Promise<void> {
    await this.started;
    if (this.quitting) return;
    this.log.debug('drop zone requested (second launch or reopen)');
    this.windows?.open('dropzone');
  }

  /** macOS reopen: the Drop Zone, unless the reopen only followed a click on one of our notifications. */
  reopened(): void {
    this.reopenFilter.reopened();
  }

  /**
   * Files handed over by the OS — a second launch's command line (Windows:
   * dropped on OrbitDrop.exe or a shortcut), macOS open-file. They go through
   * FileRegistry validation like every other input; the picker shows the
   * selection (unusable files with their reason).
   */
  async openPaths(paths: readonly string[]): Promise<void> {
    if (this.quitting || paths.length === 0) return;
    await this.started;
    const anchor = screen.getCursorScreenPoint();
    try {
      await this.capabilities.get(); // selections are built with the probed capabilities
      const selection = await this.tracked(() => this.files.registerPaths(paths.slice(0, MAX_SELECTION_FILES), 'openDialog'));
      if (this.quitting) return;
      this.windows?.openPicker(selection.selectionId, 'convert', anchor);
    } catch (error) {
      const code = error instanceof OrbitError ? error.code : 'INTERNAL';
      this.log.warn('files handed over by the system could not be opened', { count: paths.length, code });
      this.notifier.rejected(code);
    }
  }

  /** Sleep, screen lock, user switch: no drag session may survive it (the helper hides its wheel). */
  systemSuspended(reason: string): void {
    this.log.info('system suspended or locked', { reason });
    this.helper?.cancelSessions(reason);
  }

  /** Resume, unlock: check that the helper still works (and restart one that had given up). */
  systemResumed(reason: string): void {
    if (this.quitting) return;
    this.log.info('system resumed or unlocked', { reason });
    this.updates.resumed();
    void this.helper?.recheck(reason).catch((error: unknown) => this.log.warn('helper re-check failed', { error: describeError(error) }));
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
      this.windows?.setQuitting(); // quitting is never held back by an editor's unsaved work
      if (this.sweepTimer) clearInterval(this.sweepTimer);
      if (this.motionTimer) clearInterval(this.motionTimer);
      this.updates.dispose();
      this.router?.dispose();
      this.tray?.destroy();
      if (this.accessibilityNotification !== null) systemPreferences.unsubscribeWorkspaceNotification(this.accessibilityNotification);
      this.accessibilityNotification = null;
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
      closeWindow: (record) => windows().closeWindow(record),
      setCloseGuard: (record, guard) => windows().setCloseGuard(record, guard),
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
      registerDroppedPaths: (paths) => this.tracked(() => this.files.registerPaths(paths, 'dropZone')),
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
        if (!isRendererExternalUrl(url)) {
          this.log.warn('external URL refused');
          return false;
        }
        await shell.openExternal(url);
        return true;
      },
      thumbnail: (request) => this.editors.thumbnail(request),
      estimate: (request) => this.editors.estimate(request),
      clearFinishedJobs: (finishedUpTo) => this.jobs.clearFinished(finishedUpTo),
      retryJob: (jobId, record) => this.submission.retryJob(jobId, { source: 'openDialog', sessionId: null, windowId: record.windowId }),
      updateState: () => this.updates.state(),
      checkForUpdates: () => this.updates.checkNow(),
      restartToUpdate: () => this.updates.requestRestart(),
    };
  }

  /** First run, help, diagnostics and crash handling (ipc/support.ts). */
  private supportIpcServices(): SupportIpcServices<WindowRecord> {
    return {
      windowNotice: (record) => this.windows?.notice(record) ?? null,
      rendererError: (report, record) => {
        this.rendererErrors.report({ kind: record.kind, windowId: record.windowId }, report);
      },
      copyDiagnostics: () => this.support.copyDiagnostics(),
      openLogFolder: () => this.support.openLogFolder(),
      openDataFolder: () => this.support.openDataFolder(),
      resetSettings: async () => {
        this.log.info('settings reset to the defaults (Settings › General)');
        return this.settings.reset();
      },
      openLicense: (which) => this.support.openLicense(which),
      restartHelper: async () => {
        if (!this.helper) throw new OrbitError('HELPER_UNAVAILABLE', 'The drag helper is not used in this run');
        await this.helper.restart();
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
      ...(runningTranslated() ? { translated: true as const } : {}),
      ...(this.startupNotices.length > 0 ? { notices: [...this.startupNotices] } : {}),
      ...(this.build ? { build: this.build } : {}),
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
      const selection = await this.tracked(() => this.files.registerPaths(paths, 'openDialog'));
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

  /**
   * A global-drag job that could not write next to its files (read-only
   * folder, disk full…) has no window to explain it, and notifications may be
   * off or not allowed: open the Jobs window without taking focus — the failed
   * card offers "save to another folder". Once per drop.
   */
  private surfaceDragFailure(view: JobRecordView): void {
    if (!needsAnotherFolder(view) || !this.windows || this.quitting) return;
    const key = view.spec.origin.sessionId ?? view.batchId ?? view.jobId;
    if (this.surfacedFailures.has(key)) return;
    this.surfacedFailures.add(key);
    if (this.surfacedFailures.size > 200) this.surfacedFailures.clear();
    this.log.info('drag job needs another output folder; showing the jobs window', { jobId: view.jobId, code: view.snapshot.error?.code });
    this.windows.open('jobs', undefined, { inactive: true });
  }

  private onWindowClosed(record: WindowRecord): void {
    if (record.context.kind === 'editor') this.editors.dispose(record.context.editorId);
    if (record.kind === 'dropzone') this.tray?.refresh();
    // The welcome was seen (시작하기, ×, Esc, ⌘W…): it no longer opens by itself; Help › 사용법 still opens it.
    if (record.kind === 'welcome' && !this.quitting) {
      void this.settings.update({ onboarding: { welcomeDone: true } }).catch((error: unknown) => this.log.warn('could not store the welcome state', { error: describeError(error) }));
    }
  }

  /** A window closed because its page kept crashing (WindowManager): tell the user. */
  private onPageCrashClosed(record: WindowRecord): void {
    if (this.quitting || !this.settings.get().notifications) return;
    const title = this.t('crash.window.closedTitle', { window: this.windowTitle(record.context) });
    this.showNotification(title, this.t(record.crash.unsavedLost ? 'crash.window.closedBodyUnsaved' : 'crash.window.closedBody'), () => undefined);
  }

  /**
   * Show an output in Finder / Explorer. Revealing never opens anything: when
   * the file is gone its folder is revealed (selected in its parent) instead —
   * `openPath` on a folder from a damaged history.json could start an app bundle.
   */
  async revealOutput(outputId: string): Promise<void> {
    const output = this.outputs.get(outputId);
    if (!output) throw new OrbitError('FILE_NOT_FOUND', 'Unknown output');
    if (existsSync(output.path)) shell.showItemInFolder(output.path);
    else if (existsSync(dirname(output.path))) shell.showItemInFolder(dirname(output.path));
    else throw new OrbitError('FILE_NOT_FOUND', 'The output no longer exists');
  }

  /** Open an output with its default app — only a regular file in a format OrbitDrop writes (isOpenableOutput). */
  async openOutput(outputId: string): Promise<void> {
    const output = this.outputs.get(outputId);
    if (!output || !existsSync(output.path)) throw new OrbitError('FILE_NOT_FOUND', 'The output no longer exists');
    if (!(await isOpenableOutput(output.path))) {
      this.log.warn('refused to open an output that is not a file OrbitDrop writes', { outputId });
      throw new OrbitError('UNSUPPORTED_FORMAT', 'Not a file OrbitDrop writes');
    }
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
        // Folders, non-file data (text, URLs), virtual items (file promises, mail attachments) and online-only
        // cloud files (iCloud Drive, OneDrive Files On-Demand) get their own text.
        unsupportedFolder: this.t('helper.unsupportedFolder'),
        unsupportedNonFile: this.t('helper.unsupportedNonFile'),
        unsupportedVirtual: this.t('helper.unsupportedVirtual'),
        unsupportedCloud: this.t('helper.unsupportedCloud'),
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
    this.helperCrash.onStatus(status);
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
    // The tray tooltip names the drag keys.
    if (next.locale !== previous.locale || JSON.stringify(next.globalDrag) !== JSON.stringify(previous.globalDrag)) this.tray?.refresh();
    if (next.locale !== previous.locale) this.windows?.broadcast(IPC_CHANNELS.helperStatusChanged, this.publicHelperStatus());
    if (next.launchAtLogin !== previous.launchAtLogin) {
      const items = this.loginItems();
      if (items) applyLoginItem(items, next.launchAtLogin, this.log);
    }
  }

  /**
   * The OS login items, when this build manages them (packaged only: never the development Electron binary).
   * Windows: `openAtLogin` only says the Run entry exists; switched off in Task Manager › Startup apps it is
   * still there, and only `executableWillLaunchAtLogin` tells (setLoginItemSettings re-enables it).
   */
  private loginItems(): LoginItems | null {
    if (!app.isPackaged || this.options.e2e || this.options.smokeTest) return null;
    return {
      openAtLogin: () => {
        const state = app.getLoginItemSettings();
        return process.platform === 'win32' ? state.executableWillLaunchAtLogin : state.openAtLogin;
      },
      setOpenAtLogin: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
    };
  }

  /** Startup: the login item may have been changed in the OS settings — follow it instead of undoing it. */
  private adoptLoginItem(): void {
    const items = this.loginItems();
    if (!items) return;
    const adopt = loginItemToAdopt(items, this.settings.get().launchAtLogin, this.log);
    if (adopt === null) return;
    this.log.info('launch at login was changed in the system settings; following it', { openAtLogin: adopt });
    void this.settings.update({ launchAtLogin: adopt }).catch((error: unknown) => this.log.warn('could not store the login item state', { error: describeError(error) }));
  }

  /**
   * Settings or history could not be used and were reset (the old file is
   * kept aside), or the x64 build runs under Rosetta 2: one notification per
   * notice (click: Settings, which lists them too — AppInfo.notices).
   * Notifications switched off: Settings only.
   */
  private announceStartupNotices(): void {
    if (!this.settings.get().notifications) return;
    for (const notice of this.startupNotices) {
      const { code } = notice;
      let body: string;
      if (code === 'translated') body = this.t('notify.translated.body');
      else body = notice.backup !== null ? this.t(`notify.${code}.body`, { file: notice.backup }) : this.t(`notify.${code}.bodyNoBackup`);
      this.showNotification(this.t(`notify.${code}.title`), body, () => this.windows?.open('settings'));
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
      update: this.updates.trayState(),
    };
  }

  /**
   * Window background before the renderer paints: the windowBg of the theme the
   * renderer will pick, including its dark high-contrast set
   * (design-tokens color.highContrastDark, renderer-only: the helpers' wheel
   * keeps the light high-contrast tokens).
   */
  private windowBackground(): string {
    const settings = this.settings.get();
    const highContrast = resolveHighContrast(settings.accessibility.highContrast, nativeTheme.shouldUseHighContrastColors);
    if (highContrast && nativeTheme.shouldUseDarkColors) return DESIGN_TOKENS.color.highContrastDark.windowBg;
    return colorTokens(resolveTheme(highContrast, nativeTheme.shouldUseDarkColors)).windowBg;
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
      welcome: 'window.welcome',
    };
    return this.t(keys[context.kind]);
  }

  private setupAppMenu(): void {
    const template = appMenuTemplate(process.platform);
    Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
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
    // Lifecycle at debug level (never the texts: they name files).
    notification.on('show', () => this.log.debug('notification shown', { id: notification.id }));
    notification.on('failed', (_event, error) => this.log.warn('notification failed', { id: notification.id, error: String(error).slice(0, 200) }));
    notification.on('click', () => {
      this.log.debug('notification clicked', { id: notification.id });
      this.reopenFilter.notificationClicked();
      release();
      onClick();
    });
    notification.on('close', () => {
      this.log.debug('notification closed', { id: notification.id });
      release();
    });
    notification.show();
    if (this.liveNotifications.size > 20) {
      const oldest = this.liveNotifications.values().next().value;
      if (oldest) this.liveNotifications.delete(oldest);
    }
  }
}
