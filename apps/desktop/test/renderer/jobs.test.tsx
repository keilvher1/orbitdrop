// @vitest-environment jsdom
import './setup';
import type { JobSnapshot } from '@orbitdrop/contracts';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import koErrors from '../../src/shared/locales/ko/errors.json';
import { JobsView, partitionJobs, warningDetail } from '../../src/renderer/src/views/jobs/JobsView';
import { createTranslator } from '../../src/renderer/src/i18n/catalog';
import { createFakeOrbit, deferred, renderWithEnv, sampleJob } from './helpers';

const JOBS: JobSnapshot[] = [
  sampleJob({
    jobId: 'det',
    actionId: 'convert.jpeg',
    inputName: 'report.pdf',
    state: 'running',
    progress: { kind: 'determinate', done: 3, total: 10, unit: 'page' },
    createdAt: 1,
  }),
  sampleJob({ jobId: 'ind', actionId: 'convert.png', inputName: 'photo.jpg', state: 'running', progress: { kind: 'indeterminate', stage: 'encoding' }, createdAt: 2 }),
  sampleJob({
    jobId: 'done',
    actionId: 'tool.compress',
    inputName: 'big.jpg',
    state: 'completed',
    inputBytes: 1000,
    outputs: [{ outputId: 'out1', name: 'big Compressed.jpg', dirDisplay: 'Desktop', format: 'jpeg', bytes: 1200 }],
    warnings: [{ code: 'OUTPUT_LARGER_THAN_INPUT' }],
    finishedAt: 10,
  }),
  sampleJob({
    jobId: 'fail',
    actionId: 'convert.webp',
    inputName: 'locked.png',
    state: 'failed',
    error: { code: 'OUTPUT_DIR_NOT_WRITABLE', message: 'EACCES', retryable: true },
    finishedAt: 9,
  }),
];

function cardOf(name: string): HTMLElement {
  const card = screen.getByText(name).closest('li.job-card');
  if (!(card instanceof HTMLElement)) throw new Error(`no card for ${name}`);
  return card;
}

async function renderJobs(jobs: readonly JobSnapshot[] = JOBS) {
  let listener: ((jobs: readonly JobSnapshot[]) => void) | null = null;
  const orbit = createFakeOrbit({
    listJobs: async () => jobs,
    onJobsChanged: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  });
  const view = renderWithEnv(<JobsView />, { orbit });
  await screen.findByText(jobs[0]?.inputName ?? '아직 작업이 없습니다.');
  return { ...view, orbit, emit: (next: readonly JobSnapshot[]) => act(() => listener?.(next)), user: userEvent.setup() };
}

describe('JobsView progress', () => {
  it('shows a determinate bar with aria-valuenow for counted progress', async () => {
    await renderJobs();
    const bar = screen.getByRole('progressbar', { name: 'JPG로 변환 진행률' });
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemax')).toBe('10');
    expect(bar.getAttribute('aria-valuetext')).toBe('3/10 페이지');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('30%');
  });

  it('shows an indeterminate bar without aria-valuenow, labelled with the stage', async () => {
    await renderJobs();
    const bar = screen.getByRole('progressbar', { name: 'PNG로 변환 진행률' });
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.getAttribute('aria-valuetext')).toBe('인코딩 중');
    expect(bar.getAttribute('data-indeterminate')).toBe('true');
  });

  it('separates active (oldest first) from recent (newest first) jobs', () => {
    const { active, recent } = partitionJobs(JOBS);
    expect(active.map((j) => j.jobId)).toEqual(['det', 'ind']);
    expect(recent.map((j) => j.jobId)).toEqual(['done', 'fail']);
  });
});

describe('JobsView actions', () => {
  it('cancels a running job', async () => {
    const { orbit, user } = await renderJobs();
    await user.click(within(cardOf('report.pdf')).getByRole('button', { name: '작업 취소' }));
    expect(orbit.cancelJob).toHaveBeenCalledWith('det');
    expect(within(cardOf('big.jpg')).queryByRole('button', { name: '작업 취소' })).toBeNull();
  });

  it('offers "save to another folder" for OUTPUT_DIR_NOT_WRITABLE and shows a rejected retry', async () => {
    const { orbit, user } = await renderJobs();
    const card = cardOf('locked.png');
    expect(within(card).getByText(koErrors['error.OUTPUT_DIR_NOT_WRITABLE'])).toBeTruthy();
    orbit.retryJobElsewhere.mockResolvedValueOnce({ kind: 'rejected', error: { code: 'DISK_FULL', message: 'ENOSPC', retryable: true } });
    await user.click(within(card).getByRole('button', { name: '다른 폴더에 저장…' }));
    expect(orbit.retryJobElsewhere).toHaveBeenCalledWith('fail');
    expect(await within(card).findByText(koErrors['error.DISK_FULL'])).toBeTruthy();
  });

  it('a cancelled folder picker (null) shows nothing extra', async () => {
    const { orbit, user } = await renderJobs();
    const card = cardOf('locked.png');
    await user.click(within(card).getByRole('button', { name: '다른 폴더에 저장…' }));
    expect(orbit.retryJobElsewhere).toHaveBeenCalledTimes(1);
    expect(within(card).queryByRole('alert')).toBeNull();
  });

  it('reveals and opens outputs by outputId', async () => {
    const { orbit, user } = await renderJobs();
    const output = screen.getByText('big Compressed.jpg').closest('li') as HTMLElement;
    await user.click(within(output).getByRole('button', { name: 'Finder에서 보기' }));
    await user.click(within(output).getByRole('button', { name: '열기' }));
    expect(orbit.revealOutput).toHaveBeenCalledWith('out1');
    expect(orbit.openOutput).toHaveBeenCalledWith('out1');
  });
});

describe('JobsView results and warnings', () => {
  it('a larger compression result reads as a warning, never as success', async () => {
    await renderJobs();
    const card = cardOf('big.jpg');
    expect(within(card).getAllByText(koErrors['warning.OUTPUT_LARGER_THAN_INPUT'])).toHaveLength(1);
    expect(within(card).getByText('+20%')).toBeTruthy();
    expect(card.textContent).not.toMatch(/성공/);
  });

  it('adds the warning even when the processor did not report it', async () => {
    await renderJobs([
      sampleJob({
        jobId: 'c2',
        actionId: 'tool.compress',
        inputName: 'x.png',
        state: 'completed',
        inputBytes: 500,
        outputs: [{ outputId: 'o', name: 'x Compressed.png', dirDisplay: 'Desktop', format: 'png', bytes: 500 }],
        finishedAt: 3,
      }),
    ]);
    expect(screen.getByText(koErrors['warning.OUTPUT_LARGER_THAN_INPUT'])).toBeTruthy();
  });

  it('renders known warning params', () => {
    const t = createTranslator('ko');
    expect(warningDetail({ code: 'PDF_PAGES_WITHOUT_TEXT', params: { pages: '3, 5' } }, t)).toBe('페이지: 3, 5');
    expect(warningDetail({ code: 'DOWNSCALED', params: { width: 800, height: 600 } }, t)).toBe('800 × 600 px');
    expect(warningDetail({ code: 'DOWNSCALED', params: { secret: 'x' } }, t)).toBeNull();
  });

  it('shows the empty state', async () => {
    await renderJobs([]);
    expect(screen.getByText('아직 작업이 없습니다.')).toBeTruthy();
  });
});

describe('JobsView live updates', () => {
  it('replaces the list when onJobsChanged fires', async () => {
    const { emit } = await renderJobs();
    emit([sampleJob({ jobId: 'new', inputName: 'new.png', state: 'queued', createdAt: 5 })]);
    expect(screen.getByText('new.png')).toBeTruthy();
    expect(screen.queryByText('report.pdf')).toBeNull();
    expect(screen.getByText('대기 중')).toBeTruthy();
  });

  it('ignores a late listJobs snapshot after a live update', async () => {
    const list = deferred<readonly JobSnapshot[]>();
    let listener: ((jobs: readonly JobSnapshot[]) => void) | null = null;
    const orbit = createFakeOrbit({
      listJobs: () => list.promise,
      onJobsChanged: (l) => {
        listener = l;
        return () => undefined;
      },
    });
    renderWithEnv(<JobsView />, { orbit });
    act(() => listener?.([sampleJob({ jobId: 'live', inputName: 'live.jpg' })]));
    await act(async () => list.resolve([sampleJob({ jobId: 'old', inputName: 'old.jpg' })]));
    expect(screen.getByText('live.jpg')).toBeTruthy();
    expect(screen.queryByText('old.jpg')).toBeNull();
  });

  it('unsubscribes on unmount', async () => {
    let unsubscribed = false;
    const orbit = createFakeOrbit({
      onJobsChanged: () => () => {
        unsubscribed = true;
      },
    });
    const view = renderWithEnv(<JobsView />, { orbit });
    await screen.findByText('아직 작업이 없습니다.');
    view.unmount();
    expect(unsubscribed).toBe(true);
  });
});
