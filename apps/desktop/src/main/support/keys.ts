import type { ModifierKey, Settings } from '@orbitdrop/contracts';
import type { MainStringKey, Translate } from '../i18n';

/**
 * Key names as the user's keyboard says them (Option on macOS, Alt and Ctrl
 * on Windows), in the order the OS writes shortcuts: Control, Option/Alt,
 * Shift, Command/Windows — "Option+Shift", "Ctrl+Shift".
 */
const DISPLAY_ORDER: readonly ModifierKey[] = ['control', 'alt', 'shift', 'command'];

function keyName(key: ModifierKey, platform: NodeJS.Platform, t: Translate): string {
  if (key === 'shift') return t('help.key.shift');
  return t(`help.key.${key}.${platform === 'darwin' ? 'mac' : 'pc'}` as MainStringKey);
}

export function comboText(combo: readonly ModifierKey[], platform: NodeJS.Platform, t: Translate): string {
  return DISPLAY_ORDER.filter((key) => combo.includes(key))
    .map((key) => keyName(key, platform, t))
    .join('+');
}

/** Tray / menu-bar tooltip: the drag keys when global drag is on. */
export function trayTooltip(settings: Settings, platform: NodeJS.Platform, t: Translate): string {
  if (!settings.globalDrag.enabled) return t('tray.tooltip');
  return t('help.tooltip', {
    convert: comboText(settings.globalDrag.convertModifiers, platform, t),
    tools: comboText(settings.globalDrag.toolsModifiers, platform, t),
  });
}
