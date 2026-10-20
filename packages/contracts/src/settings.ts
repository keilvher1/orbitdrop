import { z } from 'zod';
import { COMPOSITION_LIMITS } from './composition';
import { WHEEL_DIAMETER_RANGE } from './geometry';
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
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({ version: SETTINGS_VERSION });

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
 * does not wipe the rest.
 */
export function migrateSettings(raw: unknown): Settings {
  if (!isRecord(raw)) return DEFAULT_SETTINGS;
  // Version 0 (pre-release) used the same shape without a version field.
  const candidate: Record<string, unknown> = { ...raw, version: SETTINGS_VERSION };
  const full = SettingsSchema.safeParse(candidate);
  if (full.success) return full.data;

  const result: Record<string, unknown> = { version: SETTINGS_VERSION };
  const shape = SettingsSchema.shape;
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    if (key === 'version' || !(key in candidate)) continue;
    const parsed = shape[key].safeParse(candidate[key]);
    if (parsed.success) result[key] = parsed.data;
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
