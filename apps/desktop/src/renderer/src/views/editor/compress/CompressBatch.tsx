import type { SelectedFile } from '@orbitdrop/contracts';
import { useId } from 'react';
import { useEnv } from '../../../app/env';
import { Notice } from '../../../components/Notice';
import { formatBytes, percentChange } from '../../../i18n/format';
import { useSettledAnnouncement } from '../editorKit';
import type { EstimateSummary, FileEstimate } from './useBatchEstimates';

/** "+12" / "−34" / "0" for percentage changes (true minus sign). */
export function signedPercent(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return '0';
}

/** Label of the change box: the Δ glyph for the eye, "Change" for screen readers. */
export function ChangeLabel() {
  const { t } = useEnv();
  return (
    <span className="compress-size-label">
      <span aria-hidden="true">Δ</span>
      <span className="visually-hidden">{t('compress.change')}</span>
    </span>
  );
}

/**
 * The estimate boxes are not a live region (they change on every slider step).
 * Instead one summary is spoken once the estimate has settled: `text` is null
 * while it is still changing or not up to date.
 */
export function EstimateAnnouncer({ text }: { readonly text: string | null }) {
  const spoken = useSettledAnnouncement(text);
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true">
      {spoken}
    </div>
  );
}

/**
 * Totals of a multi-file Compress: input sum, estimated sum (only once every
 * file has a real estimate — otherwise how many are done) and the change, then
 * one honest summary: not smaller in total, some files not smaller, or the
 * expected reduction. A not-smaller estimate is never shown as a success.
 */
export function BatchTotals({ summary }: { readonly summary: EstimateSummary }) {
  const { t, platform } = useEnv();
  const { estimatedBytes, inputBytes } = summary;
  const change = estimatedBytes === null ? null : percentChange(inputBytes, estimatedBytes);
  const totalNotSmaller = estimatedBytes !== null && estimatedBytes >= inputBytes;

  let estimatedText: string;
  if (estimatedBytes !== null) estimatedText = formatBytes(estimatedBytes, t.locale, platform);
  else if (summary.complete) estimatedText = '—'; // some estimates failed: no total to show
  else estimatedText = t('compress.estimateProgress', { done: summary.done, total: summary.total });

  // Warnings are not live regions (they come and go while estimates arrive): the settled summary speaks them.
  let warning: string | null = null;
  if (summary.complete && totalNotSmaller) warning = t('compress.batchNotSmaller');
  // Partial results already show files that will not shrink: say so now rather than after the rest.
  else if (summary.notSmaller > 0) warning = t.plural('compress.someNotSmaller', summary.notSmaller);
  let verdict = null;
  if (warning !== null)
    verdict = (
      <Notice tone="warning" live="off">
        {warning}
      </Notice>
    );
  else if (summary.complete && change !== null) verdict = <p className="compress-expect">{t('compress.batchSmaller', { percent: Math.abs(change) })}</p>;

  const changeText = change === null ? null : t('common.percent', { value: signedPercent(change) });
  // A total exists only once every file has an estimate for the current options (changing them makes all pending).
  const settled = changeText === null ? null : [t('compress.announceBatch', { size: estimatedText, change: changeText }), ...(warning === null ? [] : [warning])].join(' ');

  return (
    <>
      <div className="compress-sizes">
        <div className="compress-size">
          <span className="compress-size-label">{t('compress.totalInput')}</span>
          <strong className="tabular">{formatBytes(inputBytes, t.locale, platform)}</strong>
        </div>
        <div className="compress-size">
          <span className="compress-size-label">{t('compress.totalEstimated')}</span>
          <strong className="tabular" data-progress={estimatedBytes === null && !summary.complete ? true : undefined}>
            {estimatedText}
          </strong>
        </div>
        <div className="compress-size">
          <ChangeLabel />
          <strong className="tabular" data-tone={change === null ? undefined : totalNotSmaller ? 'warning' : 'good'}>
            {changeText ?? '—'}
          </strong>
        </div>
      </div>
      <EstimateAnnouncer text={settled} />
      {verdict}
    </>
  );
}

/** Per-file breakdown: name · input → estimate · change; not-smaller and failed files are marked. */
export function EstimateList({ files, entries }: { readonly files: readonly SelectedFile[]; readonly entries: ReadonlyMap<string, FileEstimate> }) {
  const { t, platform } = useEnv();
  const headingId = useId();
  return (
    <div className="editor-section">
      <h2 className="editor-section-title" id={headingId}>
        {t('compress.perFile')}
      </h2>
      <ul className="compress-estimates" aria-labelledby={headingId}>
        {files.map((file) => {
          const entry = entries.get(file.fileId) ?? { status: 'pending' as const };
          const input = formatBytes(file.bytes, t.locale, platform);
          let sizes: string;
          let tone: 'warning' | 'danger' | undefined;
          let delta = null;
          if (entry.status === 'ok') {
            const notSmaller = entry.bytes >= file.bytes;
            tone = notSmaller ? 'warning' : undefined;
            sizes = t('jobs.sizeChange', { input, output: formatBytes(entry.bytes, t.locale, platform) });
            delta = (
              <>
                <strong className="tabular" data-tone={notSmaller ? 'warning' : 'good'}>
                  {t('common.percent', { value: signedPercent(percentChange(file.bytes, entry.bytes)) })}
                </strong>
                {notSmaller ? (
                  <span className="compress-badge" data-tone="warning">
                    {t('compress.fileNotSmaller')}
                  </span>
                ) : null}
              </>
            );
          } else if (entry.status === 'error') {
            tone = 'danger';
            sizes = t('jobs.sizeChange', { input, output: '—' });
            const reason = t.error(entry.error);
            delta = (
              <span className="compress-badge" data-tone="danger" title={reason}>
                {t('compress.estimateFailed')}
                <span className="visually-hidden">: {reason}</span>
              </span>
            );
          } else {
            sizes = t('jobs.sizeChange', {
              input,
              output: entry.previous === undefined ? t('compress.estimating') : formatBytes(entry.previous, t.locale, platform),
            });
          }
          return (
            <li key={file.fileId} className="compress-estimate" data-tone={tone} data-pending={entry.status === 'pending' || undefined}>
              <span className="compress-estimate-name" title={file.name}>
                {file.name}
              </span>
              <span className="compress-estimate-sizes tabular">{sizes}</span>
              <span className="compress-estimate-delta">{delta}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
