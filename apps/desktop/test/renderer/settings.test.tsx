// @vitest-environment jsdom
import './setup';
import { isAllowedExternalUrl, type HelperStatus } from '@orbitdrop/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PERMISSION_URLS, SettingsView } from '../../src/renderer/src/views/settings/SettingsView';
import {
  normalizeCombo,
  sameCombo,
  toggleModifier,
  validateIntegerInRange,
  validateModifierCombos,
} from '../../src/renderer/src/views/settings/settingsValidation';
import { createFakeOrbit, renderWithEnv } from './helpers';

const SAME_ERROR = '변환 메뉴와 도구 메뉴의 키 조합은 서로 달라야 합니다.';

describe('modifier combo validation', () => {
  it('rejects identical combos regardless of order', () => {
    expect(validateModifierCombos(['alt', 'shift'], ['shift', 'alt'])).toEqual({ convert: 'same', tools: 'same', valid: false });
    expect(sameCombo(['command', 'shift'], ['shift', 'command', 'shift'])).toBe(true);
  });

  it('allows a combo that is a subset of the other', () => {
    expect(validateModifierCombos(['shift'], ['alt', 'shift'])).toEqual({ convert: null, tools: null, valid: true });
  });

  it('rejects empty and too many keys per field', () => {
    expect(validateModifierCombos([], ['shift'])).toMatchObject({ convert: 'empty', tools: null, valid: false });
    expect(validateModifierCombos(['shift'], ['shift', 'alt', 'control', 'command'])).toMatchObject({ convert: null, tools: 'tooMany', valid: false });
  });

  it('normalizes and toggles in canonical order', () => {
    expect(normalizeCombo(['command', 'shift', 'alt', 'shift'])).toEqual(['shift', 'alt', 'command']);
    expect(toggleModifier(['alt', 'shift'], 'control')).toEqual(['shift', 'alt', 'control']);
    expect(toggleModifier(['alt', 'shift'], 'alt')).toEqual(['shift']);
  });

  it('validates whole numbers in range', () => {
    expect(validateIntegerInRange(600, 10, 3600)).toBeNull();
    expect(validateIntegerInRange('5', 10, 3600)).toBe('range');
    expect(validateIntegerInRange('12.5', 10, 3600)).toBe('notInteger');
    expect(validateIntegerInRange('abc', 10, 3600)).toBe('notInteger');
  });

  it('allowlists the System Settings panes it opens', () => {
    expect(isAllowedExternalUrl(PERMISSION_URLS.accessibility)).toBe(true);
    expect(isAllowedExternalUrl(PERMISSION_URLS.inputMonitoring)).toBe(true);
  });
});

function setup(options: { status?: HelperStatus; platform?: 'darwin' | 'win32' } = {}) {
  const orbit = createFakeOrbit({ platform: options.platform ?? 'darwin' });
  if (options.status) orbit.getHelperStatus.mockResolvedValue(options.status);
  const view = renderWithEnv(<SettingsView />, { orbit });
  return { ...view, orbit, user: userEvent.setup() };
}

describe('SettingsView modifier keys', () => {
  it('does not save equal combos and saves both once they differ', async () => {
    const { orbit, user } = setup();
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    const tools = screen.getByRole('group', { name: '도구 메뉴 키' });
    const convert = screen.getByRole('group', { name: '변환 메뉴 키' });
    expect(within(tools).getByRole('button', { name: 'Option' }).getAttribute('aria-pressed')).toBe('true');

    // Tools = Option+Shift → remove Option → Shift only, same as Convert.
    await user.click(within(tools).getByRole('button', { name: 'Option' }));
    expect(screen.getAllByText(SAME_ERROR).length).toBeGreaterThan(0);
    expect(orbit.updateSettings).not.toHaveBeenCalled();
    const errorId = within(tools).getByRole('button', { name: 'Shift' }).getAttribute('aria-describedby');
    expect(errorId && document.getElementById(errorId)?.textContent).toBe(SAME_ERROR);

    // Convert gets Control → valid again → both combos are saved together.
    await user.click(within(convert).getByRole('button', { name: 'Control' }));
    expect(orbit.updateSettings).toHaveBeenCalledTimes(1);
    expect(orbit.updateSettings).toHaveBeenCalledWith({ globalDrag: { convertModifiers: ['shift', 'control'], toolsModifiers: ['shift'] } });
    await waitFor(() => expect(screen.queryAllByText(SAME_ERROR)).toHaveLength(0));
  });

  it('rejects an empty combo', async () => {
    const { orbit, user } = setup();
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    const convert = screen.getByRole('group', { name: '변환 메뉴 키' });
    await user.click(within(convert).getByRole('button', { name: 'Shift' }));
    expect(screen.getAllByText('키를 하나 이상 고르세요.').length).toBeGreaterThan(0);
    expect(orbit.updateSettings).not.toHaveBeenCalled();
  });

  it('labels keys for Windows', async () => {
    const { user } = setup({ platform: 'win32' });
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    const convert = screen.getByRole('group', { name: '변환 메뉴 키' });
    expect(within(convert).getByRole('button', { name: 'Alt' })).toBeTruthy();
    expect(within(convert).getByRole('button', { name: 'Windows' })).toBeTruthy();
  });
});

describe('SettingsView other settings', () => {
  it('applies the reduce-motion choice immediately', async () => {
    const { orbit, user } = setup();
    await user.click(screen.getByRole('tab', { name: '접근성' }));
    const group = screen.getByRole('radiogroup', { name: '동작 줄이기' });
    await user.click(within(group).getByRole('radio', { name: '켜기' }));
    expect(orbit.updateSettings).toHaveBeenCalledWith({ accessibility: { reduceMotion: 'on' } });
  });

  it('switches the UI language', async () => {
    const { orbit, user } = setup();
    await user.click(within(screen.getByRole('radiogroup', { name: '언어' })).getByRole('radio', { name: 'English' }));
    expect(orbit.updateSettings).toHaveBeenCalledWith({ locale: 'en' });
    expect(await screen.findByRole('tab', { name: 'General' })).toBeTruthy();
  });

  it('saves slider changes (debounced)', async () => {
    const { orbit, user } = setup();
    await user.click(screen.getByRole('tab', { name: '변환·저장' }));
    fireEvent.change(screen.getByRole('slider', { name: 'JPEG 품질' }), { target: { value: '70' } });
    await waitFor(() => expect(orbit.updateSettings).toHaveBeenCalledWith({ output: { jpegQuality: 70 } }));
  });

  it('commits the timeout field clamped to its range', async () => {
    const { orbit, user } = setup();
    await user.click(screen.getByRole('tab', { name: '처리' }));
    const field = screen.getByRole('spinbutton', { name: '작업 시간 제한' });
    await user.clear(field);
    await user.type(field, '120{Enter}');
    expect(orbit.updateSettings).toHaveBeenCalledWith({ processing: { timeoutSec: 120 } });
  });

  it('shows an error when saving fails', async () => {
    const { orbit, user } = setup();
    orbit.updateSettings.mockRejectedValueOnce(new Error('INVALID_OPTIONS: bad patch'));
    await user.click(screen.getByLabelText('로그인할 때 OrbitDrop 실행'));
    expect(await screen.findByText('설정을 저장하지 못했습니다.')).toBeTruthy();
  });

  it('moves between tabs with the arrow keys', async () => {
    const { user } = setup();
    const general = screen.getByRole('tab', { name: '일반' });
    general.focus();
    await user.keyboard('{ArrowDown}');
    const output = screen.getByRole('tab', { name: '변환·저장' });
    expect(output.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(output);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(output.id);
  });
});

describe('SettingsView helper status', () => {
  it('needsPermission on macOS offers the allowlisted System Settings pane', async () => {
    const { orbit, user } = setup({ status: { state: 'needsPermission', permissions: ['accessibility'] } });
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    const button = await screen.findByRole('button', { name: '손쉬운 사용 설정 열기' });
    await user.click(button);
    expect(orbit.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    expect(screen.getByText(/Drop Zone/)).toBeTruthy();
  });

  it('does not offer macOS panes on Windows', async () => {
    const { user } = setup({ platform: 'win32', status: { state: 'needsPermission', permissions: ['accessibility'] } });
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    await screen.findByText(/권한이 필요합니다/);
    expect(screen.queryByRole('button', { name: '손쉬운 사용 설정 열기' })).toBeNull();
  });

  it('explains when global drag is unavailable while running', async () => {
    const { user } = setup({ status: { state: 'running', helperVersion: '1.2.0', globalDrag: false, reason: 'no event tap' } });
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    expect(await screen.findByText(/no event tap/)).toBeTruthy();
  });
});
