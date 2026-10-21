import type { ErrorCode, Locale, OrbitErrorInfo, WarningCode } from '@orbitdrop/contracts';
import enErrors from '../../../shared/locales/en/errors.json';
import enUi from '../../../shared/locales/en/ui.json';
import koErrors from '../../../shared/locales/ko/errors.json';
import koUi from '../../../shared/locales/ko/ui.json';

/**
 * Message catalogs. Korean is the source of truth for the key set: `UiKey` is
 * derived from ko/ui.json, and the typed assignments below make `tsc` fail if
 * English misses a key or if any ErrorCode / WarningCode lacks a message.
 */
export type UiKey = keyof typeof koUi;
export type ErrorMessageKey = `error.${ErrorCode}` | `warning.${WarningCode}`;
export type MessageKey = UiKey | ErrorMessageKey;

/** Keys with plural forms: `<base>.one` / `<base>.other`. */
export type PluralBase = UiKey extends infer K ? (K extends `${infer B}.other` ? B : never) : never;

const ko: Record<MessageKey, string> = { ...(koUi satisfies Record<UiKey, string>), ...(koErrors satisfies Record<ErrorMessageKey, string>) };
const en: Record<MessageKey, string> = { ...(enUi satisfies Record<UiKey, string>), ...(enErrors satisfies Record<ErrorMessageKey, string>) };

export const CATALOGS: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { ko, en };

export type TParams = Readonly<Record<string, string | number>>;

/** Replace `{name}` placeholders. Unknown placeholders are left as-is so missing params are visible in development. */
export function interpolate(template: string, params?: TParams): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export interface Translator {
  readonly locale: Locale;
  (key: MessageKey, params?: TParams): string;
  /** Plural-aware lookup; `count` is also available as `{count}`. */
  plural(base: PluralBase, count: number, params?: TParams): string;
  /** Localized message for an error (falls back to INTERNAL for unknown codes). */
  error(error: Pick<OrbitErrorInfo, 'code'> | ErrorCode): string;
  warning(code: WarningCode): string;
  /** Pick the localized variant of a contracts LocalizedText. */
  text(value: { readonly ko: string; readonly en: string }): string;
}

export function createTranslator(locale: Locale): Translator {
  const catalog = CATALOGS[locale] ?? CATALOGS.ko;
  const lookup = (key: MessageKey): string => catalog[key] ?? CATALOGS.ko[key] ?? key;
  const t = ((key: MessageKey, params?: TParams) => interpolate(lookup(key), params)) as Translator;
  Object.defineProperty(t, 'locale', { value: locale });
  t.plural = (base, count, params) => {
    const form: 'one' | 'other' = count === 1 ? 'one' : 'other';
    return interpolate(lookup(`${base}.${form}` as UiKey), { count, ...params });
  };
  t.error = (error) => {
    const code = typeof error === 'string' ? error : error.code;
    const key = `error.${code}` as ErrorMessageKey;
    return catalog[key] ?? catalog['error.INTERNAL'];
  };
  t.warning = (code) => catalog[`warning.${code}`] ?? code;
  t.text = (value) => value[locale] ?? value.ko;
  return t;
}
