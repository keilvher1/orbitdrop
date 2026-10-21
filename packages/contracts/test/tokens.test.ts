import { describe, expect, it } from 'vitest';
import { DESIGN_TOKENS, type ThemeName } from '../src';

/** WCAG 2.x contrast ratio of two #RRGGBB[AA] colours (alpha ignored: both are drawn opaque here). */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const n = Number.parseInt(hex.slice(1, 7), 16);
    const lin = (c: number): number => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 0xff) + 0.0722 * lin(n & 0xff);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES: readonly ThemeName[] = ['light', 'dark', 'highContrast'];

describe('design token contrast (WCAG AA for text)', () => {
  // Labels are 13–15 px bold, which is not "large text": 4.5:1 applies.
  it.each(THEMES)('%s: text on its backgrounds reaches 4.5:1', (theme) => {
    const c = DESIGN_TOKENS.color[theme];
    const pairs: [string, string, string][] = [
      ['sectorActiveText on sectorActive', c.sectorActiveText, c.sectorActive],
      ['accentText on accent', c.accentText, c.accent],
      ['accentText on accentHover', c.accentText, c.accentHover],
      ['accentText on accentPressed', c.accentText, c.accentPressed],
      ['text on windowBg', c.text, c.windowBg],
      ['text on surface', c.text, c.surface],
      ['textMuted on surface', c.textMuted, c.surface],
      ['warningText on warningBg', c.warningText, c.warningBg],
      ['capsuleText on capsule', c.capsuleText, c.capsule],
    ];
    for (const [name, fg, bg] of pairs) expect(contrast(fg, bg), `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
  });

  it('measures known values', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#FFFFFF', '#D4441C')).toBeGreaterThan(4.5);
    expect(contrast('#FFFFFF', '#F2552C')).toBeLessThan(4.5);
  });
});
