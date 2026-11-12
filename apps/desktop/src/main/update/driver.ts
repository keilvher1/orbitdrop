import { autoUpdater as nativeAutoUpdater } from 'electron';
import type { AppUpdater, Logger as UpdaterLogger, NsisUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import { describeError, type Logger } from '../log';
import { withoutInstallationId } from './privacy';
import type { UpdaterDriver, UpdaterEvents } from './service';

/**
 * electron-updater behind the UpdateService's small driver interface. Loaded on first use only,
 * so a build that cannot update never loads it.
 *
 * Network: electron-updater makes its requests with Electron's `net` in its own in-memory session
 * (partition "electron-updater", no cache, no cookies sent), never in the windows' session. The
 * requests go to github.com (releases.atom, releases/latest, the release's latest-mac.yml /
 * latest.yml) and, for an update, to the release asset (GitHub redirects downloads to its asset
 * host). They carry electron-updater's fixed User-Agent and no installation id (privacy.ts).
 *
 * Configuration (from Resources/app-update.yml, written by electron-builder): provider github,
 * owner keilvher1, repo orbitdrop. Drafts and prereleases are never offered to a release build
 * (GitHub's releases/latest skips them). An -alpha.n / -beta.n build also takes newer prereleases and
 * the final release; any other prerelease id (e.g. -rc.n) is a channel of its own in electron-updater
 * and only ever moves to newer builds of that channel — test updates with -beta builds.
 */

type ElectronUpdaterModule = typeof import('electron-updater');

async function loadElectronUpdater(): Promise<ElectronUpdaterModule> {
  // A CommonJS package: import() gives its exports as `default` (named exports may be missing).
  const loaded = (await import('electron-updater')) as ElectronUpdaterModule & { default?: ElectronUpdaterModule };
  return loaded.default ?? loaded;
}

/** electron-updater's log lines (stack traces, cache paths) through OrbitDrop's path-redacting logger. */
function updaterLogger(log: Logger): UpdaterLogger {
  const text = (message: unknown): string => (message instanceof Error ? describeError(message) : String(message).slice(0, 500));
  return {
    info: (message?: unknown) => log.info(text(message)),
    warn: (message?: unknown) => log.warn(text(message)),
    error: (message?: unknown) => log.error(text(message)),
    debug: (message: string) => log.debug(text(message)),
  };
}

export async function createElectronUpdaterDriver(events: UpdaterEvents, log: Logger, platform: NodeJS.Platform = process.platform): Promise<UpdaterDriver> {
  const lib = await loadElectronUpdater();
  const updater: AppUpdater = platform === 'darwin' ? new lib.MacUpdater() : new lib.NsisUpdater();
  withoutInstallationId(updater);
  updater.logger = updaterLogger(log);
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.autoRunAppAfterInstall = true;
  updater.allowDowngrade = false;
  updater.fullChangelog = false;
  // OrbitDrop ships the full NSIS installer; never accept a web installer (its package has no signature check).
  updater.disableWebInstaller = true;
  // Windows packages have no installer blockmap (nsis.differentialPackage: false): download the whole
  // installer instead of first asking for two blockmaps that do not exist. macOS keeps differential
  // downloads of the zip (from the second update on, against the cached previous update).
  if (platform === 'win32') updater.disableDifferentialDownload = true;

  // Given up by the service (a stalled request): nothing from this instance is reported any more.
  let detached = false;
  const forward = <A extends unknown[]>(handler: (...args: A) => void) => (...args: A): void => {
    if (!detached) handler(...args);
  };

  // macOS: electron-updater reports the download as soon as the zip is on disk; Squirrel.Mac then
  // fetches it from electron-updater's loopback server, checks that it is signed like the running
  // app and stages it. Only that native confirmation makes the update installable.
  let downloadedVersion: string | null = null;
  let squirrelReady = platform !== 'darwin';
  const confirm = (): void => {
    if (detached || downloadedVersion === null || !squirrelReady) return;
    const version = downloadedVersion;
    downloadedVersion = null;
    events.downloaded(version);
  };
  if (platform === 'darwin') {
    nativeAutoUpdater.on('update-downloaded', () => {
      squirrelReady = true;
      confirm();
    });
  }

  updater.on('checking-for-update', forward(() => events.checking()));
  updater.on('update-available', forward((info: UpdateInfo) => events.available(info.version)));
  updater.on('update-not-available', forward(() => events.notAvailable()));
  updater.on('download-progress', forward((progress: ProgressInfo) => events.progress(progress.percent)));
  updater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    downloadedVersion = event.version;
    if (platform === 'darwin') squirrelReady = false; // wait for Squirrel.Mac's own confirmation of this download
    confirm();
  });
  updater.on('error', forward((error: Error) => events.error(error)));

  return {
    shutdownBeforeInstall: platform === 'win32',
    async check() {
      const result = await updater.checkForUpdates();
      // The download goes on after the check; a failure there arrives as an 'error' event. Never leave it unhandled.
      result?.downloadPromise?.catch(() => undefined);
    },
    quitAndInstall() {
      // Windows: silent install, then start the new version (--force-run). macOS: Squirrel.Mac relaunches.
      if (platform === 'win32') (updater as NsisUpdater).quitAndInstall(true, true);
      else updater.quitAndInstall();
    },
    dispose() {
      detached = true;
      // Nothing installs from a given-up instance when the app quits (a newer instance takes over).
      updater.autoInstallOnAppQuit = false;
    },
  };
}
