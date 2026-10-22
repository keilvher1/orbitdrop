/**
 * OrbitDrop main process entry.
 *
 * Menu-bar / tray app: no window at startup (macOS: dock hidden, LSUIElement
 * comes from packaging). Single instance. `--smoke-test` runs the packaged
 * self test and exits (see smoke.ts). App-level events (quit, second launch,
 * macOS reopen / open-file, sleep and screen lock) are wired in lifecycle.ts.
 */
// Keep first: sizes the libuv thread pool before anything uses it.
import './uv-threadpool';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, dialog, powerMonitor } from 'electron';
import { OrbitApp, type AppPaths } from './app';
import { t } from './i18n';
import { parseLaunchOptions } from './launch-options';
import {
  OpenFileQueue,
  dataDirWritable,
  filePathsFromArgv,
  installInstanceHandlers,
  installOpenFileHandler,
  installPowerHandlers,
  installQuitHandler,
  type EmitterLike,
} from './lifecycle';
import { createLogger, describeError } from './log';
import { registerPreviewSchemePrivileges } from './preview/protocol';
import { runSmokeTest } from './smoke';
import { installTestHooks } from './test-hooks';

const log = createLogger('main');
const options = parseLaunchOptions(process.argv, process.env, app.isPackaged);

let smokeDataDir: string | null = null;
if (options.userDataDir) {
  app.setPath('userData', options.userDataDir);
} else if (options.smokeTest) {
  // Never touch the user's settings/history or the running instance's lock.
  smokeDataDir = mkdtempSync(join(tmpdir(), 'orbitdrop-smoke-data-'));
  app.setPath('userData', smokeDataDir);
}

registerPreviewSchemePrivileges();
app.enableSandbox();
// Must equal electron-builder's appId (apps/desktop/electron-builder.yml) or Windows drops notifications.
if (process.platform === 'win32') app.setAppUserModelId('app.orbitdrop.desktop');

function appPaths(): AppPaths {
  const rendererUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null;
  return {
    preload: join(__dirname, '../preload/index.js'),
    rendererFile: join(__dirname, '../renderer/index.html'),
    rendererUrl,
    processorHost: join(__dirname, 'processor-host.js'),
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
  };
}

async function runSmoke(): Promise<void> {
  if (process.platform === 'darwin') app.dock?.hide();
  const orbit = new OrbitApp(options, appPaths());
  let code = 1;
  try {
    code = await runSmokeTest(orbit, app.getVersion(), app.isPackaged);
  } catch (error) {
    log.error('smoke test crashed', { error: describeError(error) });
  }
  await orbit.shutdown().catch(() => undefined);
  try {
    if (smokeDataDir) rmSync(smokeDataDir, { recursive: true, force: true });
  } catch {
    // a leftover temp folder must not turn a passing smoke test into a failure
  }
  app.exit(code);
}

async function runApp(openFiles: OpenFileQueue): Promise<void> {
  if (process.platform === 'darwin') app.dock?.hide();
  const orbit = new OrbitApp(options, appPaths());
  if (options.e2e) installTestHooks(orbit);

  installQuitHandler(app, () => orbit.shutdown());
  // Development runs are `electron <app folder or entry script>`: that argument names no file.
  const argv = { platform: process.platform, appPath: app.getAppPath(), skip: process.defaultApp ? 2 : 1 };
  installInstanceHandlers(app as unknown as EmitterLike, orbit, { ...argv, cwd: () => process.cwd() });
  installPowerHandlers(powerMonitor as unknown as EmitterLike, orbit, process.platform);

  await orbit.startCore();
  await orbit.startUi();
  // Files this launch was started with (Windows: dropped on OrbitDrop.exe / a shortcut), and macOS open-file.
  const launchFiles = filePathsFromArgv(process.argv, process.cwd(), argv);
  if (launchFiles.length > 0) void orbit.openPaths(launchFiles);
  openFiles.attach((paths) => void orbit.openPaths(paths));
}

/**
 * The app data folder cannot be written, so Chromium could not create the
 * single-instance lock: tell the user (in both languages — the settings that
 * hold the language may be unreadable too) instead of quitting silently.
 */
function reportUnwritableDataDir(dir: string): void {
  try {
    log.error('the app data folder is not writable; OrbitDrop cannot start');
    const title = `${t('ko', 'startup.dataDir.title')} / ${t('en', 'startup.dataDir.title')}`;
    const body = `${t('ko', 'startup.dataDir.body', { path: dir })}\n\n${t('en', 'startup.dataDir.body', { path: dir })}`;
    // Automation: no modal dialog on the tester's desktop; the marker line is what the test reads.
    if (options.e2e) process.stderr.write('ORBITDROP_STARTUP_ERROR dataDirNotWritable\n');
    else dialog.showErrorBox(title, body);
  } finally {
    app.exit(1); // never a windowless process left running
  }
}

if (options.smokeTest) {
  app.on('window-all-closed', () => undefined);
  app
    .whenReady()
    .then(runSmoke)
    .catch((error: unknown) => {
      log.error('smoke test failed to start', { error: describeError(error) });
      app.exit(1);
    });
} else if (!app.requestSingleInstanceLock()) {
  // Usually another OrbitDrop holds the lock (it shows its Drop Zone or the files' picker). When the app
  // data folder cannot be written, Chromium cannot create the lock at all — say so.
  const dataDir = app.getPath('userData');
  if (dataDirWritable(dataDir)) app.quit();
  else
    app
      .whenReady()
      .then(() => reportUnwritableDataDir(dataDir))
      .catch(() => app.exit(1));
} else {
  // macOS can hand files over before `ready` (open-file): collect them from the start.
  const openFiles = new OpenFileQueue();
  installOpenFileHandler(app as unknown as EmitterLike, openFiles);
  // Tray app: closing the last window must not quit.
  app.on('window-all-closed', () => undefined);
  app
    .whenReady()
    .then(() => runApp(openFiles))
    .catch((error: unknown) => {
      log.error('startup failed', { error: describeError(error) });
      app.exit(1);
    });
}
