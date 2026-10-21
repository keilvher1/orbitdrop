// @vitest-environment jsdom
import './setup';
import { DEFAULT_SETTINGS, DEFAULT_WHEEL_GEOMETRY, WHEEL_DIAMETER_RANGE, isAllowedExternalUrl, type HelperStatus, type ModifierKey, type Settings } from '@orbitdrop/contracts';
import { innerRadius, sectorOuterRadius } from '@orbitdrop/core';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PERMISSION_URLS, SettingsView } from '../../src/renderer/src/views/settings/SettingsView';
import { WHEEL_PREVIEW_SCALE, previewDiameter } from '../../src/renderer/src/views/settings/WheelSizePreview';
import { sectorShape } from '../../src/renderer/src/wheel/sectorPath';
import {
  comboWarnings,
  isModifierSupported,
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

  it('on macOS rejects Control and Command (AppKit turns the drag into Link/Generic, no Copy)', () => {
    expect(validateModifierCombos(['control', 'shift'], ['alt', 'shift'], 'darwin')).toEqual({ convert: 'macUnsupported', tools: null, valid: false });
    expect(validateModifierCombos(['shift'], ['command'], 'darwin')).toMatchObject({ convert: null, tools: 'macUnsupported', valid: false });
    expect(validateModifierCombos(['control', 'shift'], ['alt', 'shift'], 'win32')).toMatchObject({ valid: true });
    expect(validateModifierCombos(['shift'], ['alt', 'shift'], 'darwin')).toMatchObject({ valid: true });
    // The "must differ" rule still applies on macOS.
    expect(validateModifierCombos(['alt', 'shift'], ['shift', 'alt'], 'darwin')).toMatchObject({ convert: 'same', tools: 'same', valid: false });
    expect(isModifierSupported('command', 'darwin')).toBe(false);
    expect(isModifierSupported('command', 'win32')).toBe(true);
    expect(isModifierSupported('alt', 'darwin')).toBe(true);
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

    // Convert gets Option → valid again → both combos are saved together.
    await user.click(within(convert).getByRole('button', { name: 'Option' }));
    expect(orbit.updateSettings).toHaveBeenCalledTimes(1);
    expect(orbit.updateSettings).toHaveBeenCalledWith({ globalDrag: { convertModifiers: ['shift', 'alt'], toolsModifiers: ['shift'] } });
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

  it('on macOS Control and Command cannot be chosen and the reason is explained', async () => {
    const { orbit, user } = setup({ platform: 'darwin' });
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    const note = screen.getByText(/macOS에서는 Control·Command 키를 쓸 수 없습니다\. 이 키를 누른 채/);
    for (const name of ['변환 메뉴 키', '도구 메뉴 키']) {
      const group = screen.getByRole('group', { name });
      for (const key of ['Control', 'Command']) {
        const button = within(group).getByRole('button', { name: key }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-describedby')).toContain(note.id);
      }
      expect((within(group).getByRole('button', { name: 'Option' }) as HTMLButtonElement).disabled).toBe(false);
    }
    await user.click(within(screen.getByRole('group', { name: '변환 메뉴 키' })).getByRole('button', { name: 'Control' }));
    expect(orbit.updateSettings).not.toHaveBeenCalled();
  });

  it('on macOS flags a saved combo with Command, lets the user remove it, then saves', async () => {
    const orbit = createFakeOrbit({ platform: 'darwin' });
    const settings = { ...DEFAULT_SETTINGS, globalDrag: { ...DEFAULT_SETTINGS.globalDrag, toolsModifiers: ['command', 'shift'] as ModifierKey[] } };
    renderWithEnv(<SettingsView />, { orbit, settings });
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    const tools = screen.getByRole('group', { name: '도구 메뉴 키' });
    expect(screen.getByText('macOS에서는 Control·Command 키를 쓸 수 없습니다. 다른 키를 고르세요.')).toBeTruthy();
    const command = within(tools).getByRole('button', { name: 'Command' }) as HTMLButtonElement;
    expect(command.getAttribute('aria-pressed')).toBe('true');
    expect(command.disabled).toBe(false);
    await user.click(command); // tools = Shift, same as convert → still invalid, nothing saved
    expect(orbit.updateSettings).not.toHaveBeenCalled();
    await user.click(within(tools).getByRole('button', { name: 'Option' }));
    expect(orbit.updateSettings).toHaveBeenCalledWith({ globalDrag: { convertModifiers: ['shift'], toolsModifiers: ['shift', 'alt'] } });
  });

  it('on Windows Control and the Windows key stay available', async () => {
    const { user } = setup({ platform: 'win32' });
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    expect(screen.queryByText(/macOS에서는 Control·Command/)).toBeNull();
    const convert = screen.getByRole('group', { name: '변환 메뉴 키' });
    expect((within(convert).getByRole('button', { name: 'Ctrl' }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(convert).getByRole('button', { name: 'Windows' }) as HTMLButtonElement).disabled).toBe(false);
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

describe('SettingsView wheel size preview', () => {
  const previewSvg = () => {
    const figure = screen.getByRole('figure', { name: '휠 크기 미리보기' });
    const svg = figure.querySelector('svg.wheel-preview-svg');
    if (!(svg instanceof SVGSVGElement)) throw new Error('no preview svg');
    return svg;
  };
  const disc = (svg: SVGSVGElement) => svg.querySelector('circle.wheel-disc');

  it('follows every slider movement at once; the save is debounced to one call with the final value', async () => {
    const { orbit, user } = setup();
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    const svg = previewSvg();
    expect(svg.getAttribute('data-diameter')).toBe(String(DEFAULT_SETTINGS.globalDrag.wheelDiameter));

    const slider = screen.getByRole('slider', { name: '휠 크기' });
    fireEvent.change(slider, { target: { value: '330' } });
    expect(previewSvg().getAttribute('data-diameter')).toBe('330');
    expect(disc(previewSvg())?.getAttribute('r')).toBe(String(330 / 2 - DEFAULT_WHEEL_GEOMETRY.ringWidth / 2));
    fireEvent.change(slider, { target: { value: '372' } });
    expect(previewSvg().getAttribute('data-diameter')).toBe('372');
    expect(orbit.updateSettings).not.toHaveBeenCalled();

    await waitFor(() => expect(orbit.updateSettings).toHaveBeenCalledWith({ globalDrag: { wheelDiameter: 372 } }));
    expect(orbit.updateSettings).toHaveBeenCalledTimes(1);
    expect(previewSvg().getAttribute('data-diameter')).toBe('372');
  });

  it('draws the wheel with the real geometry and sector path code, with dashed limit rings, at a fixed size', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    fireEvent.change(screen.getByRole('slider', { name: '휠 크기' }), { target: { value: '344' } });
    const svg = previewSvg();
    const box = WHEEL_DIAMETER_RANGE.max + 24;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('viewBox')).toBe(`${-box / 2} ${-box / 2} ${box} ${box}`);
    expect(svg.getAttribute('width')).toBe(String(Math.round(box * WHEEL_PREVIEW_SCALE)));

    const paths = Array.from(svg.querySelectorAll('.wheel-sector path')).map((p) => p.getAttribute('d'));
    expect(paths).toHaveLength(8); // a JPG's convert menu, like the reference recording
    const expected = sectorShape({
      index: 0,
      count: 8,
      innerRadius: innerRadius(344),
      outerRadius: sectorOuterRadius(344),
      gap: DEFAULT_WHEEL_GEOMETRY.sectorGap,
      cornerRadius: DEFAULT_WHEEL_GEOMETRY.sectorCornerRadius,
      startAngleDeg: DEFAULT_WHEEL_GEOMETRY.startAngleDeg,
    });
    expect(paths[0]).toBe(expected.path);
    expect(svg.querySelectorAll('.wheel-sector[data-active="true"]')).toHaveLength(1);

    const limits = Array.from(svg.querySelectorAll('circle.wheel-preview-limit')).map((c) => [c.getAttribute('r'), c.getAttribute('stroke-dasharray')]);
    expect(limits.map(([r]) => r)).toEqual([String(WHEEL_DIAMETER_RANGE.min / 2), String(WHEEL_DIAMETER_RANGE.max / 2)]);
    expect(limits.every(([, dash]) => dash !== null && dash !== '')).toBe(true);
    expect(screen.getByText('실제 크기의 45%로 표시 · 점선은 가장 작은 크기와 가장 큰 크기')).toBeTruthy();

    // The drawing box does not depend on the diameter (no layout jump while dragging).
    fireEvent.change(screen.getByRole('slider', { name: '휠 크기' }), { target: { value: '380' } });
    expect(previewSvg().getAttribute('width')).toBe(String(Math.round(box * WHEEL_PREVIEW_SCALE)));
  });

  it('follows a value typed in the number field', async () => {
    const { orbit, user } = setup();
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    const field = screen.getByRole('spinbutton', { name: '휠 크기' });
    await user.clear(field);
    await user.type(field, '326{Enter}');
    expect(previewSvg().getAttribute('data-diameter')).toBe('326');
    await waitFor(() => expect(orbit.updateSettings).toHaveBeenCalledWith({ globalDrag: { wheelDiameter: 326 } }));
  });

  it('a pending change is saved once when the tab closes', async () => {
    const { orbit, user } = setup();
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    fireEvent.change(screen.getByRole('slider', { name: '휠 크기' }), { target: { value: '322' } });
    await user.click(screen.getByRole('tab', { name: '일반' }));
    expect(orbit.updateSettings).toHaveBeenCalledTimes(1);
    expect(orbit.updateSettings).toHaveBeenCalledWith({ globalDrag: { wheelDiameter: 322 } });
    await new Promise((resolve) => setTimeout(resolve, 300)); // the debounce timer was cancelled
    expect(orbit.updateSettings).toHaveBeenCalledTimes(1);
  });

  it('shows a size saved elsewhere', async () => {
    let listener: ((settings: Settings) => void) | null = null;
    const orbit = createFakeOrbit({
      onSettingsChanged: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    });
    renderWithEnv(<SettingsView />, { orbit });
    await userEvent.setup().click(screen.getByRole('tab', { name: '드래그' }));
    act(() => listener?.({ ...DEFAULT_SETTINGS, globalDrag: { ...DEFAULT_SETTINGS.globalDrag, wheelDiameter: 324 } }));
    expect(previewSvg().getAttribute('data-diameter')).toBe('324');
    expect((screen.getByRole('slider', { name: '휠 크기' }) as HTMLInputElement).value).toBe('324');
  });

  it('draws only diameters inside the setting range', () => {
    expect(previewDiameter(200)).toBe(WHEEL_DIAMETER_RANGE.min);
    expect(previewDiameter(1000)).toBe(WHEEL_DIAMETER_RANGE.max);
    expect(previewDiameter(341.6)).toBe(342);
    expect(previewDiameter(Number.NaN)).toBe(DEFAULT_WHEEL_GEOMETRY.diameter);
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

describe('SettingsView platform notes for modifier keys', () => {
  it('Windows: explains the Alt+Shift and Windows-key collisions and warns on the combos that have them', async () => {
    const { user } = setup({ platform: 'win32' });
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    expect(screen.getByText(/Windows에서는 Alt\+Shift가 입력 언어 전환 단축키로도 쓰이고/)).toBeTruthy();
    // The default tools combo is Alt+Shift.
    const tools = screen.getByRole('group', { name: '도구 메뉴 키' });
    const altShift = screen.getByText(/Alt\+Shift는 입력 언어 전환 단축키와 겹칩니다/);
    expect(tools.getAttribute('aria-describedby')?.split(' ')).toContain(altShift.id);
    // Adding the Windows key to the convert combo warns about Start.
    const convert = screen.getByRole('group', { name: '변환 메뉴 키' });
    await user.click(within(convert).getByRole('button', { name: 'Windows' }));
    expect(screen.getByText('Windows 키를 떼면 시작 메뉴가 열릴 수 있습니다.')).toBeTruthy();
  });

  it('macOS: no Windows warnings; an Input Monitoring hint opens the allowlisted pane', async () => {
    const { orbit, user } = setup({ platform: 'darwin' });
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    expect(screen.queryByText(/입력 언어 전환/)).toBeNull();
    expect(await screen.findByText(/입력 모니터링 권한이 없으면 Esc 키는 포인터가 휠 위에 있을 때만/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '입력 모니터링 설정 열기' }));
    expect(orbit.openExternal).toHaveBeenCalledWith(PERMISSION_URLS.inputMonitoring);
    expect(isAllowedExternalUrl(PERMISSION_URLS.inputMonitoring)).toBe(true);
  });

  it('macOS: when Input Monitoring is reported missing, only the status button offers it (no duplicate)', async () => {
    const { user } = setup({ platform: 'darwin', status: { state: 'needsPermission', permissions: ['inputMonitoring'] } });
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    await screen.findByText(/권한이 필요합니다/);
    expect(screen.getAllByRole('button', { name: '입력 모니터링 설정 열기' })).toHaveLength(1);
    expect(screen.queryByText(/입력 모니터링 권한이 없으면/)).toBeNull();
  });

  it('comboWarnings only applies on Windows', () => {
    expect(comboWarnings(['alt', 'shift'], 'win32')).toEqual(['altShift']);
    expect(comboWarnings(['shift', 'alt', 'command'], 'win32')).toEqual(['winKey']);
    expect(comboWarnings(['command'], 'win32')).toEqual(['winKey']);
    expect(comboWarnings(['alt', 'shift'], 'darwin')).toEqual([]);
    expect(comboWarnings(['shift'], 'win32')).toEqual([]);
  });

  it('Windows: no Input Monitoring hint', async () => {
    const { user } = setup({ platform: 'win32' });
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    await screen.findByText(/실행 중/);
    expect(screen.queryByText(/입력 모니터링 권한이 없으면/)).toBeNull();
  });
});
