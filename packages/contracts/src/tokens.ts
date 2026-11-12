import tokens from '../design-tokens.json';
import { WHEEL_OPACITY_RANGE } from './geometry';
import type { WheelTokens } from './helper-protocol';

export type ThemeName = 'light' | 'dark' | 'highContrast';
export type ColorTokens = (typeof tokens.color)['light'];

export const DESIGN_TOKENS = tokens;

export function colorTokens(theme: ThemeName): ColorTokens {
  return tokens.color[theme];
}

/** A wheel opacity in percent made whole and kept inside WHEEL_OPACITY_RANGE; anything that is not a number counts as 100. */
export function clampWheelOpacity(percent: number): number {
  if (!Number.isFinite(percent)) return WHEEL_OPACITY_RANGE.max;
  return Math.min(WHEEL_OPACITY_RANGE.max, Math.max(WHEEL_OPACITY_RANGE.min, Math.round(percent)));
}

/**
 * `#RRGGBB[AA]` with its alpha multiplied by `factor` (0–1), as `#RRGGBBAA`. A colour that was visible
 * stays visible (alpha at least 1/255: the native wheels hit-test by alpha), a transparent one stays
 * transparent, and a factor of 1 or more returns the colour unchanged.
 */
export function scaleAlpha(hex: string, factor: number): string {
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
  if (!match?.[1]) throw new Error(`not a #RRGGBB[AA] colour: ${hex}`);
  if (!(factor < 1)) return hex;
  const alpha = match[2] === undefined ? 255 : Number.parseInt(match[2], 16);
  const scaled = alpha === 0 ? 0 : Math.max(1, Math.round(alpha * Math.max(0, factor)));
  return `#${match[1]}${scaled.toString(16).padStart(2, '0')}`.toUpperCase();
}

/**
 * Wheel subset sent to the native helper in the configure message.
 *
 * `opacityPercent` (settings.globalDrag.wheelOpacity, WHEEL_OPACITY_RANGE) scales the alpha of the
 * wheel's background only — wheelDisc, sector, sectorHover, sectorDisabled and wheelShadow — so what
 * is behind the wheel shows through. Text and icons, the highlighted drop target (sectorActive), the
 * ring and the capsule (it carries text) keep their colours, and the high-contrast theme is always
 * opaque. design-tokens.json (and the helpers' built-in copies of it) stay the 100 % values.
 */
export function wheelTokens(theme: ThemeName, reduceMotion: boolean, opacityPercent = 100): WheelTokens {
  const c = tokens.color[theme];
  const factor = theme === 'highContrast' ? 1 : clampWheelOpacity(opacityPercent) / 100;
  const background = (hex: string): string => scaleAlpha(hex, factor);
  return {
    wheelDisc: background(c.wheelDisc),
    wheelRing: c.wheelRing,
    wheelShadow: background(c.wheelShadow),
    sector: background(c.sector),
    sectorHover: background(c.sectorHover),
    sectorText: c.sectorText,
    sectorIcon: c.sectorIcon,
    sectorDisabled: background(c.sectorDisabled),
    sectorDisabledText: c.sectorDisabledText,
    sectorActive: c.sectorActive,
    sectorActiveText: c.sectorActiveText,
    capsule: c.capsule,
    capsuleText: c.capsuleText,
    capsuleReject: c.capsuleReject,
    labelSize: tokens.font.wheelLabelSize,
    labelWeight: tokens.font.wheelLabelWeight,
    iconSize: tokens.font.wheelIconSize,
    capsuleTextSize: tokens.font.capsuleSize,
    appearMs: reduceMotion ? 0 : tokens.motion.wheelAppearMs,
    disappearMs: reduceMotion ? 0 : tokens.motion.wheelDisappearMs,
  };
}
