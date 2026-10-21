import type { OrbitApi, Platform, Settings, SettingsPatch } from '@orbitdrop/contracts';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createTranslator, type Translator } from '../i18n/catalog';
import { useAppearance, type Appearance } from '../theme/appearance';

/**
 * Everything a view needs from its surroundings. Views get the OrbitApi from
 * here (never from `window` directly) so tests and the dev harness can inject
 * a mock.
 */
export interface AppEnv {
  readonly orbit: OrbitApi;
  readonly platform: Platform;
  readonly settings: Settings;
  readonly updateSettings: (patch: SettingsPatch) => Promise<Settings>;
  readonly t: Translator;
  readonly appearance: Appearance;
}

const EnvContext = createContext<AppEnv | null>(null);

export function useEnv(): AppEnv {
  const env = useContext(EnvContext);
  if (env === null) throw new Error('useEnv() outside <EnvProvider>');
  return env;
}

export function useOrbit(): OrbitApi {
  return useEnv().orbit;
}

export function useT(): Translator {
  return useEnv().t;
}

export interface EnvProviderProps {
  readonly orbit: OrbitApi;
  readonly initialSettings: Settings;
  readonly children: ReactNode;
}

export function EnvProvider({ orbit, initialSettings, children }: EnvProviderProps) {
  const [settings, setSettings] = useState<Settings>(initialSettings);

  useEffect(() => orbit.onSettingsChanged((next) => setSettings(next)), [orbit]);

  const updateSettings = useCallback(
    async (patch: SettingsPatch) => {
      const next = await orbit.updateSettings(patch);
      setSettings(next);
      return next;
    },
    [orbit],
  );

  const platform = orbit.platform;
  const appearance = useAppearance(settings.accessibility, platform);
  const t = useMemo(() => createTranslator(settings.locale), [settings.locale]);

  useEffect(() => {
    document.documentElement.lang = settings.locale;
  }, [settings.locale]);

  const value = useMemo<AppEnv>(
    () => ({ orbit, platform, settings, updateSettings, t, appearance }),
    [orbit, platform, settings, updateSettings, t, appearance],
  );
  return <EnvContext.Provider value={value}>{children}</EnvContext.Provider>;
}
