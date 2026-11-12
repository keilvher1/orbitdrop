// @vitest-environment jsdom
import './setup';
import { DEFAULT_SETTINGS, type WheelSector } from '@orbitdrop/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PickerView } from '../../src/renderer/src/views/picker/PickerView';
import { Wheel } from '../../src/renderer/src/wheel/Wheel';
import { wheelAlwaysOpaque, wheelOpacityFactor } from '../../src/renderer/src/wheel/wheelOpacity';
import { renderWithEnv, sampleMenu } from './helpers';

function sectors(): WheelSector[] {
  // JPG tools menu: COMPRESS, METADATA, EDIT, ANNOTATE, ADD BG, CROP, REDACT — make EDIT disabled.
  return sampleMenu('tools').sectors.map((s) => (s.actionId === 'tool.edit' ? { ...s, enabled: false, reason: '테스트 사유' } : s));
}

function setup(props: Partial<Parameters<typeof Wheel>[0]> = {}) {
  const onActivate = vi.fn();
  const onEscape = vi.fn();
  const view = renderWithEnv(
    <>
      <Wheel sectors={sectors()} diameter={360} label="도구 메뉴" centerText="1.2 MB" onActivate={onActivate} onEscape={onEscape} {...props} />
      <button type="button">mode toggle</button>
    </>,
  );
  const menu = screen.getByRole('menu', { name: '도구 메뉴' });
  return { ...view, menu, onActivate, onEscape, user: userEvent.setup() };
}

const activeLabel = (menu: HTMLElement) => {
  const id = menu.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.getAttribute('aria-label') : null;
};

describe('Wheel ARIA', () => {
  it('exposes a menu with one menuitem per sector in clockwise order', () => {
    const { menu } = setup();
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual(['압축', '메타데이터', '편집', '주석', '배경 추가', '자르기', '가리기']);
    expect(menu).toHaveProperty('tabIndex', 0);
    expect(menu.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('marks disabled sectors with aria-disabled and describes them with the reason', () => {
    setup();
    const edit = screen.getByRole('menuitem', { name: '편집' });
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    const reasonId = edit.getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent).toBe('테스트 사유');
    expect(screen.getByRole('menuitem', { name: '자르기' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('shows the default text in the capsule', () => {
    setup();
    expect(screen.getByText('1.2 MB')).toBeTruthy();
  });
});

describe('Wheel keyboard', () => {
  it('ArrowRight/ArrowDown move clockwise and wrap; ArrowLeft/ArrowUp move counter-clockwise', async () => {
    const { menu, user } = setup();
    menu.focus();
    await user.keyboard('{ArrowRight}');
    expect(activeLabel(menu)).toBe('압축');
    await user.keyboard('{ArrowDown}');
    expect(activeLabel(menu)).toBe('메타데이터');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(activeLabel(menu)).toBe('가리기');
    await user.keyboard('{ArrowUp}');
    expect(activeLabel(menu)).toBe('자르기');
    await user.keyboard('{End}');
    expect(activeLabel(menu)).toBe('가리기');
    await user.keyboard('{ArrowRight}');
    expect(activeLabel(menu)).toBe('압축');
    await user.keyboard('{Home}');
    expect(activeLabel(menu)).toBe('압축');
  });

  it('starts counter-clockwise from the last sector', async () => {
    const { menu, user } = setup();
    menu.focus();
    await user.keyboard('{ArrowLeft}');
    expect(activeLabel(menu)).toBe('가리기');
  });

  it('reaches disabled sectors but does not activate them; announces the reason', async () => {
    const { menu, user, onActivate } = setup();
    menu.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(activeLabel(menu)).toBe('편집');
    await user.keyboard('{Enter}');
    expect(onActivate).not.toHaveBeenCalled();
    expect(screen.getByText('편집, 사용할 수 없음: 테스트 사유')).toBeTruthy();
    // The capsule shows the reason too.
    expect(screen.getAllByText('테스트 사유').length).toBeGreaterThan(0);
  });

  it('Enter and Space activate the highlighted enabled sector', async () => {
    const { menu, user, onActivate } = setup();
    menu.focus();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]?.[0]).toMatchObject({ actionId: 'tool.compress' });
    expect(onActivate.mock.calls[0]?.[1]).toBe(0);
    await user.keyboard('{ArrowLeft}{ArrowLeft} ');
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(onActivate.mock.calls[1]?.[0]).toMatchObject({ actionId: 'tool.crop' });
  });

  it('Enter without a highlighted sector does nothing', async () => {
    const { menu, user, onActivate } = setup();
    menu.focus();
    await user.keyboard('{Enter}');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('the highlighted sector is announced once (aria-activedescendant); the live region only explains a disabled one on Enter', async () => {
    const { menu, user } = setup();
    menu.focus();
    await user.keyboard('{ArrowRight}');
    const live = document.querySelector('[aria-live="polite"]');
    expect(menu.getAttribute('aria-activedescendant')).toBeTruthy();
    expect(activeLabel(menu)).toBe('압축');
    expect(live?.textContent).toBe(''); // no second announcement of the same item
    await user.keyboard('{ArrowRight}{ArrowRight}{Enter}');
    expect(live?.textContent).toBe('편집, 사용할 수 없음: 테스트 사유');
    await user.keyboard('{ArrowLeft}');
    expect(live?.textContent).toBe(''); // cleared: the next Enter on it is read again
  });

  it('Escape calls onEscape', async () => {
    const { menu, user, onEscape } = setup();
    menu.focus();
    await user.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('Tab moves focus from the wheel to the next control (mode toggle)', async () => {
    const { menu, user } = setup();
    menu.focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'mode toggle' }));
  });

  it('ignores activation while busy', async () => {
    const { menu, user, onActivate } = setup({ busy: true });
    menu.focus();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(onActivate).not.toHaveBeenCalled();
    expect(menu.getAttribute('aria-busy')).toBe('true');
  });
});

describe('Wheel opacity', () => {
  const factorOf = (menu: HTMLElement) => (menu.closest('.wheel') as HTMLElement).style.getPropertyValue('--wheel-opacity');
  const LIGHT = { theme: 'light', forcedColors: false } as const;

  it('sets --wheel-opacity from the opacity prop (percent); opaque without one', () => {
    const plain = setup();
    expect(factorOf(plain.menu)).toBe('1');
    plain.unmount();
    expect(factorOf(setup({ opacity: 55 }).menu)).toBe('0.55');
  });

  it('stays opaque in high contrast', () => {
    const settings = { ...DEFAULT_SETTINGS, accessibility: { ...DEFAULT_SETTINGS.accessibility, highContrast: 'on' as const } };
    renderWithEnv(<Wheel sectors={sectors()} diameter={360} opacity={40} label="도구 메뉴" centerText="1.2 MB" onActivate={vi.fn()} />, { settings });
    expect(factorOf(screen.getByRole('menu', { name: '도구 메뉴' }))).toBe('1');
  });

  it('the factor is the setting in light and dark, kept in 40–100 %, and 1 in high contrast or forced colours', () => {
    expect(wheelOpacityFactor(70, LIGHT)).toBe(0.7);
    expect(wheelOpacityFactor(55, { theme: 'dark', forcedColors: false })).toBe(0.55);
    expect(wheelOpacityFactor(10, LIGHT)).toBe(0.4);
    expect(wheelOpacityFactor(150, LIGHT)).toBe(1);
    expect(wheelOpacityFactor(Number.NaN, LIGHT)).toBe(1);
    expect(wheelOpacityFactor(40, { theme: 'highContrast', forcedColors: false })).toBe(1);
    expect(wheelOpacityFactor(40, { theme: 'highContrastDark', forcedColors: false })).toBe(1);
    expect(wheelOpacityFactor(40, { theme: 'light', forcedColors: true })).toBe(1);
    expect(wheelAlwaysOpaque(LIGHT)).toBe(false);
  });

  it('a picker or Drop Zone wheel uses the saved setting', async () => {
    const settings = { ...DEFAULT_SETTINGS, globalDrag: { ...DEFAULT_SETTINGS.globalDrag, wheelOpacity: 45 } };
    renderWithEnv(<PickerView selectionId="sel1" initialMode="convert" />, { settings });
    const menu = await screen.findByRole('menu', { name: '변환 메뉴' });
    expect(factorOf(menu)).toBe('0.45');
  });
});

/** Style rules of wheel.css (jsdom's parser), with the media query they sit in. Vitest turns CSS imports into empty strings. */
async function wheelCss(): Promise<{ source: string; rules: { media: string | null; selector: string; css: string }[] }> {
  const fsModule = 'node:fs';
  const urlModule = 'node:url';
  const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, encoding: 'utf8'): string };
  const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(url: string): string };
  const relative = '../../src/renderer/src/wheel/wheel.css';
  const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url).href), 'utf8');
  const style = document.createElement('style');
  style.textContent = source;
  document.head.append(style);
  const rules: { media: string | null; selector: string; css: string }[] = [];
  const walk = (list: CSSRuleList, media: string | null) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSMediaRule) walk(rule.cssRules, rule.media.mediaText);
      else if (rule instanceof CSSStyleRule) rules.push({ media, selector: rule.selectorText, css: rule.style.cssText.toLowerCase() });
    }
  };
  walk(style.sheet!.cssRules, null);
  style.remove();
  return { source, rules };
}

describe('wheel.css: only the background follows the wheel opacity', () => {
  const FORCED = '(forced-colors: active)';

  it('disc and sector fills use --wheel-opacity; the highlighted sector, text, icons and capsule stay solid', async () => {
    const { source, rules } = await wheelCss();
    const css = (selector: string, media: string | null = null) => rules.find((rule) => rule.selector === selector && rule.media === media)?.css ?? '';
    expect(css('.wheel-disc')).toContain('fill-opacity: var(--wheel-opacity, 1)');
    expect(css('.wheel-disc')).not.toContain('stroke-opacity'); // the ring is the disc's stroke: crisp
    expect(css('.wheel-sector path')).toContain('fill-opacity: var(--wheel-opacity, 1)');
    // The highlighted sector — the drop target or a disabled one under the pointer — is solid.
    expect(css(".wheel-sector[data-active='true'] path")).toContain('fill-opacity: 1');
    expect(css(".wheel-sector[data-enabled='true'][data-active='true'] path")).toContain('fill: var(--c-sector-active)');
    for (const rule of rules) {
      if (/wheel-(text|icon|capsule)/.test(rule.selector)) expect(rule.css, rule.selector).not.toContain('--wheel-opacity');
    }
    // Forced colours: opaque system colours.
    expect(css('.wheel-disc', FORCED)).toContain('fill-opacity: 1');
    expect(css('.wheel-sector path', FORCED)).toContain('fill-opacity: 1');
    // The disc shadow's colour is scaled by the same factor (relative colour; jsdom does not parse it, so: the source).
    expect(source).toMatch(/drop-shadow\(0 10px 22px rgb\(from var\(--c-wheel-shadow\) r g b \/ calc\(alpha \* var\(--wheel-opacity, 1\)\)\)\)/);
  });
});
