import {
  DEFAULT_WHEEL_GEOMETRY,
  HELPER_PROTOCOL_VERSION,
  HelperConfigureSchema,
  wheelTokens,
  type CapabilitySnapshot,
  type HelperConfigureMessage,
  type Settings,
  type ThemeName,
  type WheelSector,
} from '@orbitdrop/contracts';
import { buildHelperMenus, helperExtensionMap } from '@orbitdrop/core';

export interface HelperStrings {
  readonly dropHint: string;
  readonly unsupported: string;
  readonly multiFileUnsupported: string;
  readonly fileCount: string;
}

export interface ConfigureInputs {
  readonly settings: Settings;
  readonly snapshot: CapabilitySnapshot;
  readonly theme: ThemeName;
  readonly reduceMotion: boolean;
  readonly highContrast: boolean;
  readonly strings: HelperStrings;
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`);

function sector(s: WheelSector): WheelSector {
  return {
    actionId: s.actionId,
    label: clip(s.label, 32),
    icon: s.icon,
    enabled: s.enabled,
    ...(s.reason !== undefined ? { reason: clip(s.reason, 120) } : {}),
    batch: s.batch,
  };
}

/**
 * The `configure` message for the native helper: everything it needs to draw
 * and hit-test the wheel, decided by main (settings, capability-filtered
 * menus, tokens, localized strings). Validated against the protocol schema.
 */
export function buildConfigureMessage(inputs: ConfigureInputs): HelperConfigureMessage {
  const { settings, snapshot } = inputs;
  const locale = settings.locale;
  const message: HelperConfigureMessage = {
    v: HELPER_PROTOCOL_VERSION,
    type: 'configure',
    enabled: settings.globalDrag.enabled,
    locale,
    geometry: { ...DEFAULT_WHEEL_GEOMETRY, diameter: settings.globalDrag.wheelDiameter },
    tokens: wheelTokens(inputs.theme, inputs.reduceMotion),
    reduceMotion: inputs.reduceMotion,
    highContrast: inputs.highContrast,
    modifiers: { convert: [...settings.globalDrag.convertModifiers], tools: [...settings.globalDrag.toolsModifiers] },
    extensions: helperExtensionMap(snapshot),
    menus: buildHelperMenus(snapshot, locale).map((menu) => ({
      key: menu.key,
      convert: menu.convert.map(sector),
      tools: menu.tools.map(sector),
    })),
    strings: {
      dropHint: clip(inputs.strings.dropHint, 60),
      unsupported: clip(inputs.strings.unsupported, 60),
      multiFileUnsupported: clip(inputs.strings.multiFileUnsupported, 60),
      fileCount: clip(inputs.strings.fileCount, 60),
    },
  };
  return HelperConfigureSchema.parse(message) as HelperConfigureMessage;
}

export function resolveReduceMotion(setting: Settings['accessibility']['reduceMotion'], systemPrefersReduced: boolean): boolean {
  return setting === 'on' || (setting === 'system' && systemPrefersReduced);
}

export function resolveHighContrast(setting: Settings['accessibility']['highContrast'], systemHighContrast: boolean): boolean {
  return setting === 'on' || (setting === 'system' && systemHighContrast);
}

export function resolveTheme(highContrast: boolean, dark: boolean): ThemeName {
  if (highContrast) return 'highContrast';
  return dark ? 'dark' : 'light';
}
