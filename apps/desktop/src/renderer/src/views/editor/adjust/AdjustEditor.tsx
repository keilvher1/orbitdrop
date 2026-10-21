import type { EditOptions, EditorContext, ToolOutputFormat } from '@orbitdrop/contracts';
// Lucide's legacy FlipHorizontal2/FlipVertical2 aliases draw the mirror axis the other
// way round; the explicit names show the axis the image is mirrored across.
import { RotateCcw, RotateCw, TrianglesCenterlineDashedHorizontal, TrianglesCenterlineDashedVertical } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useEnv } from '../../../app/env';
import { SliderField } from '../../../components/SliderField';
import { fitSize } from '../crop/cropMath';
import { EditorFrame, useEditorCommit } from '../EditorFrame';
import { PreviewError, Stage, isBoolean, isNumber, isOneOf, outputFileName, pick, previewEdgeFor, useDecodedPreview, usePreviewBox } from '../editorKit';
import { usePreview } from '../usePreview';
import './adjust.css';

export type Rotation = EditOptions['rotate'];
const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
const OUTPUT_FORMATS: readonly ToolOutputFormat[] = ['input', 'png', 'jpeg', 'webp'];

export interface AdjustState {
  readonly rotate: Rotation;
  readonly flipH: boolean;
  readonly flipV: boolean;
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
}

export const NEUTRAL_ADJUST: AdjustState = { rotate: 0, flipH: false, flipV: false, brightness: 0, contrast: 0, saturation: 0 };

const isRotation = (v: unknown): v is Rotation => typeof v === 'number' && (ROTATIONS as readonly number[]).includes(v);
const clampAdjust = (v: number) => Math.min(100, Math.max(-100, Math.round(v)));

export function adjustDefaults(raw: unknown): AdjustState {
  return {
    rotate: pick(raw, 'rotate', isRotation, 0),
    flipH: pick(raw, 'flipH', isBoolean, false),
    flipV: pick(raw, 'flipV', isBoolean, false),
    brightness: clampAdjust(pick(raw, 'brightness', isNumber, 0)),
    contrast: clampAdjust(pick(raw, 'contrast', isNumber, 0)),
    saturation: clampAdjust(pick(raw, 'saturation', isNumber, 0)),
  };
}

/** Turn by ±90° (clockwise positive), staying in 0/90/180/270. */
export function rotateBy(rotate: Rotation, delta: 90 | -90): Rotation {
  return (((rotate + delta) % 360) + 360) % 360 as Rotation;
}

/** Output size after rotation (90/270 swap width and height). */
export function rotatedSize(width: number, height: number, rotate: Rotation): { width: number; height: number } {
  return rotate === 90 || rotate === 270 ? { width: height, height: width } : { width, height };
}

/** Options exactly as EditOptionsSchema expects (strict object). */
export function adjustOptions(state: AdjustState, outputFormat: ToolOutputFormat, quality?: number): EditOptions {
  return {
    rotate: state.rotate,
    flipH: state.flipH,
    flipV: state.flipV,
    brightness: state.brightness,
    contrast: state.contrast,
    saturation: state.saturation,
    outputFormat,
    ...(quality === undefined ? {} : { quality }),
  };
}

const signed = (v: number) => (v > 0 ? `+${v}` : String(v));

export function AdjustEditor({ ctx, title }: { readonly ctx: EditorContext; readonly title: string }) {
  const { t } = useEnv();
  const commit = useEditorCommit(ctx.editorId);
  const initial = useMemo(() => adjustDefaults(ctx.defaults), [ctx.defaults]);
  const outputFormat = pick(ctx.defaults, 'outputFormat', isOneOf(OUTPUT_FORMATS), 'input');
  const qualityRaw = pick<number | undefined>(ctx.defaults, 'quality', (v): v is number => isNumber(v) && Number.isInteger(v) && v >= 1 && v <= 100, undefined);
  const [state, setState] = useState<AdjustState>(initial);

  const options = useMemo(() => adjustOptions(state, outputFormat, qualityRaw), [state, outputFormat, qualityRaw]);
  const output = rotatedSize(ctx.image.orientedWidth, ctx.image.orientedHeight, state.rotate);
  const box = usePreviewBox(400, 380);
  const display = fitSize(output, box);
  const { preview: latest, pending, error } = usePreview(ctx.editorId, options, { maxEdge: previewEdgeFor(display) });
  const preview = useDecodedPreview(latest);
  const shownUrl = preview?.url ?? ctx.source.url;

  const update = (patch: Partial<AdjustState>) => setState((s) => ({ ...s, ...patch }));
  const isNeutral = JSON.stringify(state) === JSON.stringify(NEUTRAL_ADJUST);

  return (
    <EditorFrame
      title={title}
      commit={commit}
      primaryLabel={t('common.apply')}
      onPrimary={() => void commit.commit(options)}
      onReset={() => setState(NEUTRAL_ADJUST)}
      resetDisabled={isNeutral}
      footerNote={t('editor.outputName', { name: outputFileName(ctx) })}
    >
      <Stage display={display} checker={ctx.image.hasAlpha} pending={pending}>
        {shownUrl ? <img src={shownUrl} alt={preview ? t('editor.previewAlt') : t('editor.sourceAlt')} draggable={false} /> : null}
      </Stage>
      <PreviewError error={error} />
      <div className="editor-meta">
        <span>{t('editor.outputSize', { width: output.width, height: output.height })}</span>
      </div>
      <div className="editor-controls">
        <div className="field-row">
          <span className="field-label">{t('adjust.transform')}</span>
          <div className="adjust-transform" role="group" aria-label={t('adjust.transform')}>
            <button type="button" className="btn-tool" onClick={() => update({ rotate: rotateBy(state.rotate, -90) })} aria-label={t('adjust.rotateLeft')} title={t('adjust.rotateLeft')}>
              <RotateCcw size={16} aria-hidden="true" />
            </button>
            <button type="button" className="btn-tool" onClick={() => update({ rotate: rotateBy(state.rotate, 90) })} aria-label={t('adjust.rotateRight')} title={t('adjust.rotateRight')}>
              <RotateCw size={16} aria-hidden="true" />
            </button>
            <span className="adjust-divider" aria-hidden="true" />
            <button type="button" className="btn-tool" aria-pressed={state.flipH} onClick={() => update({ flipH: !state.flipH })} aria-label={t('adjust.flipH')} title={t('adjust.flipH')}>
              <TrianglesCenterlineDashedVertical size={16} aria-hidden="true" />
            </button>
            <button type="button" className="btn-tool" aria-pressed={state.flipV} onClick={() => update({ flipV: !state.flipV })} aria-label={t('adjust.flipV')} title={t('adjust.flipV')}>
              <TrianglesCenterlineDashedHorizontal size={16} aria-hidden="true" />
            </button>
            <span className="adjust-rotation muted tabular" aria-live="polite">
              {state.rotate}°
            </span>
          </div>
        </div>
        <SliderField label={t('adjust.brightness')} value={state.brightness} min={-100} max={100} onChange={(v) => update({ brightness: clampAdjust(v) })} valueText={signed(state.brightness)} />
        <SliderField label={t('adjust.contrast')} value={state.contrast} min={-100} max={100} onChange={(v) => update({ contrast: clampAdjust(v) })} valueText={signed(state.contrast)} />
        <SliderField label={t('adjust.saturation')} value={state.saturation} min={-100} max={100} onChange={(v) => update({ saturation: clampAdjust(v) })} valueText={signed(state.saturation)} />
      </div>
    </EditorFrame>
  );
}
