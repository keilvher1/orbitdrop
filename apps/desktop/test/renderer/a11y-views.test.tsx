// @vitest-environment jsdom
import './setup';
import type { JobSnapshot, SubmitActionResult } from '@orbitdrop/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import koUi from '../../src/shared/locales/ko/ui.json';
import { EnvProvider } from '../../src/renderer/src/app/env';
import { DropZoneView } from '../../src/renderer/src/views/dropzone/DropZoneView';
import { AdjustEditor } from '../../src/renderer/src/views/editor/adjust/AdjustEditor';
import { CompressEditor } from '../../src/renderer/src/views/editor/compress/CompressEditor';
import { CropEditor } from '../../src/renderer/src/views/editor/crop/CropEditor';
import { JobsView } from '../../src/renderer/src/views/jobs/JobsView';
import { SettingsView } from '../../src/renderer/src/views/settings/SettingsView';
import { DEFAULT_SETTINGS, type OrbitApi } from '@orbitdrop/contracts';
import { createFakeOrbit, deferred, renderWithEnv, requestOsClose, sampleEditorContext, sampleImageInfo, sampleJob, sampleSelection } from './helpers';

/**
 * Accessibility fixes from the hardening audit (headless-Chromium measurements in
 * docs/workstreams/hardening-desktop.md): keyboard focus never falls to <body> when the focused control
 * turns itself off or goes away, no false error alert, no reference to missing elements, hints linked to
 * their fields, finished jobs announced once, the OS close of a stay-open save handled.
 */

function cropCtx() {
  return sampleEditorContext('tool.crop', {
    image: sampleImageInfo({ width: 2550, height: 3300, orientedWidth: 2550, orientedHeight: 3300, orientation: 1 }),
    defaults: { rect: { x: 0, y: 0, width: 2550, height: 3300 }, aspect: 'free' },
  });
}

describe('editor footer buttons keep keyboard focus', () => {
  it('Reset turns itself off but stays focused (aria-disabled, the click does nothing then)', async () => {
    const user = userEvent.setup();
    renderWithEnv(<AdjustEditor ctx={sampleEditorContext('tool.edit', { defaults: { rotate: 0, flipH: false, flipV: false, brightness: 0, contrast: 0, saturation: 0, outputFormat: 'input' } })} title="이미지 편집" />);
    const reset = screen.getByRole('button', { name: koUi['common.reset'] });
    expect(reset.getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('button', { name: koUi['adjust.flipV'] }));
    expect(reset.getAttribute('aria-disabled')).toBeNull();
    await user.click(reset);
    expect(reset.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(reset); // not <body>
    await user.keyboard('{Enter}'); // unavailable: nothing happens, focus stays
    expect(document.activeElement).toBe(reset);
  });

  it('the primary button stays focused while saving, and a second press does not save twice', async () => {
    const pending = deferred<SubmitActionResult>();
    const orbit = createFakeOrbit({ commitEditor: () => pending.promise });
    renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />, { orbit });
    const user = userEvent.setup();
    const apply = screen.getByRole('button', { name: koUi['common.apply'] });
    await user.click(apply);
    const saving = screen.getByRole('button', { name: /저장하는 중/ });
    expect(saving.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(saving);
    await user.click(saving);
    expect(orbit.commitEditor).toHaveBeenCalledTimes(1);
    pending.resolve({ kind: 'jobs', jobIds: ['job1'] });
    await waitFor(() => expect(orbit.closeWindow).toHaveBeenCalledTimes(1));
  });
});

describe('OS close requests', () => {
  it('every request is acknowledged with setCloseGuard (main counts a window that does not as hung)', () => {
    const orbit = createFakeOrbit();
    renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />, { orbit });
    orbit.setCloseGuard.mockClear();
    act(() => requestOsClose(orbit));
    expect(orbit.setCloseGuard).toHaveBeenCalledWith(false);
  });

  it('Compress: an OS close during its stay-open save closes the result view once the save went through', async () => {
    const pending = deferred<SubmitActionResult>();
    const orbit = createFakeOrbit({ commitEditor: () => pending.promise, listJobs: async () => [] });
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { defaults: { format: 'jpeg', quality: 75, maxEdge: null, pngMode: 'palette', keepMetadata: false } })} title="압축" />, { orbit });
    await waitFor(() => expect(orbit.requestPreview).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /압축해서 저장|압축/ }));
    await waitFor(() => expect(orbit.commitEditor).toHaveBeenCalledTimes(1));
    act(() => requestOsClose(orbit));
    expect(orbit.cancelEditor).not.toHaveBeenCalled(); // saving: remembered, not acted on yet
    await act(async () => pending.resolve({ kind: 'jobs', jobIds: ['job1'] }));
    await waitFor(() => expect(orbit.closeWindow).toHaveBeenCalledTimes(1));
  });

  it('Compress: after a failed save the remembered close is dropped, so the error stays visible', async () => {
    const pending = deferred<SubmitActionResult>();
    const orbit = createFakeOrbit({ commitEditor: () => pending.promise, listJobs: async () => [] });
    renderWithEnv(<CompressEditor ctx={sampleEditorContext('tool.compress', { defaults: { format: 'jpeg', quality: 75, maxEdge: null, pngMode: 'palette', keepMetadata: false } })} title="압축" />, { orbit });
    await waitFor(() => expect(orbit.requestPreview).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /압축해서 저장|압축/ }));
    await waitFor(() => expect(orbit.commitEditor).toHaveBeenCalledTimes(1));
    act(() => requestOsClose(orbit));
    await act(async () => pending.resolve({ kind: 'rejected', error: { code: 'DISK_FULL', message: 'full', retryable: true } }));
    expect(await screen.findByText(koUi['editor.commitFailed'])).toBeTruthy();
    expect(orbit.closeWindow).not.toHaveBeenCalled();
    expect(orbit.cancelEditor).not.toHaveBeenCalled();
  });
});

describe('Crop', () => {
  it('changing the aspect ratio never inserts an error alert, not even for one frame', async () => {
    renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />);
    const alerts: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && (node.getAttribute('role') === 'alert' || node.querySelector('[role="alert"]'))) alerts.push(node.textContent ?? '');
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const user = userEvent.setup();
    for (const ratio of ['1:1', '16:9', '9:16', '4:3', '3:4']) await user.click(screen.getByRole('radio', { name: ratio }));
    observer.disconnect();
    expect(alerts).toEqual([]);
    expect(screen.getByRole('button', { name: koUi['common.apply'] }).getAttribute('aria-disabled')).toBeNull();
  });

  it('the selection is an operable application region (screen readers switch to focus mode)', () => {
    renderWithEnv(<CropEditor ctx={cropCtx()} title="이미지 자르기" />);
    const selection = screen.getByRole('application', { name: /자르기 영역/ });
    expect(selection.tabIndex).toBe(0);
  });
});

describe('Settings', () => {
  it('only the selected tab points at a panel (aria-controls), and that panel exists', async () => {
    renderWithEnv(<SettingsView />);
    const tabs = await screen.findAllByRole('tab');
    const withControls = tabs.filter((tab) => tab.hasAttribute('aria-controls'));
    expect(withControls).toHaveLength(1);
    expect(withControls[0]!.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById(withControls[0]!.getAttribute('aria-controls')!)?.getAttribute('role')).toBe('tabpanel');
    await userEvent.setup().click(screen.getByRole('tab', { name: koUi['settings.tab.processing'] }));
    for (const tab of screen.getAllByRole('tab')) {
      const controls = tab.getAttribute('aria-controls');
      if (controls !== null) expect(document.getElementById(controls), controls).not.toBeNull();
    }
  });

  it('the number fields are described by their hints', async () => {
    renderWithEnv(<SettingsView />);
    const user = userEvent.setup();
    for (const [tab, name] of [
      ['settings.tab.output', 'settings.bgMaxEdge'],
      ['settings.tab.processing', 'settings.timeout'],
    ] as const) {
      await user.click(await screen.findByRole('tab', { name: koUi[tab] }));
      const field = screen.getByRole('spinbutton', { name: koUi[name] });
      const hint = document.getElementById(field.getAttribute('aria-describedby') ?? '');
      expect(hint?.textContent, name).toMatch(/\d/);
    }
  });
});

describe('Jobs window', () => {
  function jobsOrbit(initial: readonly JobSnapshot[]) {
    let listener: ((jobs: readonly JobSnapshot[]) => void) | null = null;
    const orbit = createFakeOrbit({
      listJobs: async () => initial,
      onJobsChanged: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    });
    return { orbit, emit: (next: readonly JobSnapshot[]) => act(() => listener?.(next)) };
  }

  const running = sampleJob({ jobId: 'job_run', state: 'running', inputName: 'scan.pdf', actionId: 'convert.jpeg', outputs: [], finishedAt: null, progress: { kind: 'indeterminate' } });

  it('cancelling moves the card to "Recent" and keyboard focus follows it (not <body>)', async () => {
    const { orbit, emit } = jobsOrbit([running]);
    renderWithEnv(<JobsView />, { orbit });
    const cancel = await screen.findByRole('button', { name: koUi['jobs.cancel'] });
    const user = userEvent.setup();
    await user.click(cancel);
    expect(orbit.cancelJob).toHaveBeenCalledWith('job_run');
    emit([{ ...running, state: 'cancelled', finishedAt: 10 }]);
    await waitFor(() => expect(document.activeElement?.classList.contains('job-title')).toBe(true));
    expect(document.activeElement?.closest('[data-job-id]')?.getAttribute('data-job-id')).toBe('job_run');
  });

  it('jobs finishing while the window is open are announced once per update; history is not news', async () => {
    const old = sampleJob({ jobId: 'job_old', state: 'completed', inputName: 'old.png', finishedAt: 1 });
    const { orbit, emit } = jobsOrbit([running, old]);
    renderWithEnv(<JobsView />, { orbit });
    await screen.findByText('scan.pdf');
    const live = document.querySelector('.jobs-view [aria-live="polite"]')!;
    expect(live.textContent).toBe('');
    emit([{ ...running, state: 'completed', finishedAt: 20, outputs: [{ outputId: 'out_1', name: 'scan.jpg', dirDisplay: 'Desktop', format: 'jpeg', bytes: 10 }] }, old]);
    expect(live.textContent).toMatch(/완료: scan\.jpg$/);
    const a = sampleJob({ jobId: 'job_a', state: 'running', inputName: 'a.png', outputs: [], finishedAt: null });
    const b = sampleJob({ jobId: 'job_b', state: 'queued', inputName: 'b.png', outputs: [], finishedAt: null });
    emit([a, b]);
    emit([
      { ...a, state: 'failed', finishedAt: 30, error: { code: 'DISK_FULL', message: 'full', retryable: true } },
      { ...b, state: 'completed', finishedAt: 31 },
    ]);
    expect(live.textContent).toBe('작업 2개가 끝났습니다.');
  });

  it('under StrictMode a retried job still shows its "retried" note (the mounted flag is set again)', async () => {
    const cancelled = sampleJob({ jobId: 'job_c', state: 'cancelled', inputName: 'c.png', outputs: [], finishedAt: 5 });
    const { orbit } = jobsOrbit([cancelled]);
    render(
      <StrictMode>
        <EnvProvider orbit={orbit as unknown as OrbitApi} initialSettings={DEFAULT_SETTINGS}>
          <JobsView />
        </EnvProvider>
      </StrictMode>,
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: koUi['jobs.retry'] }));
    expect(await screen.findByText(koUi['jobs.retried'])).toBeTruthy();
  });
});

describe('Drop Zone', () => {
  it('dismissing the status notice moves focus to "파일 열기…" instead of <body>', async () => {
    const orbit = createFakeOrbit();
    orbit.openFileDialog.mockResolvedValue(sampleSelection());
    renderWithEnv(<DropZoneView />, { orbit });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: koUi['dropzone.open'] }));
    const menu = await screen.findByRole('menu', { name: '변환 메뉴' });
    await waitFor(() => expect(menu.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0));
    menu.focus();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(await screen.findByText(koUi['dropzone.started'])).toBeTruthy();
    await user.click(screen.getByRole('button', { name: koUi['common.dismiss'] }));
    expect(screen.queryByText(koUi['dropzone.started'])).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: koUi['dropzone.open'] }));
  });
});
