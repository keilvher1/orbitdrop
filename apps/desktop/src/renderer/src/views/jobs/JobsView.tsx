import {
  ACTIONS,
  FORMAT_INFO,
  TERMINAL_JOB_STATES,
  type JobProgress,
  type JobSnapshot,
  type JobWarning,
  type OrbitErrorInfo,
  type OutputFileInfo,
} from '@orbitdrop/contracts';
import { FolderOpen, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useEnv } from '../../app/env';
import { asErrorInfo } from '../../app/errors';
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
 * Jobs window: current and recent jobs from main (`listJobs` + live
 * `onJobsChanged`). Progress is shown exactly as reported — determinate bars
 * for counted pages/files/steps, an indeterminate animation otherwise; never a
 * timer-driven fake.
 */
export function JobsView() {
  const { orbit, t, platform } = useEnv();
  const [jobs, setJobs] = useState<readonly JobSnapshot[] | null>(null);
  const [loadError, setLoadError] = useState<OrbitErrorInfo | null>(null);
  const close = useCallback(() => orbit.closeWindow(), [orbit]);
  useEscapeKey(close);

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
        <p className="jobs-empty-title">{t('jobs.empty')}</p>
        <p className="jobs-empty-hint">{platform === 'darwin' ? t('jobs.emptyHint') : t('jobs.emptyHintPc')}</p>
      </div>
    );
  } else {
    body = (
      <>
        {active.length > 0 ? <JobSection title={t('jobs.active')} jobs={active} /> : null}
        {recent.length > 0 ? <JobSection title={t('jobs.recent')} jobs={recent} /> : null}
      </>
    );
  }

  return (
    <div className="view jobs-view">
      <TitleBar title={t('jobs.title')} onClose={close} separated />
      <div className="jobs-body">{body}</div>
    </div>
  );
}

function JobSection({ title, jobs }: { readonly title: string; readonly jobs: readonly JobSnapshot[] }) {
  const headingId = useId();
  return (
    <section className="jobs-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="jobs-section-title">
        {title}
      </h2>
      <ul className="job-list">
        {jobs.map((job) => (
          <JobCard key={job.jobId} job={job} />
        ))}
      </ul>
    </section>
  );
}

function JobCard({ job }: { readonly job: JobSnapshot }) {
  const { orbit, t, platform } = useEnv();
  const titleId = useId();
  const action = ACTIONS[job.actionId];
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const [actionError, setActionError] = useState<OrbitErrorInfo | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const run = useCallback(async (kind: 'cancel' | 'retry' | null, task: () => Promise<OrbitErrorInfo | null | void>) => {
    if (kind) setBusy(kind);
    setActionError(null);
    try {
      const error = await task();
      if (error && mounted.current) setActionError(error);
    } catch (reason) {
      if (mounted.current) setActionError(asErrorInfo(reason));
    } finally {
      if (kind && mounted.current) setBusy(null);
    }
  }, []);

  const terminal = TERMINAL_JOB_STATES.has(job.state);
  const cancellable = !terminal && action.cancellable;
  const inputName =
    job.inputCount > 1 ? t('jobs.inputName', { name: job.inputName, more: t.plural('common.moreFiles', job.inputCount - 1) }) : job.inputName;
  const time = job.finishedAt ?? job.startedAt ?? job.createdAt;
  const title = t.text(action.title);

  return (
    <li className="job-card" data-state={job.state} aria-labelledby={titleId}>
      <div className="job-head">
        <span className="job-icon" aria-hidden="true">
          {action.icon ? <ActionIcon icon={action.icon} size={16} /> : <span className="job-format">{action.wheelLabel.en}</span>}
        </span>
        <div className="job-titles">
          <h3 id={titleId} className="job-title">
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
            disabled={busy === 'cancel'}
            onClick={() => void run('cancel', () => orbit.cancelJob(job.jobId))}
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
          {job.error?.code === 'OUTPUT_DIR_NOT_WRITABLE' ? (
            <button
              type="button"
              className="btn btn-small job-retry"
              disabled={busy === 'retry'}
              onClick={() =>
                void run('retry', async () => {
                  const result = await orbit.retryJobElsewhere(job.jobId);
                  // null = the user closed the folder picker; jobs re-appear through onJobsChanged.
                  return result !== null && result.kind === 'rejected' ? result.error : null;
                })
              }
            >
              {busy === 'retry' ? <Spinner size={12} /> : <FolderOpen size={13} aria-hidden="true" />}
              {t('jobs.retryElsewhere')}
            </button>
          ) : null}
        </Notice>
      ) : null}

      {actionError ? (
        <Notice tone="danger" onDismiss={() => setActionError(null)} dismissLabel={t('common.dismiss')}>
          {t.error(actionError)}
        </Notice>
      ) : null}
    </li>
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
