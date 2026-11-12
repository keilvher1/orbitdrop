import { app } from 'electron';
import type { BuildSummary } from '@orbitdrop/contracts';
import { createLogger } from '../log';
import type { SettingsStore } from '../settings/store';
import { buildSummary, readBuildInfo } from './build-info';
import { createElectronUpdaterDriver } from './driver';
import { UpdateService, type WorkInProgress } from './service';
import { updateSupport } from './support';

export interface AppUpdatesDeps {
  readonly smokeTest: boolean;
  readonly resourcesPath: string;
  readonly settings: SettingsStore;
  readonly work: () => WorkInProgress;
  readonly announceDownloaded: (version: string) => void;
  readonly shutdown: () => Promise<void>;
}

/**
 * The app's update service and build summary (OrbitApp's constructor): reads
 * Resources/build-info.json, decides once whether this run can update itself (support.ts) and
 * creates the service. Nothing here touches the network; the service loads electron-updater at
 * its first check, and only in a build that can update.
 */
export function createAppUpdates(deps: AppUpdatesDeps): { readonly service: UpdateService; readonly build: BuildSummary | null } {
  const log = createLogger('update');
  const info = readBuildInfo({ packaged: app.isPackaged, resourcesPath: deps.resourcesPath, log });
  const support = updateSupport({
    packaged: app.isPackaged,
    smokeTest: deps.smokeTest,
    platform: process.platform,
    buildInfo: info,
    execPath: process.execPath,
    resourcesPath: deps.resourcesPath,
    productName: app.getName(),
  });
  const service = new UpdateService({
    support,
    currentVersion: app.getVersion(),
    settings: deps.settings,
    createDriver: (events) => createElectronUpdaterDriver(events, log),
    work: deps.work,
    announceDownloaded: deps.announceDownloaded,
    shutdown: deps.shutdown,
    relaunch: () => {
      app.relaunch();
      app.exit(0);
    },
    log,
  });
  return { service, build: info ? buildSummary(info) : null };
}
