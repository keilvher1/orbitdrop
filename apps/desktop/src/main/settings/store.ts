import { join } from 'node:path';
import { DEFAULT_SETTINGS, OrbitError, applySettingsPatch, defaultSettingsFor, migrateSettings, type Settings } from '@orbitdrop/contracts';
import { describeError, silentLogger, type Logger } from '../log';
import { SerialQueue, moveAside, readJson, writeJsonAtomic, type StoreLoadIssue, type UnusableReason } from '../util/atomic-json';
import { existingFileDefaults, firstRunSettings } from './defaults';

export type SettingsListener = (next: Settings, previous: Settings) => void;

/**
 * Drag-modifier rules beyond the schema:
 *  - macOS: a combo containing Control or Command makes AppKit turn the file
 *    drag into Link/Generic with no Copy, so every drop would be refused;
 *  - everywhere: the convert and tools combos must differ (order ignored).
 * Returns a developer-facing problem, or null.
 */
export function modifierProblem(settings: Settings, platform: NodeJS.Platform): string | null {
  const { convertModifiers, toolsModifiers } = settings.globalDrag;
  if (platform === 'darwin' && [...convertModifiers, ...toolsModifiers].some((key) => key === 'control' || key === 'command')) {
    return 'Control and Command cannot be drag modifiers on macOS';
  }
  const same = convertModifiers.length === toolsModifiers.length && convertModifiers.every((key) => toolsModifiers.includes(key));
  return same ? 'The convert and tools modifiers must differ' : null;
}

export interface SettingsStoreOptions {
  /** The OS's preferred languages, most preferred first: a first run picks the UI language from them. */
  readonly systemLanguages?: () => readonly string[];
}

/**
 * Persisted settings: `<userData>/settings.json`.
 *  - load: any version is passed through `migrateSettings` (gaps filled from
 *    this platform's defaults); a corrupt file (not JSON) is kept aside as
 *    settings.corrupt-<time>.json, an unreadable one (permissions, a folder in
 *    its place) as settings.unreadable-<time>.json, and defaults are used —
 *    `loadIssue` tells the app, which lets the user know. Never a crash.
 *  - no file (first run, `firstRun`): the platform defaults in the OS language,
 *    welcome window still to show; nothing is written until the first change.
 *  - update: `applySettingsPatch` (deep merge + schema validation); invalid
 *    patches are rejected with INVALID_OPTIONS and nothing changes.
 *  - reset: the defaults of this computer; the language and the first-run state stay.
 *  - save: atomic (temp file + rename), serialized.
 */
export class SettingsStore {
  readonly file: string;
  /** Set by load() when settings.json could not be used and defaults apply. */
  loadIssue: StoreLoadIssue | null = null;
  /** Set by load() when there was no settings file yet (first run). */
  firstRun = false;
  private current: Settings = DEFAULT_SETTINGS;
  private readonly listeners = new Set<SettingsListener>();
  private readonly writes = new SerialQueue();

  constructor(
    dir: string,
    private readonly log: Logger = silentLogger,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly options: SettingsStoreOptions = {},
  ) {
    this.file = join(dir, 'settings.json');
  }

  /** Defaults of this computer: this platform's (Windows: Ctrl+Shift tools combo) in the OS language. */
  defaults(): Settings {
    let languages: readonly string[] = [];
    try {
      languages = this.options.systemLanguages?.() ?? [];
    } catch (error) {
      this.log.warn('could not read the system languages', { error: describeError(error) });
    }
    return firstRunSettings(this.platform, languages);
  }

  /** Stored modifiers that break the rules fall back to the defaults (the rest of the file is kept). */
  private repairModifiers(settings: Settings): Settings {
    if (modifierProblem(settings, this.platform) === null) return settings;
    this.log.warn('drag modifiers not usable on this platform; using the defaults');
    const defaults = defaultSettingsFor(this.platform);
    return {
      ...settings,
      globalDrag: {
        ...settings.globalDrag,
        convertModifiers: defaults.globalDrag.convertModifiers,
        toolsModifiers: defaults.globalDrag.toolsModifiers,
      },
    };
  }

  get(): Settings {
    return this.current;
  }

  async load(): Promise<Settings> {
    this.loadIssue = null;
    this.firstRun = false;
    let raw: Awaited<ReturnType<typeof readJson>>;
    try {
      raw = await readJson(this.file);
    } catch (error) {
      // Kept aside like a corrupt file: the next save must not replace something that could not be read.
      this.log.warn('settings unreadable; kept aside and reset to defaults', { error: describeError(error) });
      return this.resetAside('unreadable');
    }
    if (raw.kind === 'missing') {
      this.firstRun = true;
      this.current = this.defaults();
      return this.current;
    }
    // Not JSON, or JSON that is no settings object at all (null, an array, a number…).
    if (raw.kind === 'corrupt' || typeof raw.value !== 'object' || raw.value === null || Array.isArray(raw.value)) {
      this.log.warn('settings file was corrupt; kept aside and reset to defaults');
      return this.resetAside('corrupt');
    }
    this.current = this.repairModifiers(migrateSettings(raw.value, existingFileDefaults(this.platform)));
    if (JSON.stringify(this.current) !== JSON.stringify(raw.value)) {
      this.log.info('settings migrated or repaired');
      await this.persist(this.current);
    }
    return this.current;
  }

  /** Validate and apply a renderer patch. Throws OrbitError(INVALID_OPTIONS) for invalid patches. */
  async update(patch: unknown): Promise<Settings> {
    const next = applySettingsPatch(this.current, patch);
    if (next === null) throw new OrbitError('INVALID_OPTIONS', 'Invalid settings patch');
    return this.commit(next);
  }

  /**
   * Settings › General › Reset: every setting back to the defaults of this
   * computer. The language stays (the user picked or confirmed it) and so does
   * the first-run state (no welcome window again). Listeners see the change
   * like any other (the login item is removed, the helper reconfigured…).
   */
  reset(): Promise<Settings> {
    const { locale, onboarding } = this.current;
    return this.commit({ ...this.defaults(), locale, onboarding });
  }

  private async commit(next: Settings): Promise<Settings> {
    const problem = modifierProblem(next, this.platform);
    if (problem !== null) throw new OrbitError('INVALID_OPTIONS', problem);
    const previous = this.current;
    if (JSON.stringify(next) === JSON.stringify(previous)) return previous;
    this.current = next;
    await this.persist(next);
    for (const listener of this.listeners) {
      try {
        listener(next, previous);
      } catch (error) {
        this.log.error('settings listener failed', { error: describeError(error) });
      }
    }
    return next;
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when pending writes are on disk. */
  flush(): Promise<void> {
    return this.writes.idle();
  }

  /**
   * Defaults after an unusable file; written only once the old file is out of the way. Its owner already
   * used OrbitDrop (and is told about the reset): no welcome window.
   */
  private async resetAside(reason: UnusableReason): Promise<Settings> {
    const backup = await moveAside(this.file, reason);
    this.loadIssue = { reason, backup };
    const defaults = this.defaults();
    this.current = { ...defaults, onboarding: { ...defaults.onboarding, welcomeDone: true } };
    if (backup !== null) await this.persist(this.current);
    return this.current;
  }

  private persist(settings: Settings): Promise<void> {
    return this.writes
      .run(() => writeJsonAtomic(this.file, settings))
      .catch((error: unknown) => {
        // Keep running with the in-memory settings; the next change retries the write.
        this.log.error('settings save failed', { error: describeError(error) });
      });
  }
}
