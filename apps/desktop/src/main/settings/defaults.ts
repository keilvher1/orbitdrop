import { defaultSettingsFor, type Locale, type Settings } from '@orbitdrop/contracts';

/**
 * Defaults on this computer. Kept free of runtime Electron imports (tests):
 * index.ts / app.ts pass `app.getPreferredSystemLanguages()` in.
 *
 *  - first run (no settings.json yet): the platform defaults (Windows:
 *    Ctrl+Shift for the tools wheel), the OS language (Korean → ko, anything
 *    else → en) and the welcome window still to show;
 *  - a file that exists keeps its own locale; one written before the
 *    onboarding section existed belongs to an existing user — no welcome.
 */

/**
 * The UI language for the OS's preferred languages (most preferred first, BCP 47
 * such as "ko-KR", "en-US", "ko"): Korean → ko, any other language → en. An
 * empty list (unknown) keeps the app default, Korean.
 */
export function localeFromSystemLanguages(languages: readonly string[]): Locale {
  const first = languages.find((language) => typeof language === 'string' && language.trim() !== '');
  if (first === undefined) return 'ko';
  return /^ko(?:$|[-_])/i.test(first.trim()) ? 'ko' : 'en';
}

/** Settings of a first run: platform defaults in the OS language; welcome not shown yet. */
export function firstRunSettings(platform: NodeJS.Platform, languages: readonly string[]): Settings {
  const defaults = defaultSettingsFor(platform);
  return { ...defaults, locale: localeFromSystemLanguages(languages), onboarding: { ...defaults.onboarding, welcomeDone: false } };
}

/**
 * What fills the gaps of an existing settings file (and replaces sections that
 * fail validation): platform defaults; the onboarding section is absent only
 * in files written before it existed — their owner already used OrbitDrop.
 */
export function existingFileDefaults(platform: NodeJS.Platform): Settings {
  const defaults = defaultSettingsFor(platform);
  return { ...defaults, onboarding: { ...defaults.onboarding, welcomeDone: true } };
}
