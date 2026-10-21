// @vitest-environment jsdom
import './setup';
import type { WheelSector } from '@orbitdrop/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Wheel } from '../../src/renderer/src/wheel/Wheel';
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

  it('announces the highlighted sector in a live region', async () => {
    const { menu, user } = setup();
    menu.focus();
    await user.keyboard('{ArrowRight}');
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('압축');
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
