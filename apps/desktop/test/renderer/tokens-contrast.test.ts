import { DESIGN_TOKENS } from '@orbitdrop/contracts';
import { describe, expect, it } from 'vitest';

/** WCAG 2.x relative luminance of an opaque colour (#RRGGBB or #RRGGBBFF). */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})(ff)?$/i.exec(hex);
  if (!match?.[1]) throw new Error(`not an opaque colour: ${hex}`);
  const n = Number.parseInt(match[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1–21). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SETS = DESIGN_TOKENS.color;
type ColorName = keyof typeof SETS.light;

/** [foreground, background, minimum ratio] for the pairs the UI actually draws. */
const HIGH_CONTRAST_PAIRS: readonly (readonly [ColorName, ColorName, number])[] = [
  // Body and secondary text: AAA everywhere.
  ['text', 'windowBg', 7],
  ['text', 'surface', 7],
  ['text', 'surfaceMuted', 7],
  ['textMuted', 'windowBg', 7],
  ['textMuted', 'surface', 7],
  ['textMuted', 'surfaceMuted', 7],
  // Labels on the accent: primary buttons (normal, hover, pressed), selected segments, the active sector.
  ['accentText', 'accent', 4.5],
  ['accentText', 'accentHover', 4.5],
  ['accentText', 'accentPressed', 4.5],
  ['sectorActiveText', 'sectorActive', 4.5],
  // Wheel labels, the highlighted disabled sector and the capsule.
  ['sectorText', 'sector', 7],
  ['sectorIcon', 'sector', 7],
  ['sectorText', 'sectorHover', 7],
  ['sectorDisabledText', 'sectorDisabled', 4.5],
  ['sectorDisabledText', 'sectorHover', 4.5],
  ['capsuleText', 'capsule', 7],
  ['capsuleText', 'capsuleReject', 4.5],
  // Status text.
  ['danger', 'windowBg', 7],
  ['success', 'windowBg', 7],
  ['warningText', 'warningBg', 7],
  // Non-text contrast (WCAG 1.4.11): control borders, focus ring, sector outlines, accent fills.
  ['border', 'windowBg', 3],
  ['border', 'surface', 3],
  ['focusRing', 'windowBg', 3],
  ['focusRing', 'surfaceMuted', 3],
  ['wheelRing', 'wheelDisc', 3],
  ['wheelRing', 'sector', 3],
  ['accent', 'windowBg', 3],
  ['warningBorder', 'warningBg', 3],
];

describe('design token colour sets', () => {
  it('every set defines exactly the same colour names', () => {
    const names = Object.keys(SETS.light).sort();
    for (const [theme, colors] of Object.entries(SETS)) expect(Object.keys(colors).sort(), theme).toEqual(names);
  });

  it.each(['highContrast', 'highContrastDark'] as const)('%s meets its contrast targets', (theme) => {
    const colors = SETS[theme];
    const failures = HIGH_CONTRAST_PAIRS.map(([fg, bg, min]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(colors[fg], colors[bg]), min })).filter(
      (row) => row.ratio < row.min,
    );
    expect(failures).toEqual([]);
  });

  it('highContrastDark is white on black, with dark text on its accent', () => {
    const colors = SETS.highContrastDark;
    expect(luminance(colors.windowBg)).toBeLessThan(0.01);
    expect(luminance(colors.text)).toBeGreaterThan(0.95);
    expect(luminance(colors.accentText)).toBeLessThan(luminance(colors.accent));
    expect(contrast(colors.text, colors.windowBg)).toBeCloseTo(21, 5);
  });

  it('the contrast helper matches known WCAG values', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(() => luminance('#00000080')).toThrow();
  });
});
