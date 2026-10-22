import { FORMAT_INFO, type EditorContext, type ImageInfo, type MetadataOptions, type OrbitErrorInfo, type ToolOutputFormat } from '@orbitdrop/contracts';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { asErrorInfo } from '../../../app/errors';
import { useEnv } from '../../../app/env';
import { Notice, Spinner } from '../../../components/Notice';
import type { Translator } from '../../../i18n/catalog';
import { formatBytes } from '../../../i18n/format';
import { EditorFrame, useEditorCommit } from '../EditorFrame';
import { MultiFileNote, isOneOf, pick, useScreenHeight } from '../editorKit';
import './metadata.css';

type IccPolicy = MetadataOptions['iccPolicy'];
const ICC_POLICIES: readonly IccPolicy[] = ['convertToSrgb', 'keep'];
const OUTPUT_FORMATS: readonly ToolOutputFormat[] = ['input', 'png', 'jpeg', 'webp'];

/** Options exactly as MetadataOptionsSchema expects (strict object). */
export function metadataOptions(iccPolicy: IccPolicy, outputFormat: ToolOutputFormat): MetadataOptions {
  return { mode: 'strip', iccPolicy, outputFormat };
}

/** sharp's `space` names → display text (technical names stay untranslated). */
export function colorSpaceLabel(space: string | null, t: Translator): string {
  if (space === null || space === '') return t('meta.unknown');
  switch (space.toLowerCase()) {
    case 'srgb':
      return 'sRGB';
    case 'rgb':
      return 'RGB';
    case 'rgb16':
      return t('meta.rgb16');
    case 'cmyk':
      return 'CMYK';
    case 'lab':
      return 'Lab';
    case 'b-w':
    case 'grey16':
      return t('meta.grayscale');
    default:
      return space;
  }
}

/** sharp's `depth` names → bits per sample. */
export function bitDepthLabel(depth: string | null, t: Translator): string {
  if (depth === null || depth === '') return t('meta.unknown');
  const bits: Record<string, [number, boolean]> = {
    uchar: [8, false],
    char: [8, false],
    ushort: [16, false],
    short: [16, false],
    uint: [32, false],
    int: [32, false],
    float: [32, true],
    double: [64, true],
  };
  const entry = bits[depth.toLowerCase()];
  if (entry === undefined) return depth;
  return entry[1] ? t('meta.bitsFloat', { bits: entry[0] }) : t('meta.bits', { bits: entry[0] });
}

interface Row {
  readonly label: string;
  readonly value: ReactNode;
}

function Section({ title, rows }: { readonly title: string; readonly rows: readonly Row[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="meta-section">
      <h2 className="editor-section-title">{title}</h2>
      <dl className="meta-list">
        {rows.map((row) => (
          <div className="meta-row" key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function MetadataEditor({ ctx, title }: { readonly ctx: EditorContext; readonly title: string }) {
  const { orbit, t, platform } = useEnv();
  const commit = useEditorCommit(ctx.editorId);
  const [info, setInfo] = useState<ImageInfo>(ctx.image);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<OrbitErrorInfo | null>(null);
  const initialPolicy = pick(ctx.defaults, 'iccPolicy', isOneOf(ICC_POLICIES), 'convertToSrgb');
  const outputFormat = pick(ctx.defaults, 'outputFormat', isOneOf(OUTPUT_FORMATS), 'input');
  const [iccPolicy, setIccPolicy] = useState<IccPolicy>(initialPolicy);
  const radioName = useId();
  // The tables scroll inside the panel so the primary button stays on screen.
  const screenHeight = useScreenHeight();
  const sectionsMaxHeight = Math.max(220, Math.min(560, screenHeight - 420));

  useEffect(() => {
    let cancelled = false;
    orbit.inspectImage(ctx.editorId).then(
      (next) => {
        if (cancelled) return;
        setInfo(next);
        setLoading(false);
      },
      (reason: unknown) => {
        if (cancelled) return;
        setLoadError(asErrorInfo(reason));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orbit, ctx.editorId]);

  const yesNo = (value: boolean) => (value ? t('common.yes') : t('common.no'));
  const exif = info.exif;
  const gps = exif?.gps ?? null;

  const fileRows: Row[] = [
    { label: t('meta.format'), value: FORMAT_INFO[info.format]?.label ?? info.format },
    { label: t('meta.fileSize'), value: formatBytes(info.bytes, t.locale, platform) },
    {
      label: t('meta.dimensions'),
      value: (
        <>
          {t('common.dimensions', { width: info.width, height: info.height })}
          {info.orientedWidth !== info.width || info.orientedHeight !== info.height ? (
            <span className="meta-sub">{t('meta.oriented', { width: info.orientedWidth, height: info.orientedHeight })}</span>
          ) : null}
        </>
      ),
    },
    { label: t('meta.orientation'), value: info.orientation === null ? '—' : String(info.orientation) },
  ];

  const imageRows: Row[] = [
    { label: t('meta.dpi'), value: info.density === null ? t('meta.unknown') : t('meta.dpiValue', { dpi: Math.round(info.density) }) },
    { label: t('meta.colorSpace'), value: colorSpaceLabel(info.space, t) },
    { label: t('meta.bitDepth'), value: bitDepthLabel(info.bitDepth, t) },
    { label: t('meta.alpha'), value: yesNo(info.hasAlpha) },
    { label: t('meta.icc'), value: info.hasIccProfile ? (info.iccDescription ?? t('common.yes')) : t('common.no') },
  ];

  const embeddedRows: Row[] = [
    { label: t('meta.exif'), value: yesNo(info.hasExif) },
    { label: t('meta.xmp'), value: yesNo(info.hasXmp) },
    { label: t('meta.iptc'), value: yesNo(info.hasIptc) },
  ];

  const captureRows: Row[] = [];
  if (exif) {
    const camera = [exif.make, exif.model].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
    if (camera) captureRows.push({ label: t('meta.camera'), value: camera });
    if (exif.lens) captureRows.push({ label: t('meta.lens'), value: exif.lens });
    if (exif.software) captureRows.push({ label: t('meta.software'), value: exif.software });
    if (exif.dateTimeOriginal) captureRows.push({ label: t('meta.date'), value: exif.dateTimeOriginal });
    if (exif.exposureTime) captureRows.push({ label: t('meta.exposure'), value: t('meta.exposureValue', { value: exif.exposureTime }) });
    if (exif.fNumber !== undefined) captureRows.push({ label: t('meta.fNumber'), value: `f/${exif.fNumber}` });
    if (exif.iso !== undefined) captureRows.push({ label: t('meta.iso'), value: String(exif.iso) });
    if (exif.focalLength !== undefined) captureRows.push({ label: t('meta.focal'), value: t('meta.focalValue', { value: exif.focalLength }) });
    captureRows.push({ label: t('meta.gps'), value: gps ? t('meta.gpsPresent') : t('common.no') });
  }
  const otherTags = exif?.other ?? [];

  return (
    <EditorFrame
      title={title}
      commit={commit}
      primaryLabel={t('meta.strip')}
      onPrimary={() => void commit.commit(metadataOptions(iccPolicy, outputFormat))}
      onReset={() => setIccPolicy(initialPolicy)}
      resetDisabled={iccPolicy === initialPolicy}
    >
      {ctx.files.length > 1 && ctx.files[0] ? <p className="meta-file muted">{ctx.files[0].name}</p> : null}
      {gps ? <Notice tone="warning">{t('meta.gpsWarning')}</Notice> : null}
      {loadError ? <Notice tone="danger">{t.error(loadError)}</Notice> : null}
      {loading ? (
        <p className="meta-loading muted" role="status">
          <Spinner size={12} /> {t('meta.loading')}
        </p>
      ) : null}
      <div className="meta-sections" style={{ maxHeight: sectionsMaxHeight }} tabIndex={0} role="region" aria-label={t('meta.details')} aria-busy={loading || undefined}>
        <Section title={t('meta.section.file')} rows={fileRows} />
        <Section title={t('meta.section.image')} rows={imageRows} />
        <Section title={t('meta.section.embedded')} rows={embeddedRows} />
        <Section title={t('meta.section.camera')} rows={captureRows} />
        {otherTags.length > 0 ? (
          <section className="meta-section">
            <h2 className="editor-section-title">{t('meta.otherTags')}</h2>
            <dl className="meta-list meta-other">
              {otherTags.map((tag, index) => (
                <div className="meta-row" key={`${tag.tag}-${index}`}>
                  <dt>{tag.tag}</dt>
                  <dd>{tag.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </div>
      <fieldset className="meta-policy">
        <legend className="editor-section-title">{t('meta.iccPolicy')}</legend>
        {ICC_POLICIES.map((policy) => (
          <label className="checkbox-row" key={policy}>
            <input type="radio" name={radioName} value={policy} checked={iccPolicy === policy} onChange={() => setIccPolicy(policy)} />
            <span>{policy === 'convertToSrgb' ? t('meta.icc.convert') : t('meta.icc.keep')}</span>
          </label>
        ))}
      </fieldset>
      <Notice tone="info" live="off">
        {t('meta.stripInfo')}
      </Notice>
      <MultiFileNote ctx={ctx} />
    </EditorFrame>
  );
}
