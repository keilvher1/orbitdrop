import { OrbitError, type ActionId, type ErrorCode, type WheelMode } from '@orbitdrop/contracts';
import type { JobRunScript, OrbitApp } from './app';

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
  /** The next job attempts fail with these codes, one per attempt (a WORKER_CRASHED attempt is retried once by the queue). */
  failNextJobs(codes: ErrorCode[]): Promise<void>;
  /** The next job attempt stays 'running' until releaseHeldJobs() (or until it is cancelled). */
  holdNextJob(): Promise<void>;
  /** Let held attempts continue to the processor pool; returns how many were waiting. */
  releaseHeldJobs(): Promise<number>;
}

type ScriptStep = { readonly kind: 'fail'; readonly code: ErrorCode } | { readonly kind: 'hold' };

/** Scripted outcomes for the next job attempts, consumed in order (see OrbitApp.runJob). */
export class TestJobScript implements JobRunScript {
  private readonly steps: ScriptStep[] = [];
  private readonly held = new Set<() => void>();

  fail(codes: readonly ErrorCode[]): void {
    for (const code of codes) this.steps.push({ kind: 'fail', code });
  }

  hold(): void {
    this.steps.push({ kind: 'hold' });
  }

  release(): number {
    const waiting = [...this.held];
    this.held.clear();
    for (const resume of waiting) resume();
    return waiting.length;
  }

  async beforeRun(signal: AbortSignal): Promise<void> {
    const step = this.steps.shift();
    if (step === undefined) return;
    if (step.kind === 'fail') throw new OrbitError(step.code, 'Injected for an E2E test');
    await new Promise<void>((resolve, reject) => {
      const resume = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        this.held.delete(resume);
        reject(signal.reason instanceof Error ? signal.reason : new OrbitError('CANCELLED', 'Cancelled'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.held.add(resume);
    });
  }
}

export function installTestHooks(orbit: OrbitApp): void {
  const started = (): Promise<void> => orbit.started;
  const probed = async (): Promise<void> => {
    await orbit.started;
    await orbit.capabilities.get();
  };
  const script = new TestJobScript();
  orbit.testJobScript = script;
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
      // A window that is closing can still be listed while its page is already gone (seen on
      // Windows: getURL() threw "Object has been destroyed"); it is not open any more.
      return (
        orbit.windows
          ?.list()
          .filter((record) => !record.window.webContents.isDestroyed())
          .map((record) => ({
            kind: record.kind,
            context: record.context,
            windowId: record.windowId,
            url: record.window.webContents.getURL(),
            unsaved: record.guard.unsaved,
          })) ?? []
      );
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
    failNextJobs: async (codes) => {
      await started();
      script.fail(codes);
    },
    holdNextJob: async () => {
      await started();
      script.hold();
    },
    releaseHeldJobs: async () => {
      await started();
      return script.release();
    },
  };
  (globalThis as { __orbitdrop?: OrbitTestHooks }).__orbitdrop = hooks;
}
