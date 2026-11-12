// @vitest-environment jsdom
import './setup';
import { DEFAULT_SETTINGS, defaultSettingsFor, type HelperStatus, type Settings } from '@orbitdrop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DropZoneView } from '../../src/renderer/src/views/dropzone/DropZoneView';
import { JobsView } from '../../src/renderer/src/views/jobs/JobsView';
import { AboutView } from '../../src/renderer/src/views/settings/AboutView';
import { SettingsView } from '../../src/renderer/src/views/settings/SettingsView';
import { createFakeOrbit, renderWithEnv } from './helpers';

describe('About: legal, troubleshooting, privacy', () => {
  it('shows the copyright and the MIT licence, and opens each shipped licence file by name', async () => {
    const { orbit } = renderWithEnv(<AboutView />);
    const user = userEvent.setup();
    expect(screen.getByText('© 2026 OrbitDrop contributors · MIT 라이선스')).toBeTruthy();
    const licenses = screen.getByRole('group', { name: '오픈 소스 라이선스' });
    for (const [label, which] of [
      ['제3자 구성요소', 'thirdParty'],
      ['Electron', 'electron'],
      ['Chromium', 'chromium'],
    ] as const) {
      await user.click(within(licenses).getByRole('button', { name: label }));
      expect(orbit.openLicense).toHaveBeenLastCalledWith(which);
    }
    orbit.openLicense.mockRejectedValueOnce(new Error('FILE_NOT_FOUND: missing'));
    await user.click(within(licenses).getByRole('button', { name: 'Chromium' }));
    expect(await screen.findByText('라이선스 파일을 열지 못했습니다.')).toBeTruthy();
  });

  it('copies diagnostics through main (the page learns only the line count) and opens the log folder', async () => {
    const { orbit } = renderWithEnv(<AboutView />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '진단 정보 복사' }));
    expect(orbit.copyDiagnostics).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('진단 정보를 복사했습니다(최근 로그 200줄 포함, 경로는 가림).')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '로그 폴더 열기' }));
    expect(orbit.openLogFolder).toHaveBeenCalledTimes(1);
    orbit.copyDiagnostics.mockRejectedValueOnce(new Error('INTERNAL: Unexpected error'));
    await user.click(screen.getByRole('button', { name: '진단 정보 복사' }));
    expect(await screen.findByText('진단 정보를 복사하지 못했습니다.')).toBeTruthy();
  });

  it('a short privacy statement: local files, no account or telemetry, the update check, local crash dumps, history, optional Claude analysis', () => {
    renderWithEnv(<AboutView />);
    const privacy = screen.getByRole('region', { name: '개인정보' });
    const items = within(privacy)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(items).toHaveLength(5);
    expect(items[0]).toMatch(/Claude 분석.*을 빼면 파일은 이 컴퓨터 밖으로 나가지 않습니다.*계정이 없고.*텔레메트리/);
    expect(items[1]).toMatch(/기본으로 켜짐.*GitHub.*IP 주소 같은 일반 접속 정보.*기기 식별자는 보내지 않습니다.*설정 › 일반에서 끌 수 있습니다/);
    expect(items[2]).toMatch(/충돌 보고서는 이 컴퓨터에만 저장/);
    expect(items[3]).toMatch(/history\.json.*끝난 작업 지우기/);
    // The optional analysis: off by default, own key, only on a drop, what goes where, billing, the key's storage.
    expect(items[4]).toMatch(/기본으로 꺼져.*자신의 Anthropic API 키.*파일을 놓을 때만.*1568px.*PDF는 파일 그대로.*파일 이름, 추가 요청, 보고서 언어.*api\.anthropic\.com.*API 약관.*키의 계정에 청구.*암호화.*설정·로그·작업 기록에는 남기지 않습니다/);
  });

  it('the English privacy statement names the same facts about Claude analysis', () => {
    renderWithEnv(<AboutView />, { settings: { ...DEFAULT_SETTINGS, locale: 'en' } });
    const items = within(screen.getByRole('region', { name: 'Privacy' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(items[0]).toMatch(/^Unless you turn on and use Claude analysis.*never leave this computer/);
    expect(items[4]).toMatch(/off by default.*your own Anthropic API key.*Only when you drop a file.*1568 px.*PDFs as they are.*file name.*standing request.*report language.*api\.anthropic\.com.*API terms.*billed.*Keychain.*DPAPI.*never written to settings, logs or history/);
  });

  it('is English with an English UI', () => {
    renderWithEnv(<AboutView />, { settings: { ...DEFAULT_SETTINGS, locale: 'en' } });
    expect(screen.getByText('© 2026 OrbitDrop contributors · MIT License')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy Diagnostics' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Privacy' })).toBeTruthy();
  });
});

describe('Settings › General › data', () => {
  it('opens the data folder', async () => {
    const { orbit } = renderWithEnv(<SettingsView />);
    await userEvent.setup().click(screen.getByRole('button', { name: '데이터 폴더 열기' }));
    expect(orbit.openDataFolder).toHaveBeenCalledTimes(1);
  });

  it('resets only after an in-window confirmation (never a native dialog); cancelling changes nothing', async () => {
    const { orbit } = renderWithEnv(<SettingsView />);
    const user = userEvent.setup();
    const reset = screen.getByRole('button', { name: '설정 초기화…' });
    await user.click(reset);
    const dialog = screen.getByRole('alertdialog', { name: '설정을 초기화할까요?' });
    expect(within(dialog).getByText(/언어와 작업 기록은 그대로입니다/)).toBeTruthy();
    // Esc picks the safe choice — and does not close the Settings window.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(orbit.resetSettings).not.toHaveBeenCalled();
    expect(orbit.closeWindow).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(reset);

    await user.click(reset);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '취소' }));
    expect(orbit.resetSettings).not.toHaveBeenCalled();

    await user.click(reset);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '초기화' }));
    expect(orbit.resetSettings).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('설정을 기본값으로 되돌렸습니다.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(reset));
  });

  it('a reset that fails says so', async () => {
    const orbit = createFakeOrbit();
    orbit.resetSettings.mockRejectedValueOnce(new Error('INTERNAL: Unexpected error'));
    renderWithEnv(<SettingsView />, { orbit });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '설정 초기화…' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '초기화' }));
    expect(await screen.findByText('설정을 초기화하지 못했습니다.')).toBeTruthy();
  });
});

describe('Settings › Drag: helper that gave up', () => {
  async function dragTab(status: HelperStatus) {
    const orbit = createFakeOrbit();
    orbit.getHelperStatus.mockResolvedValue(status);
    renderWithEnv(<SettingsView />, { orbit });
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: '드래그' }));
    return { orbit, user };
  }

  it('offers a restart when crashed', async () => {
    const { orbit, user } = await dragTab({ state: 'crashed', restarts: 5, reason: '도우미가 5번 비정상 종료되어 중지했습니다' });
    await user.click(await screen.findByRole('button', { name: '전역 드래그 다시 시작' }));
    expect(orbit.restartHelper).toHaveBeenCalledTimes(1);
  });

  it('a restart that fails is announced', async () => {
    const { orbit, user } = await dragTab({ state: 'crashed', restarts: 5, reason: 'x' });
    orbit.restartHelper.mockRejectedValueOnce(new Error('HELPER_UNAVAILABLE: no helper'));
    await user.click(await screen.findByRole('button', { name: '전역 드래그 다시 시작' }));
    expect((await screen.findByRole('alert')).textContent).toBe('전역 드래그를 다시 시작하지 못했습니다.');
  });

  it('no restart button while it runs', async () => {
    await dragTab({ state: 'running', helperVersion: '1.0.0', globalDrag: true });
    await screen.findByText(/실행 중/);
    expect(screen.queryByRole('button', { name: '전역 드래그 다시 시작' })).toBeNull();
  });
});

describe('hints name the real keys', () => {
  it('Jobs empty state: the current combos with Mac names on macOS', async () => {
    renderWithEnv(<JobsView />);
    expect(await screen.findByText('Finder에서 파일을 끌면서 Shift 키(변환)나 Option+Shift 키(도구)를 누르거나, Drop Zone에 파일을 놓아 보세요.')).toBeTruthy();
  });

  it('Jobs empty state on Windows: File Explorer and Ctrl+Shift (the Windows default)', async () => {
    renderWithEnv(<JobsView />, { orbit: createFakeOrbit({ platform: 'win32' }), settings: defaultSettingsFor('win32') });
    expect(await screen.findByText(/파일 탐색기에서 파일을 끌면서 Shift 키\(변환\)나 Ctrl\+Shift 키\(도구\)를 누르거나/)).toBeTruthy();
  });

  it('Drop Zone: names the convert key while global drag is on, says nothing when it is off', () => {
    const first = renderWithEnv(<DropZoneView />);
    expect(screen.getByText('Finder에서 파일을 끌면서 Shift 키를 누르면 이 창 없이도 휠이 열립니다.')).toBeTruthy();
    first.unmount();
    const off: Settings = { ...DEFAULT_SETTINGS, globalDrag: { ...DEFAULT_SETTINGS.globalDrag, enabled: false } };
    renderWithEnv(<DropZoneView />, { settings: off });
    expect(screen.queryByText(/이 창 없이도 휠이 열립니다/)).toBeNull();
  });
});
