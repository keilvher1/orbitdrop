import {
  ACTIONS,
  FORMAT_INFO,
  RETRY_ELSEWHERE_CODES,
  TERMINAL_JOB_STATES,
  actionTitle,
  canRetryJob,
  formatFromExtension,
  inputKindOf,
  type InputKind,
  type JobProgress,
  type JobSnapshot,
  type JobWarning,
  type OrbitErrorInfo,
  type OutputFileInfo,
} from '@orbitdrop/contracts';
import { FolderOpen, ListX, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useEnv } from '../../app/env';
import { asErrorInfo } from '../../app/errors';
import { comboLabel } from '../../app/keys';
import { useEscapeKey } from '../../app/useEscapeKey';
import { ActionIcon } from '../../components/ActionIcon';
import { Notice, Spinner } from '../../components/Notice';
import { TitleBar } from '../../components/TitleBar';
import { formatBytes, formatTime, percentChange } from '../../i18n/format';
import './jobs.css';

/** Outputs listed per job before collapsing the rest into "N more". */
const MAX_VISIBLE_OUTPUTS = 4;

/** Active jobs oldest first; finished jobs newest first. */
export function partitionJobs(jobs: readonly JobSnapshot[]): { active: JobSnapshot[]; recent: JobSnapshot[] } {
  const active = jobs.filter((j) => !TERMINAL_JOB_STATES.has(j.state)).sort((a, b) => a.createdAt - b.createdAt);
  const recent = jobs
    .filter((j) => TERMINAL_JOB_STATES.has(j.state))
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
  return { active, recent };
}

/**
 * Cut-off for "clear finished": the newest finish time among the finished
 * jobs on screen (main's clock), so a job that finishes while the user clicks
 * is not removed unseen. null when nothing finished is listed.
 */
export function finishedCutoff(recent: readonly JobSnapshot[]): number | null {
  let cutoff: number | null = null;
  for (const job of recent) cutoff = Math.max(cutoff ?? 0, job.finishedAt ?? job.createdAt);
  return cutoff;
}

/**
 * Which retry actions a job offers: run again (cancelled jobs, and failures
 * main accepts — contracts canRetryJob) and/or save to another folder. Jobs
 * from an earlier run (history only) offer neither: main no longer has their
 * inputs and options.
 */
export function retryOptions(job: JobSnapshot): { readonly retry: boolean; readonly elsewhere: boolean } {
  if (job.earlierRun === true) return { retry: false, elsewhere: false };
  const code = job.state === 'failed' ? job.error?.code : undefined;
  return { retry: canRetryJob(job), elsewhere: code !== undefined && RETRY_ELSEWHERE_CODES.has(code) };
}

/**
 * Input kinds of a job for its title (contracts actionTitle: image → DOCX
 * embeds the picture, PDF → DOCX extracts text). A snapshot names its first
 * input only; jobs with several inputs are merges of images (images → PDF).
 */
export function jobInputKinds(job: Pick<JobSnapshot, 'inputName'>): InputKind[] {
  const dot = job.inputName.lastIndexOf('.');
  const format = dot > 0 ? formatFromExtension(job.inputName.slice(dot).toLowerCase()) : undefined;
  const kind = format === undefined ? undefined : inputKindOf(format);
  return kind === undefined ? [] : [kind];
}

/**
 * Jobs that finished between two snapshots of the list (queued/running → completed/failed/cancelled), in
 * list order. Jobs first seen already finished (history, the first snapshot) are not news.
 */
export function finishedSince(previous: ReadonlyMap<string, JobSnapshot['state']>, next: readonly JobSnapshot[]): JobSnapshot[] {
  return next.filter((job) => TERMINAL_JOB_STATES.has(job.state) && previous.has(job.jobId) && !TERMINAL_JOB_STATES.has(previous.get(job.jobId)!));
}

/**
 * Jobs window: current and recent jobs from main (`listJobs` + live
 * `onJobsChanged`). Progress is shown exactly as reported — determinate bars
 * for counted pages/files/steps, an indeterminate animation otherwise; never a
 * timer-driven fake. Finished jobs can be cleared from the list (outputs stay
 * on disk); cancelled jobs and failures with a retryable error can be run again.
 * A job that finishes while the window is open is announced (politely, one
 * message per update); keyboard focus stays on a job whose focused control
 * vanished (a cancelled job's × — its card moves to "Recent").
 */
export function JobsView() {
  const { orbit, t, platform, settings } = useEnv();
  const [jobs, setJobs] = useState<readonly JobSnapshot[] | null>(null);
  const [loadError, setLoadError] = useState<OrbitErrorInfo | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<OrbitErrorInfo | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  /** The clear button had focus when used: when it disappears, focus moves to the list instead of the page. */
  const clearHadFocus = useRef(false);
  const mounted = useRef(true);
  const hintId = useId();
  const close = useCallback(() => orbit.closeWindow(), [orbit]);
  useEscapeKey(close);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Polite announcement; an identical message gets a zero-width space so it is read again. */
  const announce = useCallback((text: string) => {
    setAnnouncement((previous) => (previous === text ? `${text}​` : text));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let live = false;
    const unsubscribe = orbit.onJobsChanged((next) => {
      live = true;
      if (!cancelled) setJobs(next);
    });
    orbit.listJobs().then(
      (initial) => {
        // A live update that arrived first is newer than this snapshot.
        if (!cancelled && !live) setJobs(initial);
      },
      (reason: unknown) => {
        if (!cancelled && !live) setLoadError(asErrorInfo(reason));
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [orbit]);

  const { active, recent } = useMemo(() => partitionJobs(jobs ?? []), [jobs]);
  const cutoff = finishedCutoff(recent);
  const hasFinished = cutoff !== null;

  // Jobs that finished since the last update are announced: one specific message, or a count for a batch.
  const knownStates = useRef<ReadonlyMap<string, JobSnapshot['state']> | null>(null);
  useEffect(() => {
    if (jobs === null) return;
    const previous = knownStates.current;
    knownStates.current = new Map(jobs.map((job) => [job.jobId, job.state]));
    if (previous === null) return; // the first snapshot is the starting point, not news
    const done = finishedSince(previous, jobs);
    if (done.length > 1) announce(t.plural('jobs.announce.many', done.length));
    else if (done.length === 1) {
      const job = done[0]!;
      const title = t.text(actionTitle(job.actionId, jobInputKinds(job)));
      const name = job.outputs[0]?.name ?? job.inputName;
      announce(t(job.state === 'completed' ? 'jobs.announce.completed' : job.state === 'failed' ? 'jobs.announce.failed' : 'jobs.announce.cancelled', { title, name }));
    }
  }, [jobs, announce, t]);

  // Keyboard focus that disappears with its control (a cancelled job's ×: the card moves to "Recent") goes
  // to the same job's card, else to the list, instead of <body>.
  const lastFocus = useRef<{ readonly element: HTMLElement; readonly jobId: string | null } | null>(null);
  useEffect(() => {
    const root = bodyRef.current;
    if (root === null) return undefined;
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) lastFocus.current = { element: event.target, jobId: event.target.closest<HTMLElement>('[data-job-id]')?.dataset.jobId ?? null };
    };
    root.addEventListener('focusin', onFocusIn);
    return () => root.removeEventListener('focusin', onFocusIn);
  }, []);
  useEffect(() => {
    const last = lastFocus.current;
    if (last === null || last.element.isConnected) return;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) return;
    lastFocus.current = null;
    const root = bodyRef.current;
    const card = last.jobId === null ? null : root?.querySelector<HTMLElement>(`[data-job-id="${last.jobId}"] .job-title`);
    (card ?? root?.querySelector<HTMLElement>('.jobs-section-title, .jobs-empty-title') ?? root)?.focus({ preventScroll: true });
  }, [jobs]);

  const clearFinished = async () => {
    if (clearing || cutoff === null) return;
    clearHadFocus.current = document.activeElement === clearRef.current;
    setClearing(true);
    setClearError(null);
    try {
      const removed = await orbit.clearFinishedJobs({ finishedUpTo: cutoff });
      // The list itself updates through onJobsChanged.
      if (mounted.current) announce(t.plural('jobs.cleared', removed));
    } catch (reason) {
      clearHadFocus.current = false;
      if (mounted.current) setClearError(asErrorInfo(reason));
    } finally {
      if (mounted.current) setClearing(false);
    }
  };

  // The clear button vanished with the jobs it removed: don't leave keyboard focus on the page.
  useEffect(() => {
    if (hasFinished || !clearHadFocus.current) return;
    clearHadFocus.current = false;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) return;
    const target = bodyRef.current?.querySelector<HTMLElement>('.jobs-section-title, .jobs-empty-title') ?? bodyRef.current;
    target?.focus({ preventScroll: true });
  }, [hasFinished]);

  let body;
  if (jobs === null && loadError === null) {
    body = (
      <div className="view-loading" role="status">
        <Spinner size={16} />
        <span>{t('common.loading')}</span>
      </div>
    );
  } else if (jobs === null) {
    body = (
      <Notice tone="danger">
        <strong>{t('shell.loadFailed')}</strong> {loadError ? t.error(loadError) : null}
      </Notice>
    );
  } else if (jobs.length === 0) {
    body = (
      <div className="jobs-empty">
        <p className="jobs-empty-title" tabIndex={-1}>
          {t('jobs.empty')}
        </p>
        <p className="jobs-empty-hint">
          {t(platform === 'darwin' ? 'jobs.emptyHint' : 'jobs.emptyHintPc', {
            convert: comboLabel(t, settings.globalDrag.convertModifiers, platform),
            tools: comboLabel(t, settings.globalDrag.toolsModifiers, platform),
          })}
        </p>
      </div>
    );
  } else {
    body = (
      <>
        {active.length > 0 ? <JobSection title={t('jobs.active')} jobs={active} onAnnounce={announce} /> : null}
        {recent.length > 0 ? <JobSection title={t('jobs.recent')} jobs={recent} onAnnounce={announce} /> : null}
      </>
    );
  }

  return (
    <div className="view jobs-view">
      <TitleBar title={t('jobs.title')} onClose={close} separated />
      <div className="jobs-body" ref={bodyRef} tabIndex={-1}>
        {hasFinished ? (
          <div className="jobs-toolbar">
            <button
              ref={clearRef}
              type="button"
              className="btn btn-small jobs-clear"
              title={t('jobs.clearFinishedHint')}
              aria-describedby={hintId}
              // aria-disabled instead of disabled while clearing: the button keeps keyboard focus.
              aria-disabled={clearing || undefined}
              onClick={() => void clearFinished()}
            >
              {clearing ? <Spinner size={12} /> : <ListX size={14} aria-hidden="true" />}
              {t('jobs.clearFinished')}
            </button>
            <span id={hintId} className="visually-hidden">
              {t('jobs.clearFinishedHint')}
            </span>
          </div>
        ) : null}
        {clearError ? (
          <Notice
            tone="danger"
            onDismiss={() => {
              setClearError(null);
              (clearRef.current ?? bodyRef.current)?.focus({ preventScroll: true }); // the dismiss button goes away
            }}
            dismissLabel={t('common.dismiss')}
          >
            <strong>{t('jobs.clearFailed')}</strong> {t.error(clearError)}
          </Notice>
        ) : null}
        {body}
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

function JobSection({ title, jobs, onAnnounce }: { readonly title: string; readonly jobs: readonly JobSnapshot[]; readonly onAnnounce: (text: string) => void }) {
  const headingId = useId();
  return (
    <section className="jobs-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="jobs-section-title" tabIndex={-1}>
        {title}
      </h2>
      <ul className="job-list">
        {jobs.map((job) => (
          <JobCard key={job.jobId} job={job} onAnnounce={onAnnounce} />
        ))}
      </ul>
    </section>
  );
}

type CardAction = 'cancel' | 'retry' | 'elsewhere';

/** An action that failed; retry failures get their own wording. */
interface ActionError {
  readonly error: OrbitErrorInfo;
  readonly retry: boolean;
}

function JobCard({ job, onAnnounce }: { readonly job: JobSnapshot; readonly onAnnounce: (text: string) => void }) {
  const { orbit, t, platform } = useEnv();
  const titleId = useId();
  const action = ACTIONS[job.actionId];
  const [busy, setBusy] = useState<CardAction | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  /** This job was run again (here or in another folder); the new job is listed separately. */
  const [retriedHere, setRetried] = useState(false);
  // Also when the retry happened while this window was closed (main remembers it for the session).
  const retried = retriedHere || job.retried === true;
  const retriedRef = useRef<HTMLParagraphElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    // Set again on (re)mount: StrictMode and fast refresh run cleanup and effect once more.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (kind: CardAction | null, task: () => Promise<OrbitErrorInfo | null | void>, retry = false) => {
    if (kind) setBusy(kind);
    setActionError(null);
    try {
      const error = await task();
      if (error && mounted.current) setActionError({ error, retry });
    } catch (reason) {
      if (mounted.current) setActionError({ error: asErrorInfo(reason), retry });
    } finally {
      if (kind && mounted.current) setBusy(null);
    }
  }, []);

  const onRetried = useCallback(() => {
    if (!mounted.current) return;
    setRetried(true);
    onAnnounce(t('jobs.retryStarted'));
  }, [onAnnounce, t]);

  const retry = () => {
    if (busy !== null) return;
    void run(
      'retry',
      async () => {
        const result = await orbit.retryJob(job.jobId);
        if (result.kind === 'rejected') return result.error;
        onRetried(); // the new job arrives through onJobsChanged
        return null;
      },
      true,
    );
  };

  const retryElsewhere = () => {
    if (busy !== null) return;
    void run(
      'elsewhere',
      async () => {
        const result = await orbit.retryJobElsewhere(job.jobId);
        // null = the user closed the folder picker; jobs re-appear through onJobsChanged.
        if (result === null) return null;
        if (result.kind === 'rejected') return result.error;
        onRetried();
        return null;
      },
      true,
    );
  };

  // The retry buttons were replaced by the "retried" note: keep keyboard focus in the card.
  useEffect(() => {
    if (!retried) return;
    const focused = document.activeElement;
    if (focused === null || focused === document.body) retriedRef.current?.focus({ preventScroll: true });
  }, [retried]);

  const terminal = TERMINAL_JOB_STATES.has(job.state);
  const cancellable = !terminal && action.cancellable;
  const offers = retryOptions(job);
  const inputName =
    job.inputCount > 1 ? t('jobs.inputName', { name: job.inputName, more: t.plural('common.moreFiles', job.inputCount - 1) }) : job.inputName;
  const time = job.finishedAt ?? job.startedAt ?? job.createdAt;
  const title = t.text(actionTitle(job.actionId, jobInputKinds(job)));

  // Failed jobs show these inside their error notice, cancelled jobs below the title.
  const retryActions = retried ? (
    <p ref={retriedRef} className="job-retried muted" tabIndex={-1}>
      {t('jobs.retried')}
    </p>
  ) : offers.retry || offers.elsewhere ? (
    // aria-disabled while one runs: the clicked button keeps keyboard focus.
    <div className="job-retry-actions">
      {offers.retry ? (
        <button type="button" className="btn btn-small" aria-describedby={titleId} aria-disabled={busy !== null || undefined} onClick={retry}>
          {busy === 'retry' ? <Spinner size={12} /> : <RotateCw size={13} aria-hidden="true" />}
          {t('jobs.retry')}
        </button>
      ) : null}
      {offers.elsewhere ? (
        <button type="button" className="btn btn-small" aria-describedby={titleId} aria-disabled={busy !== null || undefined} onClick={retryElsewhere}>
          {busy === 'elsewhere' ? <Spinner size={12} /> : <FolderOpen size={13} aria-hidden="true" />}
          {t('jobs.retryElsewhere')}
        </button>
      ) : null}
    </div>
  ) : null;

  return (
    <li className="job-card" data-state={job.state} data-job-id={job.jobId} aria-labelledby={titleId}>
      <div className="job-head">
        <span className="job-icon" aria-hidden="true">
          {action.icon ? <ActionIcon icon={action.icon} size={16} /> : <span className="job-format">{action.wheelLabel.en}</span>}
        </span>
        <div className="job-titles">
          <h3 id={titleId} ref={titleRef} className="job-title" tabIndex={-1}>
            {title}
          </h3>
          <p className="job-sub" title={job.inputName}>
            {inputName}
          </p>
        </div>
        <div className="job-side">
          <span className="job-state" data-state={job.state}>
            {t(`jobs.state.${job.state}`)}
          </span>
          <time className="job-time tabular" dateTime={new Date(time).toISOString()}>
            {formatTime(time, t.locale)}
          </time>
        </div>
        {cancellable ? (
          <button
            type="button"
            className="btn-icon job-cancel"
            aria-label={t('jobs.cancel')}
            title={t('jobs.cancel')}
            aria-describedby={titleId}
            // aria-disabled while cancelling: the button keeps keyboard focus until the card moves to "Recent".
            aria-disabled={busy === 'cancel' || undefined}
            onClick={() => {
              if (busy !== 'cancel') void run('cancel', () => orbit.cancelJob(job.jobId));
            }}
          >
            {busy === 'cancel' ? <Spinner size={12} /> : <X size={14} aria-hidden="true" />}
          </button>
        ) : null}
      </div>

      {job.state === 'running' ? <JobProgressBar progress={job.progress} label={t('jobs.progressLabel', { title })} /> : null}

      {job.state === 'completed' ? (
        <JobOutputs
          job={job}
          onReveal={(outputId) => void run(null, () => orbit.revealOutput(outputId))}
          onOpen={(outputId) => void run(null, () => orbit.openOutput(outputId))}
          revealLabel={t(`jobs.reveal.${platform}`)}
        />
      ) : null}

      {job.state === 'completed' && job.actionId === 'tool.compress' ? <SizeChange job={job} /> : null}

      <JobWarnings job={job} />

      {job.state === 'failed' ? (
        <Notice tone="danger" live="off">
          <div>{t.error(job.error ?? 'INTERNAL')}</div>
          {retryActions}
        </Notice>
      ) : null}

      {job.state === 'cancelled' ? retryActions : null}

      {actionError ? (
        <Notice
          tone="danger"
          onDismiss={() => {
            setActionError(null);
            titleRef.current?.focus({ preventScroll: true }); // the dismiss button goes away with the notice
          }}
          dismissLabel={t('common.dismiss')}
        >
          {actionError.retry ? <RetryErrorText error={actionError.error} /> : t.error(actionError.error)}
        </Notice>
      ) : null}
    </li>
  );
}

/**
 * Why a retry did not start. FILE_NOT_FOUND covers both "an input is gone" and
 * "main no longer knows this job" (listed from before a restart): either way
 * the user has to open the file again.
 */
function RetryErrorText({ error }: { readonly error: OrbitErrorInfo }) {
  const { t } = useEnv();
  if (error.code === 'FILE_NOT_FOUND') return <>{t('jobs.retryUnavailable')}</>;
  return (
    <>
      <strong>{t('jobs.retryFailed')}</strong> {t.error(error)}
    </>
  );
}

function JobProgressBar({ progress, label }: { readonly progress: JobProgress; readonly label: string }) {
  const { t } = useEnv();
  if (progress.kind === 'determinate') {
    const total = Math.max(0, progress.total);
    const done = Math.min(total, Math.max(0, progress.done));
    const percent = total > 0 ? (done / total) * 100 : 0;
    const text = t(`jobs.progress.${progress.unit}`, { done, total });
    return (
      <div className="job-progress-row">
        <div
          className="job-progress"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-valuetext={text}
          data-indeterminate="false"
        >
          <div className="job-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="job-progress-text tabular" aria-hidden="true">
          {text}
        </span>
      </div>
    );
  }
  const text = progress.stage ? t(`jobs.stage.${progress.stage}`) : t('jobs.working');
  return (
    <div className="job-progress-row">
      <div className="job-progress" role="progressbar" aria-label={label} aria-valuetext={text} data-indeterminate="true">
        <div className="job-progress-fill" />
      </div>
      <span className="job-progress-text" aria-hidden="true">
        {text}
      </span>
    </div>
  );
}

function outputMeta(output: OutputFileInfo, t: ReturnType<typeof useEnv>['t'], platform: ReturnType<typeof useEnv>['platform']): string {
  const parts = [formatBytes(output.bytes, t.locale, platform)];
  if (output.width !== undefined && output.height !== undefined) parts.push(t('jobs.warningDetail.size', { width: output.width, height: output.height }));
  if (output.pages !== undefined) parts.push(t.plural('jobs.pages', output.pages));
  parts.push(FORMAT_INFO[output.format]?.label ?? output.format.toUpperCase());
  return parts.join(' · ');
}

function JobOutputs({
  job,
  onReveal,
  onOpen,
  revealLabel,
}: {
  readonly job: JobSnapshot;
  readonly onReveal: (outputId: string) => void;
  readonly onOpen: (outputId: string) => void;
  readonly revealLabel: string;
}) {
  const { t, platform } = useEnv();
  const baseId = useId();
  if (job.outputs.length === 0) return null;
  const visible = job.outputs.slice(0, MAX_VISIBLE_OUTPUTS);
  const hidden = job.outputs.length - visible.length;
  const dirs = [...new Set(job.outputs.map((o) => o.dirDisplay))];
  return (
    <div className="job-outputs-block">
      <ul className="job-outputs" aria-label={t('jobs.outputs')}>
        {visible.map((output, index) => {
          const nameId = `${baseId}-out-${index}`;
          return (
            <li key={output.outputId} className="job-output">
              <span id={nameId} className="job-output-name" title={output.name}>
                {output.name}
              </span>
              <span className="job-output-meta tabular">{outputMeta(output, t, platform)}</span>
              <span className="job-output-actions">
                <button type="button" className="btn btn-small" aria-describedby={nameId} onClick={() => onReveal(output.outputId)}>
                  {revealLabel}
                </button>
                <button type="button" className="btn btn-small" aria-describedby={nameId} onClick={() => onOpen(output.outputId)}>
                  {t('jobs.open')}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? <p className="job-more muted">{t.plural('jobs.moreOutputs', hidden)}</p> : null}
      {dirs.length === 1 && dirs[0] ? <p className="job-dir muted">{t('jobs.savedIn', { dir: dirs[0] })}</p> : null}
    </div>
  );
}

function SizeChange({ job }: { readonly job: JobSnapshot }) {
  const { t, platform } = useEnv();
  const output = job.outputs.reduce((sum, o) => sum + o.bytes, 0);
  if (job.outputs.length === 0 || job.inputBytes <= 0) return null;
  const change = percentChange(job.inputBytes, output);
  const smaller = output < job.inputBytes;
  const hasWarning = job.warnings.some((w) => w.code === 'OUTPUT_LARGER_THAN_INPUT');
  return (
    <>
      <p className="job-size-change tabular" data-tone={smaller ? 'good' : 'bad'}>
        {t('jobs.sizeChange', { input: formatBytes(job.inputBytes, t.locale, platform), output: formatBytes(output, t.locale, platform) })}{' '}
        <strong>{t('common.percent', { value: change > 0 ? `+${change}` : String(change) })}</strong>
      </p>
      {!smaller && !hasWarning ? (
        <Notice tone="warning" live="off">
          {t.warning('OUTPUT_LARGER_THAN_INPUT')}
        </Notice>
      ) : null}
    </>
  );
}

/** Context params a processor may attach to a warning; anything else is not shown. */
export function warningDetail(warning: JobWarning, t: ReturnType<typeof useEnv>['t']): string | null {
  const params = warning.params;
  if (params === undefined) return null;
  // Only the first page / frame was used: here the parameter is how many the input had, not a page list.
  if (warning.code === 'FIRST_PAGE_ONLY') return params.pages === undefined ? null : t('jobs.warningDetail.pagesTotal', { count: params.pages });
  if (warning.code === 'FIRST_FRAME_ONLY') return params.frames === undefined ? null : t('jobs.warningDetail.framesTotal', { count: params.frames });
  const details: string[] = [];
  if (params.pages !== undefined) details.push(t('jobs.warningDetail.pages', { pages: params.pages }));
  if (params.width !== undefined && params.height !== undefined) details.push(t('jobs.warningDetail.size', { width: params.width, height: params.height }));
  return details.length > 0 ? details.join(' · ') : null;
}

function JobWarnings({ job }: { readonly job: JobSnapshot }) {
  const { t } = useEnv();
  if (job.warnings.length === 0) return null;
  const seen = new Set<string>();
  const unique = job.warnings.filter((w) => {
    const key = `${w.code}:${JSON.stringify(w.params ?? {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <div className="job-warnings">
      {unique.map((warning, index) => {
        const detail = warningDetail(warning, t);
        // Dropping metadata is the documented default for conversions: informational, not a problem.
        const tone = warning.code === 'METADATA_REMOVED' ? 'info' : 'warning';
        return (
          <Notice key={`${warning.code}-${index}`} tone={tone} live="off">
            {t.warning(warning.code)}
            {detail ? <span className="job-warning-detail"> {detail}</span> : null}
          </Notice>
        );
      })}
    </div>
  );
}
