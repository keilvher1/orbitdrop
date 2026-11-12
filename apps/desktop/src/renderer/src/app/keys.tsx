import type { ModifierKey, Platform } from '@orbitdrop/contracts';
import { Fragment } from 'react';
import type { Translator } from '../i18n/catalog';
import { useEnv } from './env';
import './keys.css';

/**
 * Drag keys as the user's keyboard names them — Option on macOS; Alt, Ctrl and
 * the Windows key on Windows — in the order the OS writes shortcuts (Control,
 * Option/Alt, Shift, Command/Windows): "Option+Shift", "Ctrl+Shift".
 */
export const KEY_DISPLAY_ORDER: readonly ModifierKey[] = ['control', 'alt', 'shift', 'command'];

export function keyName(t: Translator, key: ModifierKey, platform: Platform): string {
  if (key === 'shift') return t('settings.key.shift');
  return t(`settings.key.${key}.${platform === 'darwin' ? 'mac' : 'pc'}`);
}

/** The combo's keys in display order. */
export function comboKeys(combo: readonly ModifierKey[]): ModifierKey[] {
  return KEY_DISPLAY_ORDER.filter((key) => combo.includes(key));
}

/** "Option+Shift" */
export function comboLabel(t: Translator, combo: readonly ModifierKey[], platform: Platform): string {
  return comboKeys(combo)
    .map((key) => keyName(t, key, platform))
    .join('+');
}

/** A combo as <kbd> keys joined by "+" (screen readers read "Option plus Shift"). */
export function KeyCombo({ combo }: { readonly combo: readonly ModifierKey[] }) {
  const { t, platform } = useEnv();
  return (
    <span className="key-combo">
      {comboKeys(combo).map((key, index) => (
        <Fragment key={key}>
          {index > 0 ? '+' : null}
          <kbd>{keyName(t, key, platform)}</kbd>
        </Fragment>
      ))}
    </span>
  );
}
