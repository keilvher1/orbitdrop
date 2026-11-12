// @vitest-environment jsdom
import './setup';
import { DEFAULT_SETTINGS, RELEASES_URL, applySettingsPatch, isAllowedExternalUrl, type AppInfo } from '@orbitdrop/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AboutView } from '../../src/renderer/src/views/settings/AboutView';
import { SettingsView } from '../../src/renderer/src/views/settings/SettingsView';
import { WINDOW_PROBE, judgeWindow, type WindowProbe } from '../../src/shared/window-probe';
import { createFakeOrbit, deferred, pushUpdateState, renderWithEnv, sampleUpdateState } from './helpers';

const probe = (): WindowProbe => (0, eval)(WINDOW_PROBE) as WindowProbe;

afterEach(() => {
  delete (window as { orbit?: unknown }).orbit;
});

async function about(options: { readonly info?: Partial<AppInfo>; readonly locale?: 'ko' | 'en' } = {}) {
  const orbit = createFakeOrbit();
  const info = await orbit.getAppInfo();
  orbit.getAppInfo.mockResolvedValue({ ...info, ...options.info });
  const settings = options.locale === 'en' ? applySettingsPatch(DEFAULT_SETTINGS, { locale: 'en' })! : DEFAULT_SETTINGS;
  const view = renderWithEnv(<AboutView />, { orbit, settings });
  const section = await screen.findByRole('region', { name: options.locale === 'en' ? 'Updates' : '업데이트' });
  return { ...view, orbit, section, user: userEvent.setup() };
}

describe('About › version', () => {
  it('shows the commit a package was built from next to the version', async () => {
    await about({ info: { packaged: true, build: { commit: '6d75758', dirty: false, signing: 'developer-id' } } });
    expect(screen.getByText('버전 0.1.0 (6d75758)')).toBeTruthy();
  });

  it('marks a build from uncommitted changes; development runs show the version only', async () => {
    const first = await about({ info: { packaged: true, build: { commit: '6d75758', dirty: true, signing: 'adhoc' } } });
    expect(screen.getByText('버전 0.1.0 (6d75758-dirty)')).toBeTruthy();
    first.unmount();
    await about();
    expect(screen.getByText('버전 0.1.0')).toBeTruthy();
  });
});

describe('About › 업데이트', () => {
  it('up to date: status and last check; "지금 확인" asks main; the releases page opens on GitHub', async () => {
    const { orbit, section, user } = await about();
    expect(await within(section).findByText('최신 버전입니다.')).toBeTruthy();
    expect(within(section).getByText(/^마지막 확인: /)).toBeTruthy();
    const check = within(section).getByRole('button', { name: '지금 확인' });
    const answer = deferred<ReturnType<typeof sampleUpdateState>>();
    orbit.checkForUpdates.mockReturnValueOnce(answer.promise);
    await user.click(check);
    expect(orbit.checkForUpdates).toHaveBeenCalledTimes(1);
    expect((check as HTMLButtonElement).disabled).toBe(true); // no second request while one runs
    await act(async () => answer.resolve(sampleUpdateState({ lastCheckedAt: Date.now() })));
    expect((check as HTMLButtonElement).disabled).toBe(false);

    await user.click(within(section).getByRole('button', { name: 'GitHub 릴리스 페이지' }));
    expect(orbit.openExternal).toHaveBeenCalledWith(RELEASES_URL);
    expect(isAllowedExternalUrl(RELEASES_URL)).toBe(true);
  });

  it('follows the state main pushes: checking, downloading, downloaded with "재시작하여 업데이트"', async () => {
    const { orbit, section, user } = await about();
    await within(section).findByText('최신 버전입니다.');
    act(() => pushUpdateState(orbit, sampleUpdateState({ state: 'checking' })));
    expect(within(section).getByText('업데이트를 확인하는 중…')).toBeTruthy();
    expect((within(section).getByRole('button', { name: '지금 확인' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(section).queryByText(/^마지막 확인/)).toBeNull();

    act(() => pushUpdateState(orbit, sampleUpdateState({ state: 'downloading', version: '0.2.0', percent: 42 })));
    expect(within(section).getByText('0.2.0 버전을 내려받는 중… 42%')).toBeTruthy();

    act(() => pushUpdateState(orbit, sampleUpdateState({ state: 'downloaded', version: '0.2.0', restartPending: false })));
    expect(within(section).getByText('0.2.0 버전이 준비되었습니다. 종료하면 설치됩니다.')).toBeTruthy();
    expect(within(section).queryByRole('button', { name: '지금 확인' })).toBeNull();
    orbit.restartToUpdate.mockResolvedValueOnce(sampleUpdateState({ state: 'downloaded', version: '0.2.0', restartPending: true }));
    await user.click(within(section).getByRole('button', { name: '재시작하여 업데이트' }));
    expect(orbit.restartToUpdate).toHaveBeenCalledTimes(1);
    // Jobs were running: the restart waits, and the button says so.
    const waiting = await within(section).findByRole('button', { name: '다시 시작 대기 중…' });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    expect(within(section).getByText('진행 중인 작업이 끝나면 다시 시작해 업데이트합니다.')).toBeTruthy();
  });

  it('a build that cannot update explains why and offers no check', async () => {
    const orbit = createFakeOrbit();
    orbit.getUpdateState.mockResolvedValue(sampleUpdateState({ state: 'unsupported', reason: 'notSigned', lastCheckedAt: null }));
    renderWithEnv(<AboutView />, { orbit });
    const section = await screen.findByRole('region', { name: '업데이트' });
    expect(await within(section).findByText(/서명되지 않은 테스트 빌드라 자동으로 업데이트되지 않습니다/)).toBeTruthy();
    expect(within(section).queryByRole('button', { name: '지금 확인' })).toBeNull();
    expect(within(section).getByRole('button', { name: 'GitHub 릴리스 페이지' })).toBeTruthy();
  });

  it('with automatic checks off and nothing checked yet, says how to check', async () => {
    const orbit = createFakeOrbit();
    orbit.getUpdateState.mockResolvedValue(sampleUpdateState({ state: 'idle', autoCheck: false, lastCheckedAt: null }));
    renderWithEnv(<AboutView />, { orbit });
    expect(await screen.findByText('자동 확인이 꺼져 있습니다. ‘지금 확인’으로 확인할 수 있습니다.')).toBeTruthy();
  });

  it('a failed check is quiet text — no danger notice, so the smoke test still sees a rendered window', async () => {
    const orbit = createFakeOrbit();
    orbit.getUpdateState.mockResolvedValue(sampleUpdateState({ state: 'error', error: 'offline' }));
    renderWithEnv(<AboutView />, { orbit });
    (window as { orbit?: unknown }).orbit = orbit;
    expect(await screen.findByText('인터넷에 연결되어 있지 않아 업데이트를 확인하지 못했습니다.')).toBeTruthy();
    expect(document.querySelector('.notice[data-tone="danger"]')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(judgeWindow(probe(), '0.1.0')).toEqual({ rendered: true, error: null });
  });

  it('in English', async () => {
    const { orbit, section } = await about({ locale: 'en' });
    expect(await within(section).findByText('OrbitDrop is up to date.')).toBeTruthy();
    act(() => pushUpdateState(orbit, sampleUpdateState({ state: 'downloaded', version: '0.2.0', restartPending: false })));
    expect(within(section).getByRole('button', { name: 'Restart to Update' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Releases on GitHub' })).toBeTruthy();
  });

  it('stops listening when the window goes away', async () => {
    const { orbit, unmount } = await about();
    const unsubscribed = orbit.onUpdateStateChanged.mock.results[0]?.value as () => void;
    expect(typeof unsubscribed).toBe('function');
    unmount();
    expect(() => pushUpdateState(orbit, sampleUpdateState({ state: 'checking' }))).not.toThrow();
  });
});

describe('Settings › 일반 › 업데이트 자동 확인', () => {
  it('a switch, on by default, described by one privacy line; toggling saves updates.autoCheck', async () => {
    const orbit = createFakeOrbit();
    renderWithEnv(<SettingsView />, { orbit });
    const user = userEvent.setup();
    const toggle = screen.getByRole('switch', { name: '업데이트 자동 확인' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    const hint = document.getElementById(toggle.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('확인할 때 GitHub에는 IP 주소 같은 일반 접속 정보와 이 운영체제용 업데이트 파일 요청만 전달되며, 기기 식별자나 파일·사용 기록은 보내지 않습니다.');
    await user.click(toggle);
    expect(orbit.updateSettings).toHaveBeenCalledWith({ updates: { autoCheck: false } });
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
  });

  it('in English', () => {
    renderWithEnv(<SettingsView />, { settings: applySettingsPatch(DEFAULT_SETTINGS, { locale: 'en', updates: { autoCheck: false } })! });
    const toggle = screen.getByRole('switch', { name: 'Check for updates automatically' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/no device ID, files or usage data/)).toBeTruthy();
  });
});
