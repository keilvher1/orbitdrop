import { DESIGN_TOKENS, type ThemeName } from '@orbitdrop/contracts';

/**
 * Turns packages/contracts/design-tokens.json into CSS custom properties.
 *   color.<theme>.<name>  → --c-<kebab-name>   (scoped to :root[data-theme="<theme>"])
 *   radius.<name>         → --radius-<name>
 *   space.<name>          → --space-<name>
 *   font.*, motion.*, editor.* → --font-*, --motion-*, --editor-*
 * The same JSON feeds the native helpers, so the wheel looks the same everywhere.
 */

/**
 * Colour sets the renderer styles: the contracts' ThemeName (what main and the
 * native helpers know) plus the renderer-only dark high-contrast set
 * (color.highContrastDark: white on black), used when high contrast applies
 * while the OS is in dark mode. The native wheel keeps color.highContrast.
 */
export type RendererTheme = ThemeName | 'highContrastDark';

export const THEMES: readonly RendererTheme[] = ['light', 'dark', 'highContrast', 'highContrastDark'];

/** Themes drawn light-on-dark (CSS color-scheme: dark). */
export function isDarkTheme(theme: RendererTheme): boolean {
  return theme === 'dark' || theme === 'highContrastDark';
}

export function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

export function colorVar(token: string): string {
  return `--c-${kebab(token)}`;
}

function px(value: number): string {
  return `${value}px`;
}

export function buildTokensCss(): string {
  const blocks: string[] = [];
  for (const theme of THEMES) {
    const colors = DESIGN_TOKENS.color[theme] as Record<string, string>;
    const decls = Object.entries(colors).map(([name, value]) => `${colorVar(name)}:${value};`);
    blocks.push(`:root[data-theme="${theme}"]{${decls.join('')}}`);
  }
  const { font, radius, space, motion, editor } = DESIGN_TOKENS;
  const shared: string[] = [
    ...Object.entries(radius).map(([k, v]) => `--radius-${kebab(k)}:${px(v)};`),
    ...Object.entries(space).map(([k, v]) => `--space-${kebab(k)}:${px(v)};`),
    `--font-ui-size:${px(font.uiSize)};`,
    `--font-title-size:${px(font.titleSize)};`,
    `--font-wheel-label-size:${px(font.wheelLabelSize)};`,
    `--font-wheel-label-weight:${font.wheelLabelWeight};`,
    `--font-wheel-label-tracking:${px(font.wheelLabelTracking)};`,
    `--font-capsule-size:${px(font.capsuleSize)};`,
    `--font-capsule-weight:${font.capsuleWeight};`,
    `--font-family-mac:${font.familyMac};`,
    `--font-family-win:${font.familyWin};`,
    `--motion-wheel-appear:${motion.wheelAppearMs}ms;`,
    `--motion-wheel-disappear:${motion.wheelDisappearMs}ms;`,
    `--motion-sector:${motion.sectorHighlightMs}ms;`,
    `--motion-easing:${motion.easing};`,
    `--editor-min-width:${px(editor.minWidth)};`,
    `--editor-width:${px(editor.defaultWidth)};`,
    `--editor-max-width:${px(editor.maxWidth)};`,
  ];
  blocks.push(`:root{${shared.join('')}}`);
  // Reduced motion zeroes every duration token as well as transitions in CSS.
  blocks.push(
    ':root[data-reduce-motion="true"]{--motion-wheel-appear:0ms;--motion-wheel-disappear:0ms;--motion-sector:0ms;}',
  );
  return blocks.join('\n');
}

const STYLE_ID = 'orbit-design-tokens';

export function ensureTokenStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = buildTokensCss();
  doc.head.prepend(style);
}
