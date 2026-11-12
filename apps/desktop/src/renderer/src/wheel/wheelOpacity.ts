import { clampWheelOpacity } from '@orbitdrop/contracts';
import type { CSSProperties } from 'react';
import type { Appearance } from '../theme/appearance';

/** High contrast and forced colours draw the wheel opaque whatever the wheel-opacity setting says. */
export function wheelAlwaysOpaque(appearance: Pick<Appearance, 'theme' | 'forcedColors'>): boolean {
  return appearance.forcedColors || appearance.theme === 'highContrast' || appearance.theme === 'highContrastDark';
}

/**
 * Factor (0.4–1) for the React wheel's background — the CSS custom property `--wheel-opacity` that
 * wheel.css applies to the disc and sector fills and the disc shadow. It is the renderer's side of
 * contracts `wheelTokens`, which scales the same colours for the native wheel: the wheel-opacity
 * setting (percent) in the light and dark themes, 1 in high contrast and with forced colours.
 */
export function wheelOpacityFactor(percent: number, appearance: Pick<Appearance, 'theme' | 'forcedColors'>): number {
  return wheelAlwaysOpaque(appearance) ? 1 : clampWheelOpacity(percent) / 100;
}

/** Inline style that sets `--wheel-opacity` for a wheel (or the settings preview) and everything in it. */
export function wheelOpacityStyle(factor: number): CSSProperties {
  return { '--wheel-opacity': String(factor) } as CSSProperties;
}
