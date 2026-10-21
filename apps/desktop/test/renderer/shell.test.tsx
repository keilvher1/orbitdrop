// @vitest-environment jsdom
import './setup';
import { DEFAULT_SETTINGS, DESIGN_TOKENS } from '@orbitdrop/contracts';
import { describe, expect, it } from 'vitest';
import { installDropGuard } from '../../src/renderer/src/app/bootstrap';
import { asErrorInfo } from '../../src/renderer/src/app/errors';
import { applyAppearance, resolveAppearance, type MediaFlags } from '../../src/renderer/src/theme/appearance';
import { buildTokensCss, colorVar } from '../../src/renderer/src/theme/tokensCss';

const media = (over: Partial<MediaFlags> = {}): MediaFlags => ({ dark: false, moreContrast: false, forcedColors: false, reducedMotion: false, ...over });
const a11y = (reduceMotion: 'system' | 'on' | 'off', highContrast: 'system' | 'on' | 'off') => ({ reduceMotion, highContrast });

describe('appearance', () => {
  it('follows the OS by default', () => {
    expect(resolveAppearance(DEFAULT_SETTINGS.accessibility, media())).toEqual({ theme: 'light', reduceMotion: false, forcedColors: false });
    expect(resolveAppearance(DEFAULT_SETTINGS.accessibility, media({ dark: true })).theme).toBe('dark');
    expect(resolveAppearance(DEFAULT_SETTINGS.accessibility, media({ moreContrast: true })).theme).toBe('highContrast');
    expect(resolveAppearance(DEFAULT_SETTINGS.accessibility, media({ forcedColors: true }))).toMatchObject({ theme: 'highContrast', forcedColors: true });
    expect(resolveAppearance(DEFAULT_SETTINGS.accessibility, media({ reducedMotion: true })).reduceMotion).toBe(true);
  });

  it('settings overrides win over the OS', () => {
    expect(resolveAppearance(a11y('off', 'off'), media({ reducedMotion: true, moreContrast: true, dark: true }))).toMatchObject({ theme: 'dark', reduceMotion: false });
    expect(resolveAppearance(a11y('on', 'on'), media())).toMatchObject({ theme: 'highContrast', reduceMotion: true });
  });

  it('writes data attributes used by the CSS', () => {
    const root = document.createElement('html');
    applyAppearance(root, { theme: 'dark', reduceMotion: true, forcedColors: false }, 'win32');
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.reduceMotion).toBe('true');
    expect(root.dataset.platform).toBe('win32');
    expect(root.style.colorScheme).toBe('dark');
  });
});

describe('design tokens → CSS variables', () => {
  it('emits every colour token for every theme and the motion/size tokens', () => {
    const css = buildTokensCss();
    for (const theme of ['light', 'dark', 'highContrast'] as const) {
      expect(css).toContain(`:root[data-theme="${theme}"]{`);
      for (const [name, value] of Object.entries(DESIGN_TOKENS.color[theme])) expect(css).toContain(`${colorVar(name)}:${value};`);
    }
    expect(colorVar('sectorActive')).toBe('--c-sector-active');
    expect(css).toContain(`--motion-wheel-appear:${DESIGN_TOKENS.motion.wheelAppearMs}ms;`);
    expect(css).toContain('--editor-width:520px;');
    expect(css).toContain(':root[data-reduce-motion="true"]{--motion-wheel-appear:0ms;');
  });
});

describe('error normalisation', () => {
  it('recovers the ErrorCode from preload rejections', () => {
    expect(asErrorInfo(new Error('OUTPUT_DIR_NOT_WRITABLE: EACCES'))).toEqual({ code: 'OUTPUT_DIR_NOT_WRITABLE', message: 'EACCES', retryable: true });
    expect(asErrorInfo(new Error('PDF_ENCRYPTED: locked')).retryable).toBe(false);
    expect(asErrorInfo(new Error('NOT_A_REAL_CODE: x')).code).toBe('INTERNAL');
    expect(asErrorInfo('boom').code).toBe('INTERNAL');
    expect(asErrorInfo({ code: 'TIMEOUT', message: 'slow' })).toEqual({ code: 'TIMEOUT', message: 'slow', retryable: true });
  });
});

describe('drop guard', () => {
  it('prevents navigation for files dropped outside a drop target and shows no-drop', () => {
    const stop = installDropGuard(window);
    const over = new Event('dragover', { cancelable: true }) as DragEvent;
    Object.defineProperty(over, 'dataTransfer', { value: { dropEffect: 'copy' } });
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer?.dropEffect).toBe('none');
    const drop = new Event('drop', { cancelable: true });
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    stop();
  });
});
