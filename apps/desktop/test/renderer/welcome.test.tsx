// @vitest-environment jsdom
import './setup';
import { DEFAULT_SETTINGS, defaultSettingsFor, type Settings } from '@orbitdrop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { comboLabel } from '../../src/renderer/src/app/keys';
import { createTranslator } from '../../src/renderer/src/i18n/catalog';
import { WelcomeView } from '../../src/renderer/src/views/welcome/WelcomeView';
import { createFakeOrbit, renderWithEnv } from './helpers';

function setup(options: { platform?: 'darwin' | 'win32'; settings?: Settings } = {}) {
  const platform = options.platform ?? 'darwin';
  const orbit = createFakeOrbit({ platform });
  const view = renderWithEnv(<WelcomeView />, { orbit, settings: options.settings ?? defaultSettingsFor(platform) });
  return { ...view, orbit, user: userEvent.setup() };
}

/** The key rows: [keys as shown, what they open]. */
function keyRows(container: HTMLElement): [string, string][] {
  return [...container.querySelectorAll('.welcome-key-row')].map((row) => [row.querySelector('dt')!.textContent ?? '', row.querySelector('dd')!.textContent ?? '']);
}

describe('welcome window', () => {
  it('macOS: teaches the gesture with the real keys and Mac key names; the app lives in the menu bar', () => {
    const { container } = setup();
    expect(screen.getByRole('heading', { level: 2, name: 'OrbitDrop에 오신 것을 환영합니다' })).toBeTruthy();
    expect(screen.getByText('Finder에서 파일을 끌기 시작합니다.')).toBeTruthy();
    expect(keyRows(container)).toEqual([
      ['Shift', '변환 휠: JPG, PNG, PDF 같은 다른 형식으로'],
      ['Option+Shift', '도구 휠: 자르기, 배경 추가, 압축 같은 편집'],
    ]);
    expect([...container.querySelectorAll('.welcome-key-row kbd')].map((kbd) => kbd.textContent)).toEqual(['Shift', 'Option', 'Shift']);
    expect(screen.getByText(/메뉴 막대\(화면 오른쪽 위\)에서 실행되며 Dock에는 나타나지 않습니다/)).toBeTruthy();
    expect(screen.queryByText(/숨겨진 아이콘 표시/)).toBeNull();
  });

  it('Windows: Ctrl+Shift for tools (the Windows default), File Explorer, the notification area and its ^ overflow', () => {
    const { container } = setup({ platform: 'win32' });
    expect(screen.getByText('파일 탐색기에서 파일을 끌기 시작합니다.')).toBeTruthy();
    expect(keyRows(container).map(([keys]) => keys)).toEqual(['Shift', 'Ctrl+Shift']);
    expect(screen.getByText(/작업 표시줄 오른쪽 알림 영역에서 실행됩니다/)).toBeTruthy();
    expect(screen.getByText(/Windows 11은 새 아이콘을 \^\(숨겨진 아이콘 표시\) 안에 숨길 수 있습니다/)).toBeTruthy();
  });

  it("shows the user's current combos (Alt on Windows), in the order the OS writes shortcuts", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, globalDrag: { ...DEFAULT_SETTINGS.globalDrag, convertModifiers: ['shift', 'alt'], toolsModifiers: ['shift', 'control', 'alt'] } };
    const { container } = setup({ platform: 'win32', settings });
    expect(keyRows(container).map(([keys]) => keys)).toEqual(['Alt+Shift', 'Ctrl+Alt+Shift']);
    const t = createTranslator('en');
    expect(comboLabel(t, ['shift', 'alt'], 'darwin')).toBe('Option+Shift');
    expect(comboLabel(t, ['command', 'shift'], 'win32')).toBe('Shift+Windows');
  });

  it('starts with focus on the heading (a screen reader reads from the top); Tab reaches every control', async () => {
    const { user } = setup();
    const heading = screen.getByRole('heading', { level: 2 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Drop Zone 열기' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: '로그인 시 실행' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: '업데이트 자동 확인' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '시작하기' }));
  });

  it('"로그인 시 실행" stays off unless the user turns it on; the switch is described by its hint', async () => {
    const { orbit, user } = setup();
    const toggle = screen.getByRole('switch', { name: '로그인 시 실행' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    const hint = document.getElementById(toggle.getAttribute('aria-describedby')!);
    expect(hint?.textContent).toMatch(/로그인할 때 OrbitDrop이 자동으로 시작됩니다/);
    await user.click(toggle);
    expect(orbit.updateSettings).toHaveBeenCalledWith({ launchAtLogin: true });
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it('"업데이트 자동 확인" shows the current setting (on by default, off as the installer left it) and saves updates.autoCheck', async () => {
    const { orbit, user } = setup({ platform: 'win32' });
    const toggle = screen.getByRole('switch', { name: '업데이트 자동 확인' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    const hint = document.getElementById(toggle.getAttribute('aria-describedby')!);
    expect(hint?.textContent).toMatch(/GitHub에 새 버전이 있는지 확인합니다/);
    expect(hint?.textContent).toMatch(/설정 › 일반에서 언제든 바꿀 수 있습니다/);
    await user.click(toggle);
    expect(orbit.updateSettings).toHaveBeenCalledWith({ updates: { autoCheck: false } });
    await waitFor(() => expect(toggle.checked).toBe(false));

    // A first run after the installer's box was unticked (or /NOUPDATECHECK) starts with the switch off.
    const off = defaultSettingsFor('darwin');
    setup({ settings: { ...off, locale: 'en', updates: { autoCheck: false } } });
    const en = screen.getByRole('switch', { name: 'Check for updates automatically' }) as HTMLInputElement;
    expect(en.checked).toBe(false);
    expect(document.getElementById(en.getAttribute('aria-describedby')!)?.textContent).toMatch(/asks GitHub whether a new version exists/);
  });

  it('a failed save is shown, not swallowed', async () => {
    const { orbit, user } = setup();
    orbit.updateSettings.mockRejectedValueOnce(new Error('INVALID_OPTIONS: nope'));
    await user.click(screen.getByRole('switch', { name: '로그인 시 실행' }));
    expect(await screen.findByText('설정을 저장하지 못했습니다.')).toBeTruthy();
  });

  it('opens the Drop Zone; 시작하기, the × and Esc close the window (main then marks the welcome as seen)', async () => {
    const { orbit, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Drop Zone 열기' }));
    expect(orbit.openWindow).toHaveBeenCalledWith('dropzone');
    await user.click(screen.getByRole('button', { name: '시작하기' }));
    expect(orbit.closeWindow).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(orbit.closeWindow).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(orbit.closeWindow).toHaveBeenCalledTimes(3);
  });

  it('says so when global drag is off, and is English with an English UI', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, locale: 'en', globalDrag: { ...DEFAULT_SETTINGS.globalDrag, enabled: false } };
    setup({ settings });
    expect(screen.getByRole('heading', { level: 2, name: 'Welcome to OrbitDrop' })).toBeTruthy();
    expect(screen.getByText(/Global drag is off right now/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeTruthy();
    const list = screen.getByRole('list');
    expect(within(list).getByText('Start dragging a file in Finder.')).toBeTruthy();
  });
});
