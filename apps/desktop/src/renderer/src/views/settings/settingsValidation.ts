import type { ModifierKey, Platform } from '@orbitdrop/contracts';

/**
 * Pure validation for the Settings window. The modifier combos must be valid
 * on their own (1–3 distinct keys; on macOS without Control/Command) and must
 * differ from each other as sets: ['shift'] vs ['alt', 'shift'] is fine (the
 * helper checks the exact combination), ['alt', 'shift'] vs ['shift', 'alt'] is
 * the same combo.
 */

/** Canonical display/storage order. */
export const MODIFIER_ORDER: readonly ModifierKey[] = ['shift', 'alt', 'control', 'command'];

export const MAX_MODIFIERS = 3;

export type ComboError = 'empty' | 'tooMany' | 'macUnsupported' | 'same';

/**
 * Keys that can't open the wheel on macOS: holding Control or Command during a
 * file drag makes AppKit offer Link/Generic instead of Copy, so the helper would
 * have to refuse every drop. Main rejects such combos on darwin too.
 */
export const MAC_UNSUPPORTED_MODIFIERS: readonly ModifierKey[] = ['control', 'command'];

export function isModifierSupported(key: ModifierKey, platform: Platform | undefined): boolean {
  return platform !== 'darwin' || !MAC_UNSUPPORTED_MODIFIERS.includes(key);
}

export interface ComboValidation {
  readonly convert: ComboError | null;
  readonly tools: ComboError | null;
  readonly valid: boolean;
}

/** Distinct keys in canonical order (unknown values are dropped). */
export function normalizeCombo(combo: readonly ModifierKey[]): ModifierKey[] {
  const set = new Set(combo);
  return MODIFIER_ORDER.filter((key) => set.has(key));
}

/** Same set of keys, ignoring order and duplicates. */
export function sameCombo(a: readonly ModifierKey[], b: readonly ModifierKey[]): boolean {
  const na = normalizeCombo(a);
  const nb = normalizeCombo(b);
  return na.length === nb.length && na.every((key, i) => key === nb[i]);
}

/** Add the key if missing, remove it if present; result in canonical order. */
export function toggleModifier(combo: readonly ModifierKey[], key: ModifierKey): ModifierKey[] {
  const normalized = normalizeCombo(combo);
  return normalized.includes(key) ? normalized.filter((k) => k !== key) : normalizeCombo([...normalized, key]);
}

function ownError(combo: readonly ModifierKey[], platform: Platform | undefined): ComboError | null {
  const keys = normalizeCombo(combo);
  if (keys.length === 0) return 'empty';
  if (keys.length > MAX_MODIFIERS) return 'tooMany';
  if (keys.some((key) => !isModifierSupported(key, platform))) return 'macUnsupported';
  return null;
}

/** `platform` enables the platform rules (macOS: no Control/Command); omit it to check only the generic rules. */
export function validateModifierCombos(convert: readonly ModifierKey[], tools: readonly ModifierKey[], platform?: Platform): ComboValidation {
  let convertError = ownError(convert, platform);
  let toolsError = ownError(tools, platform);
  if (convertError === null && toolsError === null && sameCombo(convert, tools)) {
    convertError = 'same';
    toolsError = 'same';
  }
  return { convert: convertError, tools: toolsError, valid: convertError === null && toolsError === null };
}

export type IntegerError = 'notInteger' | 'range';

/** Validate a whole number in [min, max] (numbers or typed text). */
export function validateIntegerInRange(value: number | string, min: number, max: number): IntegerError | null {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^-?\d+$/.test(text)) return 'notInteger';
  const n = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(n) || n < min || n > max) return 'range';
  return null;
}
