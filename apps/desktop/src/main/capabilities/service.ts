import {
  type CapabilitySnapshot,
  type EngineProbe,
  type FileSelection,
  type Locale,
  type WheelMenu,
  type WheelMode,
  OrbitError,
} from '@orbitdrop/contracts';
import { adjustMenuForFileCount, buildCapabilitySnapshot, buildHelperMenus, buildWheelMenu, helperExtensionMap } from '@orbitdrop/core';
import { describeError, scrubPaths, silentLogger, type Logger } from '../log';
import { failedProbe } from '../processing/probe-fallback';
import { withTimeout } from '../util/concurrency';

/**
 * Capabilities = what the bundled engines can really do, measured by
 * `probeEngines()` in the aux worker and turned into a CapabilitySnapshot by
 * @orbitdrop/core. Menus for the picker and the native helper are only built
 * from this snapshot.
 */
export class CapabilityService {
  private snapshot: CapabilitySnapshot | null = null;
  private inflight: Promise<CapabilitySnapshot> | null = null;
  private readonly listeners = new Set<(snapshot: CapabilitySnapshot) => void>();
  private probeOk = false;

  constructor(
    private readonly probe: () => Promise<EngineProbe>,
    private readonly log: Logger = silentLogger,
    // Longer than the pool's own probe limit (90 s), which restarts a stuck worker first.
    private readonly timeoutMs = 120_000,
  ) {}

  /** Current snapshot, waiting for the first probe if needed. */
  get(): Promise<CapabilitySnapshot> {
    if (this.snapshot) return Promise.resolve(this.snapshot);
    return this.refresh();
  }

  current(): CapabilitySnapshot | null {
    return this.snapshot;
  }

  /** Whether the last probe ran (even if some engines are missing). False when it failed entirely. */
  get lastProbeSucceeded(): boolean {
    return this.probeOk;
  }

  refresh(): Promise<CapabilitySnapshot> {
    this.inflight ??= (async () => {
      let probe: EngineProbe;
      try {
        probe = await withTimeout(this.probe(), this.timeoutMs, () => new OrbitError('TIMEOUT', 'Engine probe timed out'));
        // Probe notes go to the renderer (getCapabilities): no file paths.
        probe = { ...probe, errors: probe.errors.map((note) => scrubPaths(note).slice(0, 300)) };
        this.probeOk = true;
      } catch (error) {
        this.log.error('engine probe failed', { error: describeError(error) });
        probe = failedProbe([`probe failed: ${describeError(error)}`]);
        this.probeOk = false;
      }
      const snapshot = buildCapabilitySnapshot(probe);
      this.snapshot = snapshot;
      const enabled = Object.values(snapshot.actions).filter((a) => a.enabled).length;
      this.log.info('capabilities ready', { enabledActions: enabled, probeErrors: probe.errors.length });
      for (const listener of this.listeners) listener(snapshot);
      return snapshot;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  onChange(listener: (snapshot: CapabilitySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Picker menu for a selection: capability-filtered sectors, non-batch sectors disabled for several files. */
  async menuFor(selection: FileSelection, usableCount: number, mode: WheelMode, locale: Locale, multiFileReason: string): Promise<WheelMenu> {
    if (selection.menuKey === null) throw new OrbitError('UNSUPPORTED_FORMAT', 'Nothing in the selection is supported');
    const snapshot = await this.get();
    return adjustMenuForFileCount(buildWheelMenu(snapshot, selection.menuKey, mode, locale), usableCount, multiFileReason);
  }

  helperMenus(locale: Locale): ReturnType<typeof buildHelperMenus> | null {
    return this.snapshot ? buildHelperMenus(this.snapshot, locale) : null;
  }

  helperExtensions(): Record<string, string> | null {
    return this.snapshot ? helperExtensionMap(this.snapshot) : null;
  }
}
