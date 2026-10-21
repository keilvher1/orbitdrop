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
import {
  FormatResolvedNote,
  MultiFileNote,
  PreviewError,
  Stage,
  isBoolean,
  isNumber,
  isOneOf,
  pick,
  previewEdgeFor,
  useDecodedPreview,
  usePreviewBox,
  type FormatChange,
} from '../editorKit';
import { usePreview } from '../usePreview';
import { BatchTotals, EstimateList, signedPercent } from './CompressBatch';
import { summarizeEstimates, useBatchEstimates } from './useBatchEstimates';
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

/**
 * Format the result is expected to have. 'input' follows the processors' rule
 * (tools/compress.ts resolveCompressFormat): JPEG/PNG/WebP/AVIF keep their
 * format, HEIC → JPEG, TIFF/BMP/GIF → PNG. The preview's `outputFormat` is
 * authoritative (e.g. AVIF → WebP when this build cannot encode AVIF) and
 * replaces this guess once it arrives.
 */
export function effectiveFormat(format: CompressFormat, input: FileFormat): FileFormat {
  if (format !== 'input') return format;
  switch (input) {
    case 'heic':
      return 'jpeg';
    case 'tiff':
    case 'bmp':
    case 'gif':
      return 'png';
    default:
      return input;
  }
}

/** Key of a reported output format: it depends only on the file and the format option. */
function formatKey(fileId: string, format: CompressFormat): string {
  return `${fileId}\u0000${format}`;
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

interface Committed {
  readonly jobIds: readonly string[];
  /** Estimates that were current when the user pressed Compress, by fileId. */
  readonly estimates: ReadonlyMap<string, number>;
}

export function CompressEditor({ ctx, title }: { readonly ctx: EditorContext; readonly title: string }) {
  const { orbit, t, platform } = useEnv();
  const commit = useEditorCommit(ctx.editorId);
  const sourceLong = Math.max(ctx.image.orientedWidth, ctx.image.orientedHeight);
  const initial = useMemo(() => compressDefaults(ctx.defaults, sourceLong), [ctx.defaults, sourceLong]);
  const [state, setState] = useState<CompressState>(initial);
  const [committed, setCommitted] = useState<Committed | null>(null);
  const [reported, setReported] = useState<ReadonlyMap<string, FileFormat>>(() => new Map());

  const options = useMemo(() => compressOptions(state), [state]);
  const first = ctx.files[0];
  const multi = ctx.files.length > 1;
  const box = usePreviewBox(multi ? 600 : 470, 300);
  const display = fitSize({ width: ctx.image.orientedWidth, height: ctx.image.orientedHeight }, box);
  const { preview: latest, pending, error, upToDate } = usePreview(ctx.editorId, options, { maxEdge: previewEdgeFor(display), enabled: committed === null });
  // Image, estimate and size switch together once the new preview image has decoded.
  const preview = useDecodedPreview(latest);
  const shownUrl = preview?.url ?? ctx.source.url;
  // Several files: every file gets a real estimate (debounced, superseded on change).
  const batch = useBatchEstimates(ctx.editorId, ctx.files, options, { enabled: multi && committed === null });
  const summary = useMemo(() => summarizeEstimates(ctx.files, batch.entries), [ctx.files, batch.entries]);

  // Output formats the processor reported for the current format option (they don't depend on the other options).
  useEffect(() => {
    const found: [string, FileFormat][] = [];
    if (first !== undefined && upToDate && latest?.outputFormat !== undefined) found.push([formatKey(first.fileId, state.format), latest.outputFormat]);
    for (const [fileId, entry] of batch.entries) {
      if (entry.status === 'ok' && entry.outputFormat !== undefined) found.push([formatKey(fileId, state.format), entry.outputFormat]);
    }
    if (found.length === 0) return;
    setReported((current) => {
      if (found.every(([key, format]) => current.get(key) === format)) return current;
      const next = new Map(current);
      for (const [key, format] of found) next.set(key, format);
      return next;
    });
  }, [first, upToDate, latest, batch.entries, state.format]);

  // The first file's format comes from its inspection (ctx.image), the others' from the selection.
  const inputFormatOf = (file: (typeof ctx.files)[number]): FileFormat => (file.fileId === first?.fileId ? ctx.image.format : (file.format ?? ctx.image.format));
  const targets = new Set(ctx.files.map((file) => reported.get(formatKey(file.fileId, state.format)) ?? effectiveFormat(state.format, inputFormatOf(file))));
  const showPngMode = targets.has('png');
  const showQuality = [...targets].some((format) => FORMAT_INFO[format].lossy);
  const formatChanges: FormatChange[] =
    state.format === 'input'
      ? ctx.files.flatMap((file) => {
          const to = reported.get(formatKey(file.fileId, 'input'));
          return to !== undefined ? [{ from: inputFormatOf(file), to }] : [];
        })
      : [];

  const inputBytes = ctx.image.bytes > 0 ? ctx.image.bytes : (first?.bytes ?? 0);
  const estimated = preview?.estimatedBytes;
  const change = estimated === undefined ? null : percentChange(inputBytes, estimated);
  const notSmaller = estimated !== undefined && estimated >= inputBytes;
  const changed = JSON.stringify(state) !== JSON.stringify(initial);
  const presets = MAX_EDGE_PRESETS.filter((edge) => edge < sourceLong);
  const customMax = Math.min(MAX_EDGE_LIMIT, sourceLong);
  const edgeChoice = state.maxEdge === null ? 'keep' : presets.includes(state.maxEdge) ? String(state.maxEdge) : 'custom';

  const update = (patch: Partial<CompressState>) => setState((s) => ({ ...s, ...patch }));

  /** Estimates that describe exactly the options being committed (shown again next to the real results). */
  const currentEstimates = (): ReadonlyMap<string, number> => {
    const map = new Map<string, number>();
    if (multi) {
      for (const [fileId, entry] of batch.entries) if (entry.status === 'ok') map.set(fileId, entry.bytes);
    } else if (first !== undefined && upToDate && latest?.estimatedBytes !== undefined) {
      map.set(first.fileId, latest.estimatedBytes);
    }
    return map;
  };

  const run = async () => {
    const estimates = currentEstimates();
    const result = await commit.commit(options, true);
    if (result === null || result.kind === 'rejected') return;
    if (result.kind === 'jobs') setCommitted({ jobIds: result.jobIds, estimates });
    else orbit.closeWindow();
  };

  if (committed !== null) {
    return <CompressResults ctx={ctx} title={title} commit={commit} jobIds={committed.jobIds} estimates={committed.estimates} />;
  }

  const qualitySlider = (disabled: boolean) => (
    <SliderField label={t('compress.quality')} value={state.quality} min={1} max={100} onChange={(quality) => update({ quality })} disabled={disabled} />
  );

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
      {multi ? (
        <>
          {first ? <p className="compress-first muted">{t('compress.previewOf', { name: first.name })}</p> : null}
          <BatchTotals summary={summary} />
          <EstimateList files={ctx.files} entries={batch.entries} />
        </>
      ) : (
        <>
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
          {estimated !== undefined ? (
            notSmaller ? (
              <Notice tone="warning">{t('compress.notSmaller')}</Notice>
            ) : (
              <p className="compress-expect">{t('compress.smaller', { percent: Math.abs(change ?? 0) })}</p>
            )
          ) : null}
        </>
      )}
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
        <FormatResolvedNote changes={formatChanges} className="compress-hint" />
        {showQuality ? qualitySlider(false) : null}
        {showPngMode ? (
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
        ) : null}
        {!showQuality && !showPngMode ? qualitySlider(true) : null}
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
  readonly estimates: ReadonlyMap<string, number>;
}

/**
 * After commit: follows the jobs and shows the real final size next to the
 * input (and, muted, the estimate made before) — never "success" when a
 * result did not shrink. Several files also get a total once all are done.
 */
function CompressResults({ ctx, title, commit, jobIds, estimates }: CompressResultsProps) {
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
        {jobIds.map((id, index) => {
          const file = ctx.files[index];
          return (
            <CompressResultRow
              key={id}
              job={jobs.get(id) ?? null}
              fallbackName={file?.name ?? ctx.files[0]?.name ?? ''}
              estimate={file === undefined ? undefined : estimates.get(file.fileId)}
            />
          );
        })}
      </ul>
      {allDone && jobIds.length > 1 ? <ResultTotals jobs={jobIds.map((id) => jobs.get(id)).filter((job): job is JobSnapshot => job !== undefined)} /> : null}
    </EditorFrame>
  );
}

/** Input → final size over the completed jobs of a batch; warning tone when the total did not shrink. */
function ResultTotals({ jobs }: { readonly jobs: readonly JobSnapshot[] }) {
  const { t, platform } = useEnv();
  const completed = jobs.filter((job) => job.state === 'completed' && job.outputs.length > 0);
  if (completed.length === 0) return null;
  const input = completed.reduce((sum, job) => sum + job.inputBytes, 0);
  const output = completed.reduce((sum, job) => sum + job.outputs.reduce((s, o) => s + o.bytes, 0), 0);
  const smaller = output < input;
  return (
    <p className="compress-total tabular" data-tone={smaller ? 'good' : 'warning'} role="status">
      {t('compress.resultTotal', { input: formatBytes(input, t.locale, platform), output: formatBytes(output, t.locale, platform) })}{' '}
      <strong>{t('common.percent', { value: signedPercent(percentChange(input, output)) })}</strong>
    </p>
  );
}

function CompressResultRow({ job, fallbackName, estimate }: { readonly job: JobSnapshot | null; readonly fallbackName: string; readonly estimate: number | undefined }) {
  const { orbit, t, platform } = useEnv();
  const name = job?.inputName ?? fallbackName;
  const estimateNote =
    estimate === undefined ? null : <p className="compress-result-estimate muted tabular">{t('compress.resultEstimate', { size: formatBytes(estimate, t.locale, platform) })}</p>;

  let body: ReactNode;
  if (job === null || job.state === 'queued' || job.state === 'running') {
    const progress = job?.progress;
    body = (
      <>
        {progress?.kind === 'determinate' && progress.total > 0 ? (
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
        )}
        {estimateNote}
      </>
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
        {estimateNote}
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
