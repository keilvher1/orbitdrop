/**
 * OrbitDrop main process entry.
 *
 * Menu-bar / tray app: no window at startup (macOS: dock hidden, LSUIElement
 * comes from packaging). Single instance. `--smoke-test` runs the packaged
 * self test and exits (see smoke.ts).
 */
// Keep first: sizes the libuv thread pool before anything uses it.
import './uv-threadpool';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { OrbitApp, type AppPaths } from './app';
import { parseLaunchOptions } from './launch-options';
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

async function runApp(): Promise<void> {
  if (process.platform === 'darwin') app.dock?.hide();
  const orbit = new OrbitApp(options, appPaths());
  if (options.e2e) installTestHooks(orbit);

  let quitting = false;
  app.on('before-quit', (event) => {
    // Every quit request waits for the cleanup started by the first one (a second ⌘Q / tray Quit
    // must not cut it short); the force timer still guarantees the exit.
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    const force = setTimeout(() => app.exit(0), 10_000);
    void orbit.shutdown().finally(() => {
      clearTimeout(force);
      app.exit(0);
    });
  });
  app.on('second-instance', () => orbit.onSecondInstance());

  await orbit.startCore();
  await orbit.startUi();
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
  app.quit();
} else {
  // Tray app: closing the last window must not quit.
  app.on('window-all-closed', () => undefined);
  app
    .whenReady()
    .then(runApp)
    .catch((error: unknown) => {
      log.error('startup failed', { error: describeError(error) });
      app.exit(1);
    });
}
