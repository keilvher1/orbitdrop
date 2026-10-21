import {
  BACKGROUND_PRESETS,
  COMPOSITION_LIMITS,
  OUTPUT_RATIOS,
  SOLID_BACKGROUNDS,
  type Background,
  type CompositionLayout,
  type CompositionSpec,
  type EditorContext,
  type OutputRatio,
  type Settings,
} from '@orbitdrop/contracts';
import { computeCompositionLayoutDetails, type CompositionLayoutDetails } from '@orbitdrop/core';
import { ImagePlus, Pipette } from 'lucide-react';
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { asErrorInfo } from '../../../app/errors';
import { useEnv } from '../../../app/env';
import { Notice, Spinner } from '../../../components/Notice';
import { Segmented } from '../../../components/Segmented';
import { SliderField } from '../../../components/SliderField';
import { fitSize, type Size } from '../crop/cropMath';
import { EditorFrame, useEditorCommit } from '../EditorFrame';
import { isNumber, isOneOf, isRecord, outputFileName, pick, previewEdgeFor, PreviewError, Stage, useDecodedPreview, usePreviewBox } from '../editorKit';
import { usePreview } from '../usePreview';
import { presetBackgroundStyle } from './backgroundCss';
import './background.css';

/** Title bar, swatches, three sliders, ratio, format, notes and footer. */
const RESERVED_HEIGHT = 470;
const SWATCH = 28;
const HEX = /^#[0-9a-fA-F]{6}$/;

const clampInt = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

function isBackground(value: unknown): value is Background {
  if (!isRecord(value)) return false;
  if (value.kind === 'solid') return typeof value.color === 'string' && HEX.test(value.color);
  if (value.kind === 'preset') return BACKGROUND_PRESETS.some((p) => p.id === value.presetId);
  if (value.kind === 'image') return typeof value.fileId === 'string' && value.fileId.length > 0;
  return false;
}

/** CompositionSpec to start from: ctx.defaults (filled by main from settings), with safe fallbacks. */
export function readCompositionDefaults(defaults: unknown, settings: Settings, oriented: Size): CompositionSpec {
  const L = COMPOSITION_LIMITS;
  const maxEdge = clampInt(pick(defaults, 'maxEdge', isNumber, settings.background.maxEdge), L.maxEdge.min, L.maxEdge.max);
  const base = Math.min(maxEdge, Math.max(oriented.width, oriented.height));
  const record = isRecord(defaults) ? defaults : {};
  return {
    background: isBackground(record.background) ? record.background : { kind: 'preset', presetId: BACKGROUND_PRESETS[0]?.id ?? 'ember' },
    padding: clampInt(pick(defaults, 'padding', isNumber, base * 0.08), L.padding.min, L.padding.max),
    cornerRadius: clampInt(pick(defaults, 'cornerRadius', isNumber, base * 0.03), L.cornerRadius.min, L.cornerRadius.max),
    shadow: clampInt(pick(defaults, 'shadow', isNumber, base * 0.02), L.shadow.min, L.shadow.max),
    ratio: isOneOf(OUTPUT_RATIOS)(record.ratio) ? record.ratio : 'auto',
    maxEdge,
    format: record.format === 'jpeg' ? 'jpeg' : 'png',
    quality: clampInt(pick(defaults, 'quality', isNumber, 92), 1, 100),
  };
}

/**
 * Slider ranges in final output pixels, relative to the output size: the
 * output's long edge is about min(maxEdge, image long edge). The numeric
 * fields accept the full schema range.
 */
export function sliderRanges(oriented: Size, maxEdge: number) {
  const long = Math.max(1, Math.min(maxEdge, Math.max(oriented.width, oriented.height)));
  const short = (long * Math.min(oriented.width, oriented.height)) / Math.max(oriented.width, oriented.height);
  return {
    padding: Math.min(COMPOSITION_LIMITS.padding.max, Math.max(50, Math.round(long * 0.5))),
    cornerRadius: Math.min(COMPOSITION_LIMITS.cornerRadius.max, Math.max(10, Math.round(short / 2))),
    shadow: Math.min(COMPOSITION_LIMITS.shadow.max, Math.max(20, Math.round(long * 0.1))),
  };
}

function safeLayout(oriented: Size, spec: CompositionSpec): CompositionLayoutDetails | null {
  try {
    return computeCompositionLayoutDetails(oriented.width, oriented.height, spec);
  } catch {
    return null;
  }
}

interface SwatchItem {
  readonly key: string;
  readonly label: string;
  readonly style: CSSProperties;
  readonly checked: boolean;
  readonly select: () => void;
  readonly content?: ReactNode;
}

/** Single-selection swatch radio group with roving focus (arrow keys select, like native radios). */
function SwatchGroup({ label, items }: { readonly label: string; readonly items: readonly SwatchItem[] }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const checkedIndex = items.findIndex((i) => i.checked);
  const tabIndexOf = (index: number) => (index === (checkedIndex === -1 ? 0 : checkedIndex) ? 0 : -1);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const step = keys[event.key];
    if (step === undefined && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const from = Math.max(0, refs.current.findIndex((el) => el === document.activeElement));
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (from + (step ?? 0) + items.length) % items.length;
    items[next]?.select();
    refs.current[next]?.focus();
  };
  return (
    <div className="swatch-grid" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, index) => (
        <button
          key={item.key}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="radio"
          className="swatch"
          aria-checked={item.checked}
          aria-label={item.label}
          title={item.label}
          tabIndex={tabIndexOf(index)}
          style={item.style}
          onClick={item.select}
        >
          {item.content}
        </button>
      ))}
    </div>
  );
}

/**
 * Add Background editor (spec §7). The big preview is always rendered by the
 * processor from the same CompositionSpec as the final export; slider values
 * are final output pixels. Nothing is written before "Save with Background".
 */
export function BackgroundEditor({ ctx, title }: { readonly ctx: EditorContext; readonly title: string }) {
  const { t, orbit } = useEnv();
  const commit = useEditorCommit(ctx.editorId);
  const oriented = useMemo<Size>(() => ({ width: ctx.image.orientedWidth, height: ctx.image.orientedHeight }), [ctx.image]);
  const initial = useMemo(() => readCompositionDefaults(ctx.defaults, ctx.settings, oriented), [ctx.defaults, ctx.settings, oriented]);
  const [spec, setSpec] = useState<CompositionSpec>(initial);
  const [bgImage, setBgImage] = useState<{ readonly fileId: string; readonly name: string } | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [customColor, setCustomColor] = useState<string>(() => (initial.background.kind === 'solid' ? initial.background.color : '#F2552C'));
  const box = usePreviewBox(RESERVED_HEIGHT, 340);
  const ranges = useMemo(() => sliderRanges(oriented, spec.maxEdge), [oriented, spec.maxEdge]);

  const { preview, pending, error } = usePreview(ctx.editorId, spec, { maxEdge: previewEdgeFor(box) });
  const shown = useDecodedPreview(preview);
  const details = useMemo(() => safeLayout(oriented, spec), [oriented, spec]);
  // The processor's layout is authoritative; the local one gives instant feedback while a preview renders.
  const layout: CompositionLayout | null = (pending ? details?.layout : (preview?.layout ?? details?.layout)) ?? null;
  const outputSize: Size | null = layout?.canvas ?? (preview?.outputWidth && preview.outputHeight ? { width: preview.outputWidth, height: preview.outputHeight } : null);
  const display = fitSize(shown ? { width: shown.width, height: shown.height } : (details?.layout.canvas ?? oriented), box);

  const update = (patch: Partial<CompositionSpec>) => setSpec((s) => ({ ...s, ...patch }));
  const setBackground = (background: Background) => update({ background });

  const bg = spec.background;
  const items: SwatchItem[] = [
    ...BACKGROUND_PRESETS.map((preset) => ({
      key: `preset-${preset.id}`,
      label: t('bg.presetLabel', { name: t.text(preset.label) }),
      style: presetBackgroundStyle(preset, SWATCH, SWATCH),
      checked: bg.kind === 'preset' && bg.presetId === preset.id,
      select: () => setBackground({ kind: 'preset', presetId: preset.id }),
    })),
    ...SOLID_BACKGROUNDS.map((color) => ({
      key: `solid-${color}`,
      label: t('bg.solidLabel', { color }),
      style: { backgroundColor: color },
      checked: bg.kind === 'solid' && bg.color.toUpperCase() === color.toUpperCase(),
      select: () => setBackground({ kind: 'solid', color }),
    })),
    ...(bgImage
      ? [
          {
            key: 'image',
            label: t('bg.imageSelected', { name: bgImage.name }),
            style: {},
            checked: bg.kind === 'image',
            select: () => setBackground({ kind: 'image', fileId: bgImage.fileId }),
            content: <ImagePlus size={15} aria-hidden="true" />,
          },
        ]
      : []),
  ];
  const customSelected = bg.kind === 'solid' && !SOLID_BACKGROUNDS.some((c) => c.toUpperCase() === bg.color.toUpperCase());

  const pickImage = async () => {
    setPickError(null);
    try {
      const picked = await orbit.pickBackgroundImage(ctx.editorId);
      if (picked === null) return;
      setBgImage(picked);
      setBackground({ kind: 'image', fileId: picked.fileId });
    } catch (reason) {
      setPickError(t.error(asErrorInfo(reason)));
    }
  };

  const reset = () => {
    setSpec(initial);
  };

  const notes: string[] = [];
  if (layout?.paddingExpandedByRatio) notes.push(t('bg.note.ratio'));
  if (layout?.paddingExpandedByShadow) notes.push(t('bg.note.shadow'));
  if (details?.paddingReducedByMaxEdge) notes.push(t('bg.note.reduced', { padding: details.effectivePadding }));

  return (
    <EditorFrame
      title={title}
      commit={commit}
      primaryLabel={t('bg.save')}
      onPrimary={() => void commit.commit(spec)}
      onReset={reset}
      footerNote={t('editor.outputName', { name: outputFileName(ctx, spec.format) })}
    >
      <Stage display={display} pending={pending && shown !== null}>
        {shown ? (
          <img src={shown.url} alt={t('editor.previewAlt')} draggable={false} />
        ) : (
          <div className="stage-placeholder" role="status">
            <Spinner size={18} label={t('editor.previewLoading')} />
          </div>
        )}
      </Stage>
      <div className="editor-meta">
        <span>{outputSize ? <strong>{t('editor.outputSize', { width: outputSize.width, height: outputSize.height })}</strong> : null}</span>
        <span>{t('editor.sourceSize', { width: oriented.width, height: oriented.height })}</span>
      </div>
      <PreviewError error={error} />
      {notes.length > 0 ? (
        <Notice tone="info" live="polite">
          {notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </Notice>
      ) : null}

      <section className="editor-section" aria-labelledby="bg-background-title">
        <h2 className="editor-section-title" id="bg-background-title">
          {t('bg.background')}
        </h2>
        <div className="bg-swatches">
          <SwatchGroup label={t('bg.background')} items={items} />
          <div className="bg-swatch-actions">
            <label className={`swatch swatch-icon bg-custom${customSelected ? ' is-selected' : ''}`} title={t('bg.custom')} style={customSelected ? { backgroundColor: bg.color } : undefined}>
              <Pipette size={14} aria-hidden="true" />
              <input
                type="color"
                aria-label={t('bg.custom')}
                value={customColor}
                onChange={(event) => {
                  const color = event.target.value.toUpperCase();
                  setCustomColor(color);
                  setBackground({ kind: 'solid', color });
                }}
              />
            </label>
            <button type="button" className="swatch swatch-icon" aria-label={t('bg.image')} title={t('bg.image')} onClick={() => void pickImage()}>
              <ImagePlus size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        {bgImage && bg.kind === 'image' ? <p className="muted bg-image-name">{t('bg.imageSelected', { name: bgImage.name })}</p> : null}
        {pickError ? <Notice tone="danger">{pickError}</Notice> : null}
      </section>

      <div className="editor-controls">
        <SliderField
          label={t('bg.padding')}
          value={spec.padding}
          min={COMPOSITION_LIMITS.padding.min}
          max={ranges.padding}
          inputMax={COMPOSITION_LIMITS.padding.max}
          unit={t('common.px')}
          onChange={(padding) => update({ padding })}
        />
        <SliderField
          label={t('bg.corners')}
          value={spec.cornerRadius}
          min={COMPOSITION_LIMITS.cornerRadius.min}
          max={ranges.cornerRadius}
          inputMax={COMPOSITION_LIMITS.cornerRadius.max}
          unit={t('common.px')}
          onChange={(cornerRadius) => update({ cornerRadius })}
        />
        <SliderField
          label={t('bg.shadow')}
          value={spec.shadow}
          min={COMPOSITION_LIMITS.shadow.min}
          max={ranges.shadow}
          inputMax={COMPOSITION_LIMITS.shadow.max}
          unit={t('common.px')}
          onChange={(shadow) => update({ shadow })}
        />
        <div className="field-row">
          <span className="field-label">{t('bg.ratio')}</span>
          <Segmented<OutputRatio>
            label={t('bg.ratio')}
            value={spec.ratio}
            onChange={(ratio) => update({ ratio })}
            options={OUTPUT_RATIOS.map((ratio) => ({ value: ratio, label: ratio === 'auto' ? t('bg.ratio.auto') : ratio }))}
          />
        </div>
        <div className="field-row">
          <span className="field-label">{t('editor.format')}</span>
          <Segmented<'png' | 'jpeg'>
            label={t('editor.format')}
            value={spec.format}
            onChange={(format) => update({ format })}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'jpeg', label: 'JPEG' },
            ]}
          />
        </div>
        {spec.format === 'jpeg' ? (
          <>
            <SliderField label={t('editor.quality')} value={spec.quality} min={1} max={100} onChange={(quality) => update({ quality })} />
            <p className="muted bg-hint">{t('bg.jpegNote')}</p>
          </>
        ) : null}
        <p className="muted bg-hint">{t('bg.note.maxEdge', { maxEdge: spec.maxEdge })}</p>
      </div>
    </EditorFrame>
  );
}
