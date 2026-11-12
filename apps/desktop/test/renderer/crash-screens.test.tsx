// @vitest-environment jsdom
import './setup';
import type { OrbitApi, WindowContext, WindowNotice } from '@orbitdrop/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/src/app/App';
import { bootstrap } from '../../src/renderer/src/app/bootstrap';
import { WindowNoticeBanner } from '../../src/renderer/src/app/crash';
import { reportRendererError } from '../../src/renderer/src/app/reportError';
import { WINDOW_PROBE, judgeWindow, type WindowProbe } from '../../src/shared/window-probe';
import { createFakeOrbit, renderWithEnv } from './helpers';

// The Jobs view crashes while rendering (a stand-in for any rendering bug).
vi.mock('../../src/renderer/src/views/jobs/JobsView', () => ({
  JobsView: () => {
    throw new TypeError("Cannot read properties of undefined (reading 'state') at /Users/someone/x.js");
  },
}));

const probe = (): WindowProbe => (0, eval)(WINDOW_PROBE) as WindowProbe;
const containers: HTMLElement[] = [];

beforeEach(() => {
  // React reports errors caught by error boundaries on the console.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const container of containers.splice(0)) container.remove();
});

function renderApp(context: WindowContext, notice: WindowNotice | null = null, orbit = createFakeOrbit()) {
  const view = renderWithEnv(<App context={context} notice={notice} />, { orbit });
  return { ...view, orbit, user: userEvent.setup() };
}

describe('a view that crashes', () => {
  it('is reported to main (validated payload) and replaced by a translated crash screen with a way out', async () => {
    const { orbit, user } = renderApp({ kind: 'jobs' });
    expect(await screen.findByRole('heading', { name: '이 창에 문제가 생겼습니다' })).toBeTruthy();
    expect(screen.getByText(/화면을 그리는 중에 오류가 생겼습니다/)).toBeTruthy();
    expect(orbit.reportRendererError).toHaveBeenCalledTimes(1);
    const report = orbit.reportRendererError.mock.calls[0]![0];
    expect(report).toMatchObject({ source: 'boundary', name: 'TypeError' });
    expect(report.message).toContain("reading 'state'");
    expect(typeof report.componentStack).toBe('string');
    // The developer text is only behind the disclosure.
    expect(screen.getByText('자세한 내용')).toBeTruthy();
    // Work that was in the view is gone: closing must not ask about it.
    expect(orbit.setCloseGuard).toHaveBeenCalledWith(false);
    const close = screen.getByRole('button', { name: '창 닫기' });
    await waitFor(() => expect(document.activeElement).toBe(close));
    await user.click(screen.getByRole('button', { name: '로그 폴더 열기' }));
    expect(orbit.openLogFolder).toHaveBeenCalledTimes(1);
    await user.click(close);
    expect(orbit.closeWindow).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(orbit.closeWindow).toHaveBeenCalledTimes(2);
  });

  it('counts as a failure for the smoke test probe', async () => {
    const { orbit } = renderApp({ kind: 'jobs' });
    await screen.findByRole('heading', { name: '이 창에 문제가 생겼습니다' });
    (window as { orbit?: unknown }).orbit = orbit;
    try {
      expect(judgeWindow(probe(), '0.1.0').error).toMatch(/^the window shows an error: .*이 창에 문제가 생겼습니다/);
    } finally {
      delete (window as { orbit?: unknown }).orbit;
    }
  });

  it('reporting never throws, and trims what it sends to the contract limits', () => {
    const send = vi.fn();
    const huge = Object.assign(new Error('m'.repeat(10_000)), { stack: 's'.repeat(50_000) });
    reportRendererError({ reportRendererError: send }, 'boundary', huge, 'c'.repeat(50_000));
    const sent = send.mock.calls[0]![0];
    expect(sent.message).toHaveLength(4000);
    expect(sent.stack).toHaveLength(16_000);
    expect(sent.componentStack).toHaveLength(16_000);
    reportRendererError(undefined, 'bootstrap', 'not an error');
    reportRendererError(
      {
        reportRendererError: () => {
          throw new Error('ipc gone');
        },
      },
      'boundary',
      new Error('x'),
    );
  });
});

describe('a page main reloaded after a crash', () => {
  it('first crash: the view is back with a notice (warning, dismissible)', async () => {
    const { user } = renderApp({ kind: 'about' }, { kind: 'recovered', unsavedLost: false });
    expect(await screen.findByText('이 창이 예기치 않게 종료되어 다시 열었습니다.')).toBeTruthy();
    expect(await screen.findByText(/버전 0\.1\.0/)).toBeTruthy(); // the About view itself
    await user.click(screen.getByRole('button', { name: '알림 닫기' }));
    expect(screen.queryByText('이 창이 예기치 않게 종료되어 다시 열었습니다.')).toBeNull();
  });

  it('an editor explains what was lost', () => {
    renderWithEnv(<WindowNoticeBanner notice={{ kind: 'recovered', unsavedLost: true }} editor />);
    expect(screen.getByText(/고르던 편집 설정은 처음 상태로 돌아갔습니다/)).toBeTruthy();
    expect(screen.getByText('저장하지 않은 주석이나 가림 영역은 사라졌습니다.')).toBeTruthy();
  });

  it('second crash: only the crash screen, never the view; an editor says its unsaved work is gone', async () => {
    const { orbit } = renderApp({ kind: 'editor', editorId: 'ed1' }, { kind: 'failed', unsavedLost: true });
    expect(screen.getByRole('heading', { name: '이 창을 다시 열 수 없습니다' })).toBeTruthy();
    expect(screen.getByText('이 편집 창에서 저장하지 않은 내용은 사라졌습니다.')).toBeTruthy();
    expect(screen.getByText('저장하지 않은 주석이나 가림 영역은 사라졌습니다.')).toBeTruthy();
    expect(orbit.getEditor).not.toHaveBeenCalled(); // the editor view never mounted
  });
});

async function boot(orbit: OrbitApi | undefined): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  await act(async () => {
    await bootstrap(container, orbit);
  });
  return container;
}

describe('a window that cannot start its view', () => {
  it('says so in the settings language, with close and log-folder buttons, and reports it', async () => {
    const orbit = createFakeOrbit();
    const settings = await orbit.getSettings();
    orbit.getSettings.mockResolvedValue({ ...settings, locale: 'en' });
    orbit.getWindowContext.mockRejectedValue(new Error('INTERNAL: Untrusted sender'));
    await boot(orbit as unknown as OrbitApi);
    expect(screen.getByText("Couldn't open this window.")).toBeTruthy();
    expect(screen.queryByText('창을 열지 못했습니다.')).toBeNull();
    expect(screen.getByText('INTERNAL: Untrusted sender')).toBeTruthy();
    expect(orbit.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({ source: 'bootstrap', message: 'INTERNAL: Untrusted sender' }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open Log Folder' }));
    expect(orbit.openLogFolder).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close Window' }));
    expect(orbit.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('no settings either: Korean and English', async () => {
    const orbit = createFakeOrbit();
    orbit.getWindowContext.mockRejectedValue(new Error('boom'));
    orbit.getSettings.mockRejectedValue(new Error('no main'));
    await boot(orbit as unknown as OrbitApi);
    expect(screen.getByText('창을 열지 못했습니다.')).toBeTruthy();
    expect(screen.getByText("Couldn't open this window.")).toBeTruthy();
    expect(screen.getByRole('button', { name: '창 닫기 / Close Window' })).toBeTruthy();
  });

  it('a page reloaded after a second crash boots into the crash screen', async () => {
    const orbit = createFakeOrbit();
    orbit.getWindowContext.mockResolvedValue({ kind: 'settings' });
    orbit.getWindowNotice.mockResolvedValue({ kind: 'failed', unsavedLost: false });
    await boot(orbit as unknown as OrbitApi);
    expect(await screen.findByRole('heading', { name: '이 창을 다시 열 수 없습니다' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull(); // not the Settings view
  });
});
