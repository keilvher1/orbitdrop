import tokens from '../design-tokens.json';
import type { WheelTokens } from './helper-protocol';

export type ThemeName = 'light' | 'dark' | 'highContrast';
export type ColorTokens = (typeof tokens.color)['light'];

export const DESIGN_TOKENS = tokens;

export function colorTokens(theme: ThemeName): ColorTokens {
  return tokens.color[theme];
}

/** Wheel subset sent to the native helper in the configure message. */
export function wheelTokens(theme: ThemeName, reduceMotion: boolean): WheelTokens {
  const c = tokens.color[theme];
  return {
    wheelDisc: c.wheelDisc,
    wheelRing: c.wheelRing,
    wheelShadow: c.wheelShadow,
    sector: c.sector,
    sectorHover: c.sectorHover,
    sectorText: c.sectorText,
    sectorIcon: c.sectorIcon,
    sectorDisabled: c.sectorDisabled,
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
