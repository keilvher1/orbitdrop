import type { ModifierKey } from '@orbitdrop/contracts';

/**
 * Pure validation for the Settings window. The modifier combos must be valid
 * on their own (1–3 distinct keys) and must differ from each other as sets:
 * ['shift'] vs ['alt', 'shift'] is fine (the helper checks the exact
 * combination), ['alt', 'shift'] vs ['shift', 'alt'] is the same combo.
 */

/** Canonical display/storage order. */
export const MODIFIER_ORDER: readonly ModifierKey[] = ['shift', 'alt', 'control', 'command'];

export const MAX_MODIFIERS = 3;

export type ComboError = 'empty' | 'tooMany' | 'same';

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

function ownError(combo: readonly ModifierKey[]): ComboError | null {
  const size = normalizeCombo(combo).length;
  if (size === 0) return 'empty';
  if (size > MAX_MODIFIERS) return 'tooMany';
  return null;
}

export function validateModifierCombos(convert: readonly ModifierKey[], tools: readonly ModifierKey[]): ComboValidation {
  let convertError = ownError(convert);
  let toolsError = ownError(tools);
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
