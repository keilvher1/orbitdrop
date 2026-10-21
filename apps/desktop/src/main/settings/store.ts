import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, OrbitError, applySettingsPatch, migrateSettings, type Settings } from '@orbitdrop/contracts';
import { describeError, silentLogger, type Logger } from '../log';
import { SerialQueue, readJson, writeJsonAtomic } from '../util/atomic-json';

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

/**
 * Persisted settings: `<userData>/settings.json`.
 *  - load: any version is passed through `migrateSettings`; a corrupt file is
 *    kept aside as settings.corrupt-<time>.json and defaults are used.
 *  - update: `applySettingsPatch` (deep merge + schema validation); invalid
 *    patches are rejected with INVALID_OPTIONS and nothing changes.
 *  - save: atomic (temp file + rename), serialized.
 */
export class SettingsStore {
  readonly file: string;
  private current: Settings = DEFAULT_SETTINGS;
  private readonly listeners = new Set<SettingsListener>();
  private readonly writes = new SerialQueue();

  constructor(
    dir: string,
    private readonly log: Logger = silentLogger,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.file = join(dir, 'settings.json');
  }

  /** Stored modifiers that break the rules fall back to the defaults (the rest of the file is kept). */
  private repairModifiers(settings: Settings): Settings {
    if (modifierProblem(settings, this.platform) === null) return settings;
    this.log.warn('drag modifiers not usable on this platform; using the defaults');
    return {
      ...settings,
      globalDrag: {
        ...settings.globalDrag,
        convertModifiers: DEFAULT_SETTINGS.globalDrag.convertModifiers,
        toolsModifiers: DEFAULT_SETTINGS.globalDrag.toolsModifiers,
      },
    };
  }

  get(): Settings {
    return this.current;
  }

  async load(): Promise<Settings> {
    let raw: Awaited<ReturnType<typeof readJson>>;
    try {
      raw = await readJson(this.file);
    } catch (error) {
      this.log.warn('settings unreadable; using defaults', { error: describeError(error) });
      this.current = DEFAULT_SETTINGS;
      return this.current;
    }
    if (raw.kind === 'missing') {
      this.current = DEFAULT_SETTINGS;
      return this.current;
    }
    if (raw.kind === 'corrupt') {
      const aside = join(this.file, '..', `settings.corrupt-${Date.now()}.json`);
      await rename(this.file, aside).catch(() => undefined);
      this.log.warn('settings file was corrupt; kept aside and reset to defaults');
      this.current = DEFAULT_SETTINGS;
      await this.persist(this.current);
      return this.current;
    }
    this.current = this.repairModifiers(migrateSettings(raw.value));
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

  private persist(settings: Settings): Promise<void> {
    return this.writes
      .run(() => writeJsonAtomic(this.file, settings))
      .catch((error: unknown) => {
        // Keep running with the in-memory settings; the next change retries the write.
        this.log.error('settings save failed', { error: describeError(error) });
      });
  }
}
