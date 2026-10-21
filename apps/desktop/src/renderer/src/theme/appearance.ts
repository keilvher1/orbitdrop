import type { Platform, Settings } from '@orbitdrop/contracts';
import { useEffect, useMemo, useState } from 'react';
import { isDarkTheme, type RendererTheme } from './tokensCss';

/** OS-level appearance signals read from media queries. */
export interface MediaFlags {
  readonly dark: boolean;
  readonly moreContrast: boolean;
  readonly forcedColors: boolean;
  readonly reducedMotion: boolean;
}

export interface Appearance {
  readonly theme: RendererTheme;
  readonly reduceMotion: boolean;
  readonly forcedColors: boolean;
}

const QUERIES = {
  dark: '(prefers-color-scheme: dark)',
  moreContrast: '(prefers-contrast: more)',
  forcedColors: '(forced-colors: active)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
} as const satisfies Record<keyof MediaFlags, string>;

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

export function readMediaFlags(): MediaFlags {
  return {
    dark: matches(QUERIES.dark),
    moreContrast: matches(QUERIES.moreContrast),
    forcedColors: matches(QUERIES.forcedColors),
    reducedMotion: matches(QUERIES.reducedMotion),
  };
}

/**
 * Settings overrides win over the OS: 'on'/'off' force the behaviour,
 * 'system' follows the media queries. High contrast uses the dedicated token
 * sets, chosen by the OS colour scheme: highContrast (black on white) in light
 * mode, highContrastDark (white on black) in dark mode.
 */
export function resolveAppearance(accessibility: Settings['accessibility'], media: MediaFlags): Appearance {
  const highContrast =
    accessibility.highContrast === 'on' || (accessibility.highContrast === 'system' && (media.moreContrast || media.forcedColors));
  const reduceMotion = accessibility.reduceMotion === 'on' || (accessibility.reduceMotion === 'system' && media.reducedMotion);
  let theme: RendererTheme = media.dark ? 'dark' : 'light';
  if (highContrast) theme = media.dark ? 'highContrastDark' : 'highContrast';
  return { theme, reduceMotion, forcedColors: media.forcedColors };
}

export function applyAppearance(root: HTMLElement, appearance: Appearance, platform: Platform): void {
  root.dataset.theme = appearance.theme;
  root.dataset.reduceMotion = String(appearance.reduceMotion);
  root.dataset.forcedColors = String(appearance.forcedColors);
  root.dataset.platform = platform;
  root.style.colorScheme = isDarkTheme(appearance.theme) ? 'dark' : 'light';
}

/** Tracks media query changes and keeps <html> data attributes in sync. */
export function useAppearance(accessibility: Settings['accessibility'], platform: Platform): Appearance {
  const [media, setMedia] = useState<MediaFlags>(readMediaFlags);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const lists = Object.values(QUERIES).map((q) => window.matchMedia(q));
    const onChange = () => setMedia(readMediaFlags());
    for (const list of lists) list.addEventListener('change', onChange);
    return () => {
      for (const list of lists) list.removeEventListener('change', onChange);
    };
  }, []);

  const appearance = useMemo(
    () => resolveAppearance(accessibility, media),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the two override fields are the whole input
    [accessibility.highContrast, accessibility.reduceMotion, media],
  );
  useEffect(() => {
    applyAppearance(document.documentElement, appearance, platform);
  }, [appearance.theme, appearance.reduceMotion, appearance.forcedColors, platform]);
  return appearance;
}
