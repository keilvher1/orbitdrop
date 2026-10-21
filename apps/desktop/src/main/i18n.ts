import type { ErrorCode, Locale } from '@orbitdrop/contracts';
import en from '../shared/locales/en/main.json';
import ko from '../shared/locales/ko/main.json';

/**
 * Strings used by the main process (tray, dialogs, notifications, helper
 * wheel texts). Korean is the default; English is the fallback for any key a
 * table might miss at runtime.
 */
export type MainStringKey = keyof typeof ko;

const KO: Readonly<Record<MainStringKey, string>> = ko;
// Compile-time check: the English table has every key of the Korean one.
const EN: Readonly<Record<MainStringKey, string>> = en;

const TABLES: Readonly<Record<Locale, Readonly<Record<MainStringKey, string>>>> = { ko: KO, en: EN };

export type Vars = Readonly<Record<string, string | number>>;

export function t(locale: Locale, key: MainStringKey, vars?: Vars): string {
  const template = TABLES[locale]?.[key] ?? EN[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function errorText(locale: Locale, code: ErrorCode): string {
  const key = `error.${code}` as MainStringKey;
  return key in KO ? t(locale, key) : t(locale, 'error.INTERNAL');
}

/** Translator bound to a locale getter (the locale can change at runtime). */
export type Translate = (key: MainStringKey, vars?: Vars) => string;

export function bindTranslate(locale: () => Locale): Translate {
  return (key, vars) => t(locale(), key, vars);
}
