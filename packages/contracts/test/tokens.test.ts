import { describe, expect, it } from 'vitest';
import { DESIGN_TOKENS, WHEEL_OPACITY_RANGE, WheelTokensSchema, clampWheelOpacity, scaleAlpha, wheelTokens, type ThemeName, type WheelTokens } from '../src';

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

describe('wheel opacity (wheelTokens)', () => {
  /** The background colours the setting scales; every other wheel token must stay as designed. */
  const BACKGROUND = ['wheelDisc', 'sector', 'sectorHover', 'sectorDisabled', 'wheelShadow'] as const;
  const alpha = (hex: string): number => (hex.length === 9 ? Number.parseInt(hex.slice(7), 16) : 255);

  it('scaleAlpha multiplies the alpha and keeps the colour', () => {
    expect(scaleAlpha('#FFF3E6B8', 0.7)).toBe('#FFF3E681'); // 184 × 0.7 = 128.8 → 129
    expect(scaleAlpha('#FCE4CCF2', 0.4)).toBe('#FCE4CC61'); // 242 × 0.4 = 96.8 → 97
    expect(scaleAlpha('#3B2A1E', 0.5)).toBe('#3B2A1E80'); // no alpha = opaque: 255 × 0.5 = 127.5 → 128
    expect(scaleAlpha('#7a2e0040', 0.55)).toBe('#7A2E0023'); // 64 × 0.55 = 35.2 → 35
  });

  it('scaleAlpha keeps visible colours visible and transparent ones transparent; 1 is a no-op', () => {
    expect(scaleAlpha('#00000001', 0.4)).toBe('#00000001');
    expect(scaleAlpha('#00000002', 0.01)).toBe('#00000001');
    expect(scaleAlpha('#00000000', 0.4)).toBe('#00000000');
    expect(scaleAlpha('#FFF3E6B8', 1)).toBe('#FFF3E6B8');
    expect(scaleAlpha('#3B2A1E', 1)).toBe('#3B2A1E');
    expect(scaleAlpha('#3B2A1E', Number.NaN)).toBe('#3B2A1E');
    expect(() => scaleAlpha('red', 0.5)).toThrow();
    expect(() => scaleAlpha('#FFF', 0.5)).toThrow();
  });

  it('clamps the percentage to WHEEL_OPACITY_RANGE (whole numbers; not a number = 100)', () => {
    expect(WHEEL_OPACITY_RANGE).toEqual({ min: 40, max: 100 });
    expect(clampWheelOpacity(70)).toBe(70);
    expect(clampWheelOpacity(10)).toBe(40);
    expect(clampWheelOpacity(-5)).toBe(40);
    expect(clampWheelOpacity(250)).toBe(100);
    expect(clampWheelOpacity(69.6)).toBe(70);
    expect(clampWheelOpacity(Number.NaN)).toBe(100);
    expect(clampWheelOpacity(Number.POSITIVE_INFINITY)).toBe(100);
  });

  it.each(['light', 'dark', 'highContrast'] as const)('%s at 100 %% (the default argument) is exactly design-tokens.json', (theme) => {
    const tokens = wheelTokens(theme, false);
    expect(wheelTokens(theme, false, 100)).toEqual(tokens);
    const c = DESIGN_TOKENS.color[theme] as Record<string, string>;
    for (const [name, value] of Object.entries(tokens)) if (typeof value === 'string') expect(value, name).toBe(c[name]);
  });

  it.each(['light', 'dark'] as const)('%s: only the background colours change, by the factor, with their RGB kept', (theme) => {
    const full = wheelTokens(theme, false) as unknown as Record<string, string | number>;
    for (const percent of [40, 55, 70, 85]) {
      const scaled = wheelTokens(theme, false, percent) as unknown as Record<string, string | number>;
      for (const [name, value] of Object.entries(full)) {
        if ((BACKGROUND as readonly string[]).includes(name)) {
          const hex = value as string;
          const out = scaled[name] as string;
          expect(out.slice(0, 7), `${theme} ${name} ${percent}`).toBe(hex.slice(0, 7).toUpperCase());
          expect(alpha(out), `${theme} ${name} ${percent}`).toBe(Math.max(1, Math.round((alpha(hex) * percent) / 100)));
        } else {
          // Text, icons, the highlighted sector, the ring and the capsule keep their colours; sizes and motion too.
          expect(scaled[name], `${theme} ${name} ${percent}`).toBe(value);
        }
      }
    }
  });

  it('high contrast always stays opaque', () => {
    for (const percent of [40, 55, 70, 85]) expect(wheelTokens('highContrast', false, percent)).toEqual(wheelTokens('highContrast', false));
    expect(alpha(wheelTokens('highContrast', true, 40).wheelDisc)).toBe(255);
  });

  it('out-of-range values behave like the nearest end of the range', () => {
    expect(wheelTokens('light', false, 0)).toEqual(wheelTokens('light', false, 40));
    expect(wheelTokens('dark', false, 39)).toEqual(wheelTokens('dark', false, 40));
    expect(wheelTokens('light', false, 101)).toEqual(wheelTokens('light', false));
    expect(wheelTokens('dark', false, Number.NaN)).toEqual(wheelTokens('dark', false));
    expect(wheelTokens('light', true, 70).appearMs).toBe(0); // reduce motion still applies
  });

  it('every opacity gives tokens the helper protocol accepts, with every visible colour still visible', () => {
    for (const theme of ['light', 'dark', 'highContrast'] as const) {
      for (let percent = WHEEL_OPACITY_RANGE.min; percent <= WHEEL_OPACITY_RANGE.max; percent += 1) {
        const tokens: WheelTokens = wheelTokens(theme, false, percent);
        expect(WheelTokensSchema.safeParse(tokens).success, `${theme} ${percent}`).toBe(true);
        for (const name of BACKGROUND) {
          if (alpha(DESIGN_TOKENS.color[theme][name]) > 0) expect(alpha(tokens[name]), `${theme} ${name} ${percent}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('the highlighted sector stays opaque while the sectors around it become see-through', () => {
    for (const theme of ['light', 'dark'] as const) {
      const tokens = wheelTokens(theme, false, WHEEL_OPACITY_RANGE.min);
      expect(alpha(tokens.sectorActive)).toBe(255);
      expect(alpha(tokens.sector)).toBeLessThan(255);
    }
  });
});
