// @vitest-environment jsdom
import './setup';
import type { ErrorCode, JobSnapshot } from '@orbitdrop/contracts';
import { act, cleanup as cleanupRender, screen, within } from '@testing-library/react';
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
    // Only the first page / frame of the input was used: the parameter is a count, not a page list.
    expect(warningDetail({ code: 'FIRST_PAGE_ONLY', params: { pages: 5, files: 1 } }, t)).toBe('전체 5페이지');
    expect(warningDetail({ code: 'FIRST_FRAME_ONLY', params: { frames: 24, files: 1 } }, t)).toBe('전체 24프레임');
    expect(warningDetail({ code: 'FIRST_FRAME_ONLY', params: { files: 1 } }, t)).toBeNull();
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

describe('JobsView retry', () => {
  const failed = (jobId: string, inputName: string, code: ErrorCode, finishedAt = 20) =>
    sampleJob({ jobId, actionId: 'convert.png', inputName, state: 'failed', error: { code, message: code, retryable: true }, finishedAt });

  it('offers retry, save elsewhere or both depending on the error, and retry for cancelled jobs', async () => {
    await renderJobs([
      failed('t', 'slow.pdf', 'TIMEOUT', 25),
      failed('d', 'full.jpg', 'DISK_FULL', 24),
      failed('r', 'readonly.jpg', 'OUTPUT_DIR_NOT_WRITABLE', 23),
      failed('x', 'scan.pdf', 'PDF_NO_TEXT', 22),
      sampleJob({ jobId: 'c', actionId: 'convert.webp', inputName: 'stopped.png', state: 'cancelled', finishedAt: 21 }),
    ]);
    const buttons = (name: string) =>
      within(cardOf(name))
        .queryAllByRole('button')
        .map((b) => b.textContent);
    expect(buttons('slow.pdf')).toEqual(['다시 시도']);
    expect(buttons('full.jpg')).toEqual(['다시 시도', '다른 폴더에 저장…']);
    expect(buttons('readonly.jpg')).toEqual(['다른 폴더에 저장…']);
    expect(buttons('scan.pdf')).toEqual([]);
    expect(buttons('stopped.png')).toEqual(['다시 시도']);
  });

  it('offers no retry for a job from an earlier run (history only), and shows "retried" for one main already retried', async () => {
    await renderJobs([
      { ...failed('h', 'before-restart.jpg', 'OUTPUT_DIR_NOT_WRITABLE', 25), earlierRun: true },
      { ...failed('o', 'old-timeout.pdf', 'TIMEOUT', 24), earlierRun: true },
      { ...failed('s', 'done-again.jpg', 'OUTPUT_DIR_NOT_WRITABLE', 23), retried: true },
    ]);
    expect(within(cardOf('before-restart.jpg')).queryAllByRole('button')).toEqual([]);
    expect(within(cardOf('old-timeout.pdf')).queryAllByRole('button')).toEqual([]);
    // Reopening the window keeps the note (main remembers the retry for the session).
    expect(within(cardOf('done-again.jpg')).getByText('다시 시도했습니다.')).toBeTruthy();
    expect(within(cardOf('done-again.jpg')).queryAllByRole('button')).toEqual([]);
  });

  it('a started retry replaces the buttons with "retried" and is announced', async () => {
    const { orbit, user } = await renderJobs([failed('t', 'slow.pdf', 'TIMEOUT')]);
    const card = cardOf('slow.pdf');
    await user.click(within(card).getByRole('button', { name: '다시 시도' }));
    expect(orbit.retryJob).toHaveBeenCalledWith('t');
    expect(await within(card).findByText('다시 시도했습니다.')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: '다시 시도' })).toBeNull();
    expect(screen.getByText('다시 시도를 시작했습니다.')).toBeTruthy();
  });

  it('explains a refused retry: a missing file (or a job from before a restart) versus other errors', async () => {
    const { orbit, user } = await renderJobs([failed('a', 'gone.png', 'TIMEOUT', 25), failed('b', 'cloud.png', 'CLOUD_PLACEHOLDER', 24)]);
    orbit.retryJob.mockResolvedValueOnce({ kind: 'rejected', error: { code: 'FILE_NOT_FOUND', message: 'gone', retryable: false } });
    await user.click(within(cardOf('gone.png')).getByRole('button', { name: '다시 시도' }));
    expect(await within(cardOf('gone.png')).findByText(/다시 시도할 수 없습니다/)).toBeTruthy();
    orbit.retryJob.mockResolvedValueOnce({ kind: 'rejected', error: { code: 'CLOUD_PLACEHOLDER', message: 'still', retryable: true } });
    await user.click(within(cardOf('cloud.png')).getByRole('button', { name: '다시 시도' }));
    const notice = await within(cardOf('cloud.png')).findByText('다시 시도하지 못했습니다.');
    expect(notice.closest('[role="alert"], .notice')?.textContent).toContain(koErrors['error.CLOUD_PLACEHOLDER']);
    // the buttons stay so the user can try again
    expect(within(cardOf('cloud.png')).getByRole('button', { name: '다시 시도' })).toBeTruthy();
  });
});

describe('JobsView clear finished', () => {
  it('clears up to the newest finish time on screen and announces how many were removed', async () => {
    const { orbit, user, emit } = await renderJobs();
    orbit.clearFinishedJobs.mockResolvedValueOnce(2);
    const button = screen.getByRole('button', { name: '끝난 작업 지우기' });
    expect(button.getAttribute('title')).toBe('완료·실패·취소된 작업을 목록과 기록에서 지웁니다. 결과 파일은 그대로 남습니다.');
    await user.click(button);
    // JOBS: finished at 10 (done) and 9 (fail); running jobs have no finish time
    expect(orbit.clearFinishedJobs).toHaveBeenCalledWith({ finishedUpTo: 10 });
    expect(await screen.findByText('작업 2개를 목록에서 지웠습니다.')).toBeTruthy();
    // main broadcasts the shorter list; without finished jobs the button goes away
    emit(JOBS.filter((j) => j.state === 'running'));
    expect(screen.queryByRole('button', { name: '끝난 작업 지우기' })).toBeNull();
    expect(screen.queryByText('big.jpg')).toBeNull();
    expect(screen.getByText('report.pdf')).toBeTruthy();
  });

  it('is not offered while nothing has finished, and reports a failure', async () => {
    const active = JOBS.filter((j) => j.state === 'running');
    await renderJobs(active);
    expect(screen.queryByRole('button', { name: '끝난 작업 지우기' })).toBeNull();
    cleanupRender();
    const { orbit, user } = await renderJobs();
    orbit.clearFinishedJobs.mockRejectedValueOnce(new Error('INTERNAL: boom'));
    await user.click(screen.getByRole('button', { name: '끝난 작업 지우기' }));
    expect(await screen.findByText('목록을 지우지 못했습니다.')).toBeTruthy();
  });
});

describe('JobsView titles', () => {
  it('names DOCX jobs by their input kind (contracts actionTitle)', async () => {
    await renderJobs([
      sampleJob({ jobId: 'p', actionId: 'convert.docx', inputName: 'report.pdf', state: 'completed', finishedAt: 5 }),
      sampleJob({ jobId: 'i', actionId: 'convert.docx', inputName: 'whiteboard.PNG', state: 'completed', finishedAt: 4 }),
    ]);
    expect(within(cardOf('report.pdf')).getByRole('heading', { level: 3 }).textContent).toBe('DOCX로 변환 (텍스트 중심)');
    expect(within(cardOf('whiteboard.PNG')).getByRole('heading', { level: 3 }).textContent).toBe('DOCX로 변환 (이미지 삽입, OCR 없음)');
  });
});
