import type { ActionId, WheelMode } from '@orbitdrop/contracts';
import type { OrbitApp } from './app';

/**
 * Automation hooks for the Playwright E2E tests (ORBITDROP_E2E=1, unpackaged
 * builds only). They let a test open windows for generated fixture files
 * without OS dialogs or synthesized input:
 * `electronApp.evaluate(() => globalThis.__orbitdrop…)`. Every hook first
 * waits until the app finished starting (Playwright can attach while main is
 * still loading settings), and file registration also waits for the engine
 * probe so selections are deterministic.
 */
export interface OrbitTestHooks {
  registerPaths(paths: string[]): Promise<unknown>;
  openPicker(paths: string[], mode?: WheelMode): Promise<unknown>;
  submit(paths: string[], actionId: ActionId, options?: unknown): Promise<unknown>;
  openWindow(kind: 'jobs' | 'settings' | 'dropzone' | 'about'): Promise<void>;
  waitForJob(jobId: string): Promise<unknown>;
  jobs(): Promise<unknown>;
  capabilities(): Promise<unknown>;
  windows(): Promise<unknown>;
  outputPath(outputId: string): Promise<string | null>;
  helperStatus(): Promise<unknown>;
  updateSettings(patch: unknown): Promise<unknown>;
  trayMenu(): Promise<readonly string[] | null>;
  notifications(): Promise<readonly { readonly title: string; readonly body: string }[]>;
}

export function installTestHooks(orbit: OrbitApp): void {
  const started = (): Promise<void> => orbit.started;
  const probed = async (): Promise<void> => {
    await orbit.started;
    await orbit.capabilities.get();
  };
  const hooks: OrbitTestHooks = {
    registerPaths: async (paths) => {
      await probed();
      return orbit.files.registerPaths(paths, 'test');
    },
    openPicker: async (paths, mode = 'convert') => {
      await probed();
      const selection = await orbit.files.registerPaths(paths, 'test');
      orbit.windows?.openPicker(selection.selectionId, mode);
      return selection;
    },
    submit: async (paths, actionId, options) => {
      await probed();
      const selection = await orbit.files.registerPaths(paths, 'test');
      return orbit.submission.submit({ selectionId: selection.selectionId, actionId, ...(options === undefined ? {} : { options }) }, { source: 'test', sessionId: null });
    },
    openWindow: async (kind) => {
      await started();
      orbit.windows?.open(kind);
    },
    waitForJob: async (jobId) => {
      await started();
      return orbit.jobs.waitFor(jobId);
    },
    jobs: async () => {
      await started();
      return orbit.jobs.list();
    },
    capabilities: async () => {
      await started();
      return orbit.capabilities.get();
    },
    windows: async () => {
      await started();
      return orbit.windows?.list().map((record) => ({ kind: record.kind, context: record.context, windowId: record.windowId, url: record.window.webContents.getURL() })) ?? [];
    },
    outputPath: async (outputId) => {
      await started();
      return orbit.outputs.get(outputId)?.path ?? null;
    },
    helperStatus: async () => {
      await started();
      return orbit.helperStatus();
    },
    updateSettings: async (patch) => {
      await started();
      return orbit.settings.update(patch);
    },
    trayMenu: async () => {
      await started();
      if (!orbit.tray) return null;
      orbit.tray.refreshNow();
      return orbit.tray.lastLabels;
    },
    notifications: async () => {
      await started();
      return [...orbit.recordedNotifications];
    },
  };
  (globalThis as { __orbitdrop?: OrbitTestHooks }).__orbitdrop = hooks;
}
