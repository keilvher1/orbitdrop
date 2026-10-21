import {
  FORMAT_INFO,
  TERMINAL_JOB_STATES,
  type CompressOptions,
  type EditorContext,
  type FileFormat,
  type JobSnapshot,
} from '@orbitdrop/contracts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useEnv } from '../../../app/env';
import { NumberInput } from '../../../components/NumberInput';
import { Notice } from '../../../components/Notice';
import { Segmented } from '../../../components/Segmented';
import { SliderField } from '../../../components/SliderField';
import { formatBytes, percentChange } from '../../../i18n/format';
import { fitSize } from '../crop/cropMath';
import { EditorFrame, useEditorCommit, type EditorCommit } from '../EditorFrame';
import { MultiFileNote, PreviewError, Stage, isBoolean, isNumber, isOneOf, pick, previewEdgeFor, useDecodedPreview, usePreviewBox } from '../editorKit';
import { usePreview } from '../usePreview';
import './compress.css';

type CompressFormat = CompressOptions['format'];
type PngMode = CompressOptions['pngMode'];

const FORMATS: readonly CompressFormat[] = ['input', 'jpeg', 'webp', 'png'];
const PNG_MODES: readonly PngMode[] = ['palette', 'lossless'];
/** Longest-edge presets; only those smaller than the source are offered (never upscale). */
export const MAX_EDGE_PRESETS: readonly number[] = [3840, 2560, 1920, 1280];
const MAX_EDGE_LIMIT = 30000;
const MIN_EDGE = 16;

export interface CompressState {
  readonly format: CompressFormat;
  readonly quality: number;
  readonly maxEdge: number | null;
  readonly pngMode: PngMode;
  readonly keepMetadata: boolean;
}

export function compressDefaults(raw: unknown, sourceLongEdge: number): CompressState {
  const maxEdge = pick<number | null>(raw, 'maxEdge', (v): v is number | null => v === null || (isNumber(v) && Number.isInteger(v)), null);
  return {
    format: pick(raw, 'format', isOneOf(FORMATS), 'input'),
    quality: Math.min(100, Math.max(1, Math.round(pick(raw, 'quality', isNumber, 75)))),
    maxEdge: maxEdge === null || maxEdge >= sourceLongEdge ? null : Math.max(MIN_EDGE, maxEdge),
    pngMode: pick(raw, 'pngMode', isOneOf(PNG_MODES), 'palette'),
    keepMetadata: pick(raw, 'keepMetadata', isBoolean, false),
  };
}

/** Options exactly as CompressOptionsSchema expects (strict object). */
export function compressOptions(state: CompressState): CompressOptions {
  return {
    format: state.format,
    quality: state.quality,
    maxEdge: state.maxEdge,
    pngMode: state.pngMode,
    keepMetadata: state.keepMetadata,
  };
}

/** Format the result will have. */
export function effectiveFormat(format: CompressFormat, input: FileFormat): FileFormat {
  return format === 'input' ? input : format;
}

function signedPercent(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return '0';
}

/** Merge job snapshots by id; snapshots from onJobsChanged always win over the initial list. */
function mergeJobs(current: ReadonlyMap<string, JobSnapshot>, incoming: readonly JobSnapshot[], ids: ReadonlySet<string>, overwrite: boolean): Map<string, JobSnapshot> {
  const next = new Map(current);
  for (const job of incoming) {
    if (!ids.has(job.jobId)) continue;
    if (!overwrite && next.has(job.jobId)) continue;
    next.set(job.jobId, job);
  }
  return next;
}

export function CompressEditor({ ctx, title }: { readonly ctx: EditorContext; readonly title: string }) {
  const { orbit, t, platform } = useEnv();
  const commit = useEditorCommit(ctx.editorId);
  const sourceLong = Math.max(ctx.image.orientedWidth, ctx.image.orientedHeight);
  const initial = useMemo(() => compressDefaults(ctx.defaults, sourceLong), [ctx.defaults, sourceLong]);
  const [state, setState] = useState<CompressState>(initial);
  const [jobIds, setJobIds] = useState<readonly string[] | null>(null);

  const options = useMemo(() => compressOptions(state), [state]);
  const box = usePreviewBox(470, 300);
  const display = fitSize({ width: ctx.image.orientedWidth, height: ctx.image.orientedHeight }, box);
  const { preview: latest, pending, error } = usePreview(ctx.editorId, options, { maxEdge: previewEdgeFor(display), enabled: jobIds === null });
  // Image, estimate and size switch together once the new preview image has decoded.
  const preview = useDecodedPreview(latest);
  const shownUrl = preview?.url ?? ctx.source.url;

  const outFormat = effectiveFormat(state.format, ctx.image.format);
  const isPng = outFormat === 'png';
  const lossy = FORMAT_INFO[outFormat].lossy;
  const inputBytes = ctx.image.bytes > 0 ? ctx.image.bytes : (ctx.files[0]?.bytes ?? 0);
  const estimated = preview?.estimatedBytes;
  const change = estimated === undefined ? null : percentChange(inputBytes, estimated);
  const notSmaller = estimated !== undefined && estimated >= inputBytes;
  const changed = JSON.stringify(state) !== JSON.stringify(initial);
  const presets = MAX_EDGE_PRESETS.filter((edge) => edge < sourceLong);
  const customMax = Math.min(MAX_EDGE_LIMIT, sourceLong);
  const edgeChoice = state.maxEdge === null ? 'keep' : presets.includes(state.maxEdge) ? String(state.maxEdge) : 'custom';

  const update = (patch: Partial<CompressState>) => setState((s) => ({ ...s, ...patch }));

  const run = async () => {
    const result = await commit.commit(options, true);
    if (result === null || result.kind === 'rejected') return;
    if (result.kind === 'jobs') setJobIds(result.jobIds);
    else orbit.closeWindow();
  };

  if (jobIds !== null) {
    return <CompressResults ctx={ctx} title={title} commit={commit} jobIds={jobIds} />;
  }

  return (
    <EditorFrame
      title={title}
      commit={commit}
      primaryLabel={t('compress.run')}
      onPrimary={() => void run()}
      onReset={() => setState(initial)}
      resetDisabled={!changed}
    >
      <Stage display={display} checker={ctx.image.hasAlpha} pending={pending}>
        {shownUrl ? <img src={shownUrl} alt={preview ? t('editor.previewAlt') : t('editor.sourceAlt')} draggable={false} /> : null}
      </Stage>
      <PreviewError error={error} />
      <div className="compress-sizes" aria-live="polite">
        <div className="compress-size">
          <span className="compress-size-label">{t('compress.inputSize')}</span>
          <strong className="tabular">{formatBytes(inputBytes, t.locale, platform)}</strong>
        </div>
        <div className="compress-size">
          <span className="compress-size-label">{t('compress.estimated')}</span>
          <strong className="tabular" data-stale={pending || undefined}>
            {estimated === undefined ? t('compress.estimating') : formatBytes(estimated, t.locale, platform)}
          </strong>
        </div>
        <div className="compress-size">
          <span className="compress-size-label" aria-hidden="true">
            Δ
          </span>
          <strong className="tabular" data-tone={change === null ? undefined : notSmaller ? 'warning' : 'good'}>
            {change === null ? '—' : t('common.percent', { value: signedPercent(change) })}
          </strong>
        </div>
      </div>
      {ctx.files.length > 1 && ctx.files[0] ? <p className="compress-first muted">{t('compress.estimateFor', { name: ctx.files[0].name })}</p> : null}
      {estimated !== undefined ? (
        notSmaller ? (
          <Notice tone="warning">{t('compress.notSmaller')}</Notice>
        ) : (
          <p className="compress-expect">{t('compress.smaller', { percent: Math.abs(change ?? 0) })}</p>
        )
      ) : null}
      <div className="editor-controls">
        <div className="field-row">
          <span className="field-label">{t('compress.format')}</span>
          <Segmented<CompressFormat>
            label={t('compress.format')}
            value={state.format}
            onChange={(format) => update({ format })}
            options={FORMATS.map((format) => ({
              value: format,
              label: format === 'input' ? t('editor.format.input') : FORMAT_INFO[format].label,
            }))}
          />
        </div>
        {isPng ? (
          <>
            <div className="field-row">
              <span className="field-label">{t('compress.pngMode')}</span>
              <Segmented<PngMode>
                label={t('compress.pngMode')}
                value={state.pngMode}
                onChange={(pngMode) => update({ pngMode })}
                options={[
                  { value: 'palette', label: t('compress.pngMode.palette') },
                  { value: 'lossless', label: t('compress.pngMode.lossless') },
                ]}
              />
            </div>
            <p className="compress-hint muted">{t('compress.pngHint')}</p>
          </>
        ) : (
          <SliderField label={t('compress.quality')} value={state.quality} min={1} max={100} onChange={(quality) => update({ quality })} disabled={!lossy} />
        )}
        <div className="field-row">
          <span className="field-label">{t('compress.maxEdge')}</span>
          <div className="editor-inline">
            <Segmented<string>
              label={t('compress.maxEdge')}
              value={edgeChoice}
              onChange={(choice) => {
                if (choice === 'keep') update({ maxEdge: null });
                else if (choice === 'custom') update({ maxEdge: state.maxEdge ?? Math.min(customMax, presets[presets.length - 1] ?? customMax) });
                else update({ maxEdge: Number(choice) });
              }}
              options={[
                { value: 'keep', label: t('compress.maxEdge.none') },
                ...presets.map((edge) => ({ value: String(edge), label: String(edge), ariaLabel: t('compress.maxEdge.custom', { value: edge }) })),
                { value: 'custom', label: t('compress.maxEdge.customLabel') },
              ]}
            />
            {edgeChoice === 'custom' ? (
              <span className="slider-value">
                <NumberInput
                  value={state.maxEdge ?? customMax}
                  min={MIN_EDGE}
                  max={customMax}
                  onCommit={(value) => update({ maxEdge: value >= sourceLong ? null : value })}
                  ariaLabel={t('compress.maxEdge')}
                />
                <span className="unit" aria-hidden="true">
                  {t('common.px')}
                </span>
              </span>
            ) : null}
          </div>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={state.keepMetadata} onChange={(event) => update({ keepMetadata: event.target.checked })} />
          <span>{t('compress.keepMetadata')}</span>
        </label>
      </div>
      <MultiFileNote ctx={ctx} />
    </EditorFrame>
  );
}

// ------------------------------------------------------------------ results

interface CompressResultsProps {
  readonly ctx: EditorContext;
  readonly title: string;
  readonly commit: EditorCommit;
  readonly jobIds: readonly string[];
}

/** After commit: follows the jobs and shows the real final size — never "success" when it did not shrink. */
function CompressResults({ ctx, title, commit, jobIds }: CompressResultsProps) {
  const { orbit, t } = useEnv();
  const [jobs, setJobs] = useState<ReadonlyMap<string, JobSnapshot>>(new Map());

  useEffect(() => {
    const ids = new Set(jobIds);
    let cancelled = false;
    const unsubscribe = orbit.onJobsChanged((list) => {
      if (!cancelled) setJobs((current) => mergeJobs(current, list, ids, true));
    });
    orbit.listJobs().then(
      (list) => {
        if (!cancelled) setJobs((current) => mergeJobs(current, list, ids, false));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [orbit, jobIds]);

  const close = () => orbit.closeWindow();
  // After commit the editor is done: × / Esc only close the window (jobs keep running).
  const frameCommit: EditorCommit = { ...commit, cancel: close };
  const allDone = jobIds.every((id) => {
    const job = jobs.get(id);
    return job !== undefined && TERMINAL_JOB_STATES.has(job.state);
  });

  return (
    <EditorFrame
      title={title}
      commit={frameCommit}
      primaryLabel={t('common.close')}
      onPrimary={close}
      footer={
        <footer className="editor-footer">
          <div className="editor-footer-spacer" />
          <button type="button" className={allDone ? 'btn btn-primary' : 'btn'} onClick={close}>
            {t('common.close')}
          </button>
        </footer>
      }
    >
      <h2 className="editor-section-title">{t('compress.results')}</h2>
      <ul className="compress-results" aria-live="polite">
        {jobIds.map((id, index) => (
          <CompressResultRow key={id} job={jobs.get(id) ?? null} fallbackName={ctx.files[index]?.name ?? ctx.files[0]?.name ?? ''} />
        ))}
      </ul>
    </EditorFrame>
  );
}

function CompressResultRow({ job, fallbackName }: { readonly job: JobSnapshot | null; readonly fallbackName: string }) {
  const { orbit, t, platform } = useEnv();
  const name = job?.inputName ?? fallbackName;

  let body: ReactNode;
  if (job === null || job.state === 'queued' || job.state === 'running') {
    const progress = job?.progress;
    body =
      progress?.kind === 'determinate' && progress.total > 0 ? (
        <div className="compress-progress">
          <progress className="compress-bar" max={progress.total} value={progress.done} aria-label={t('compress.running')} />
          <span className="muted tabular">{t(`jobs.progress.${progress.unit}`, { done: progress.done, total: progress.total })}</span>
        </div>
      ) : (
        <div className="compress-progress">
          <div className="compress-bar-indeterminate" role="progressbar" aria-label={t('compress.running')} aria-valuetext={t('compress.running')}>
            <span />
          </div>
          <span className="muted">{job?.state === 'queued' ? t('jobs.state.queued') : t('compress.running')}</span>
        </div>
      );
  } else if (job.state === 'failed') {
    body = <Notice tone="danger">{job.error ? t.error(job.error) : t('jobs.state.failed')}</Notice>;
  } else if (job.state === 'cancelled') {
    body = <p className="muted">{t('jobs.state.cancelled')}</p>;
  } else {
    const outBytes = job.outputs.reduce((sum, output) => sum + output.bytes, 0);
    const largerWarning = job.warnings.some((w) => w.code === 'OUTPUT_LARGER_THAN_INPUT');
    const pct = percentChange(job.inputBytes, outBytes);
    const notSmaller = job.outputs.length === 0 || largerWarning || outBytes >= job.inputBytes;
    const output = job.outputs[0];
    body = (
      <>
        {job.outputs.length > 0 ? (
          <p className="tabular">
            {t('jobs.sizeChange', { input: formatBytes(job.inputBytes, t.locale, platform), output: formatBytes(outBytes, t.locale, platform) })}
          </p>
        ) : null}
        {notSmaller ? (
          <Notice tone="warning" live="off">
            {job.outputs.length === 0 ? t.warning('OUTPUT_LARGER_THAN_INPUT') : t('compress.resultNotSmaller', { percent: Math.max(0, pct) })}
          </Notice>
        ) : (
          <Notice tone="success" live="off">
            {t('compress.resultSmaller', { percent: Math.abs(pct) })}
          </Notice>
        )}
        {output ? (
          <div className="editor-inline">
            <span className="compress-output-name" title={output.name}>
              {output.name}
            </span>
            <button type="button" className="btn btn-small" onClick={() => void orbit.revealOutput(output.outputId).catch(() => undefined)}>
              {t(`jobs.reveal.${platform}`)}
            </button>
            <button type="button" className="btn btn-small" onClick={() => void orbit.openOutput(output.outputId).catch(() => undefined)}>
              {t('jobs.open')}
            </button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <li className="compress-result">
      <span className="compress-result-name" title={name}>
        {name}
      </span>
      {body}
    </li>
  );
}
