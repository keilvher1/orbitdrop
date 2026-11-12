import { z } from 'zod';
import { ANALYSIS_LIMITS } from './analysis';
import { COMPOSITION_LIMITS } from './composition';
import { WHEEL_DIAMETER_RANGE, WHEEL_OPACITY_RANGE } from './geometry';
import { LocaleSchema, ModifierCombo, Quality } from './schemas';

/**
 * Persisted settings (app data folder, settings.json). Versioned; unknown or
 * older files are migrated by `migrateSettings`, invalid fields fall back to
 * defaults instead of crashing the app.
 */
export const SETTINGS_VERSION = 1 as const;

const GlobalDragSettings = z.strictObject({
  enabled: z.boolean().default(true),
  /** Held during a file drag to open the convert wheel. */
  convertModifiers: ModifierCombo.default(['shift']),
  /** Held during a file drag to open the tools wheel. 'alt' = Option on macOS. */
  toolsModifiers: ModifierCombo.default(['alt', 'shift']),
  wheelDiameter: z.number().int().min(WHEEL_DIAMETER_RANGE.min).max(WHEEL_DIAMETER_RANGE.max).default(360),
  /**
   * Opacity of the wheel's background in percent (added after 1.0.0; additive: files without it get
   * the default, SETTINGS_VERSION is unchanged). Lower lets the files behind the wheel show through;
   * labels, the highlighted sector and the capsule stay solid, high contrast stays opaque (wheelTokens).
   */
  wheelOpacity: z.number().int().min(WHEEL_OPACITY_RANGE.min).max(WHEEL_OPACITY_RANGE.max).default(70),
});

const PdfSettings = z.strictObject({
  dpi: z.union([z.literal(150), z.literal(300)]).default(300),
});

const OutputSettings = z.strictObject({
  /** 'source' = next to the original; 'ask' = ask for a folder every time. */
  location: z.enum(['source', 'ask']).default('source'),
  jpegQuality: Quality.default(90),
  webpQuality: Quality.default(85),
  avifQuality: Quality.default(60),
  heicQuality: Quality.default(70),
});

const BackgroundSettings = z.strictObject({
  maxEdge: z
    .number()
    .int()
    .min(COMPOSITION_LIMITS.maxEdge.min)
    .max(COMPOSITION_LIMITS.maxEdge.max)
    .default(COMPOSITION_LIMITS.maxEdge.default),
});

const ProcessingSettings = z.strictObject({
  /** Jobs running at the same time (each in an isolated worker process). */
  concurrency: z.number().int().min(1).max(4).default(2),
  timeoutSec: z.number().int().min(10).max(3600).default(600),
});

const AccessibilitySettings = z.strictObject({
  reduceMotion: z.enum(['system', 'on', 'off']).default('system'),
  highContrast: z.enum(['system', 'on', 'off']).default('system'),
});

/**
 * First-run state (added for the public release; not a preference). A file
 * written before this section existed belongs to someone who already used
 * OrbitDrop: main loads it with `welcomeDone: true` (no welcome window).
 */
const OnboardingSettings = z.strictObject({
  /** The welcome window was closed once (Help › 사용법 opens it again). */
  welcomeDone: z.boolean().default(false),
  /** macOS: the offer to move the app into Applications was shown (asked once). */
  moveToApplicationsAsked: z.boolean().default(false),
});

/**
 * Added for automatic updates (additive: files without it get the defaults, SETTINGS_VERSION is
 * unchanged). autoCheck: look for a new release on GitHub 60 s after launch and every 6 h; a check
 * the user starts (About, tray) works either way.
 */
const UpdateSettings = z.strictObject({
  autoCheck: z.boolean().default(true),
});

/**
 * Added for Claude analysis (additive: files without it get the defaults, SETTINGS_VERSION is
 * unchanged). Off until the user turns it on; the wheel offers it only once an API key is saved too.
 * The key itself is not a setting (main keeps it encrypted in its own file). instruction: an
 * optional standing request added to every analysis.
 */
const AnalysisSettings = z.strictObject({
  enabled: z.boolean().default(false),
  instruction: z.string().max(ANALYSIS_LIMITS.maxInstructionLength).default(''),
});

export const SettingsSchema = z.strictObject({
  version: z.literal(SETTINGS_VERSION),
  locale: LocaleSchema.default('ko'),
  globalDrag: GlobalDragSettings.prefault({}),
  pdf: PdfSettings.prefault({}),
  output: OutputSettings.prefault({}),
  background: BackgroundSettings.prefault({}),
  processing: ProcessingSettings.prefault({}),
  accessibility: AccessibilitySettings.prefault({}),
  /** Start at login. Off by default. */
  launchAtLogin: z.boolean().default(false),
  /** System notification when a job started from a drag finishes. */
  notifications: z.boolean().default(true),
  /** First-run state: welcome window, macOS move-to-Applications offer. */
  onboarding: OnboardingSettings.prefault({}),
  updates: UpdateSettings.prefault({}),
  /** Claude analysis (opt-in). */
  analysis: AnalysisSettings.prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({ version: SETTINGS_VERSION });

/**
 * Default tools combo on Windows: Ctrl+Shift. Alt+Shift (the macOS default,
 * Option+Shift) is also Windows' input-language hotkey, which Settings warns
 * about; the helper reads Ctrl with GetAsyncKeyState during an OLE drag like
 * the other modifiers and accepts the drop as Copy whatever keys are held.
 */
export const WINDOWS_TOOLS_MODIFIERS: readonly ['control', 'shift'] = ['control', 'shift'];

/** Defaults on a platform (first run, reset, repaired combos): Windows gets its own tools combo. */
export function defaultSettingsFor(platform: string): Settings {
  if (platform !== 'win32') return DEFAULT_SETTINGS;
  return { ...DEFAULT_SETTINGS, globalDrag: { ...DEFAULT_SETTINGS.globalDrag, toolsModifiers: [...WINDOWS_TOOLS_MODIFIERS] } };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type SettingsPatch = DeepPartial<Omit<Settings, 'version'>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(base[key], value);
  return out;
}

/**
 * Validate a raw settings object of any version. Fields that fail validation
 * are reset to their defaults one section at a time, so a single bad value
 * does not wipe the rest. `defaults` fills what the file does not have and
 * replaces sections that fail (default: DEFAULT_SETTINGS; main passes the
 * defaults of its platform — see defaultSettingsFor).
 */
export function migrateSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  if (!isRecord(raw)) return defaults;
  // Version 0 (pre-release) used the same shape without a version field.
  const candidate = deepMerge(defaults, { ...raw, version: SETTINGS_VERSION }) as Record<string, unknown>;
  const full = SettingsSchema.safeParse(candidate);
  if (full.success) return full.data;

  const result: Record<string, unknown> = { version: SETTINGS_VERSION };
  const shape = SettingsSchema.shape;
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    if (key === 'version') continue;
    const parsed = shape[key].safeParse(candidate[key]);
    result[key] = parsed.success ? parsed.data : defaults[key];
  }
  return SettingsSchema.parse(result);
}

/** Apply a renderer patch; returns null if the result is invalid. */
export function applySettingsPatch(current: Settings, patch: unknown): Settings | null {
  if (!isRecord(patch)) return null;
  const { version: _ignored, ...rest } = patch;
  const merged = deepMerge(current, rest);
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : null;
}
