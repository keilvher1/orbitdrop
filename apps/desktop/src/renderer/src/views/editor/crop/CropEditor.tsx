import { ASPECT_RATIOS, type AspectRatioId, type EditorContext } from '@orbitdrop/contracts';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useEnv } from '../../../app/env';
import { Segmented } from '../../../components/Segmented';
import { EditorFrame, useEditorCommit } from '../EditorFrame';
import { isOneOf, isRecord, outputFileName, Stage, usePreviewBox } from '../editorKit';
import {
  HANDLES,
  applyAspect,
  clampRect,
  editorMapping,
  initialCropRect,
  moveRect,
  nudgeRect,
  parseDimension,
  rectEquals,
  rectFromPoints,
  resizeRect,
  setRectDimension,
  sourceRectToView,
  viewToSource,
  type DimensionError,
  type Handle,
  type Point,
  type Rect,
  type Size,
} from './cropMath';
import './crop.css';

/** Title bar + aspect + W/H + footer, reserved below/above the image stage. */
const RESERVED_HEIGHT = 250;

interface CropDefaults {
  readonly rect: Rect;
  readonly aspect: AspectRatioId;
  /** Other CropOptions fields (outputFormat, quality, flattenBackground) passed through. */
  readonly rest: Record<string, unknown>;
}

function isRect(value: unknown): value is Rect {
  return isRecord(value) && ['x', 'y', 'width', 'height'].every((k) => typeof value[k] === 'number' && Number.isFinite(value[k]));
}

const OUTPUT_FORMATS = ['input', 'png', 'jpeg', 'webp'] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Starting options from ctx.defaults. CropOptionsSchema is strict, so only its
 * known fields are passed through (outputFormat, quality, flattenBackground).
 */
export function readCropDefaults(defaults: unknown, oriented: Size): CropDefaults {
  const record = isRecord(defaults) ? defaults : {};
  const aspect = isOneOf(ASPECT_RATIOS)(record.aspect) ? record.aspect : 'free';
  const rect = isRect(record.rect) ? clampRect(record.rect, oriented) : initialCropRect(aspect, oriented);
  const rest: Record<string, unknown> = {};
  if (isOneOf(OUTPUT_FORMATS)(record.outputFormat)) rest.outputFormat = record.outputFormat;
  if (typeof record.quality === 'number' && Number.isInteger(record.quality) && record.quality >= 1 && record.quality <= 100) rest.quality = record.quality;
  if (typeof record.flattenBackground === 'string' && HEX.test(record.flattenBackground)) rest.flattenBackground = record.flattenBackground;
  return { rect, aspect, rest };
}

type Drag =
  | { readonly kind: 'move'; readonly start: Rect; readonly origin: Point }
  | { readonly kind: 'resize'; readonly handle: Handle; readonly start: Rect; readonly origin: Point }
  | { readonly kind: 'new'; readonly anchor: Point };

function dimensionMessage(t: ReturnType<typeof useEnv>['t'], error: DimensionError): string {
  switch (error.kind) {
    case 'notInteger':
      return t('crop.error.notInteger');
    case 'range':
      return t('crop.error.range', { max: error.max });
    case 'ratio':
      return t('crop.error.ratio', { max: error.max });
  }
}

/**
 * Crop editor (spec §6). The selection is kept in oriented source pixels
 * (CropOptions.rect) and only mapped to the preview for display, so the result
 * matches what was selected on rotated photos and Retina screens alike.
 * Nothing is written before Apply.
 */
export function CropEditor({ ctx, title }: { readonly ctx: EditorContext; readonly title: string }) {
  const { t, platform } = useEnv();
  const commit = useEditorCommit(ctx.editorId);
  const oriented = useMemo<Size>(() => ({ width: ctx.image.orientedWidth, height: ctx.image.orientedHeight }), [ctx.image]);
  const defaults = useMemo(() => readCropDefaults(ctx.defaults, oriented), [ctx.defaults, oriented]);
  const [aspect, setAspect] = useState<AspectRatioId>(defaults.aspect);
  const [rect, setRect] = useState<Rect>(defaults.rect);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announce, setAnnounce] = useState('');
  const box = usePreviewBox(RESERVED_HEIGHT, 440);
  const mapping = useMemo(() => editorMapping(oriented, box), [oriented, box]);
  const layerRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const wId = useId();
  const hId = useId();

  // W/H fields: free text while focused, otherwise mirror the selection.
  const [editing, setEditing] = useState<'width' | 'height' | null>(null);
  const [wText, setWText] = useState(String(defaults.rect.width));
  const [hText, setHText] = useState(String(defaults.rect.height));
  useEffect(() => {
    if (editing !== 'width') setWText(String(rect.width));
    if (editing !== 'height') setHText(String(rect.height));
  }, [rect, editing]);
  const wResult = parseDimension(wText, 'width', aspect, oriented);
  const hResult = parseDimension(hText, 'height', aspect, oriented);
  const fieldsValid = wResult.ok && hResult.ok;

  // Typed values are applied to the selection as it was when the field got
  // focus, so intermediate keystrokes ("1", "10", "100"…) don't drift its centre.
  const editAnchor = useRef<Rect | null>(null);
  const onDimensionFocus = (axis: 'width' | 'height') => {
    editAnchor.current = rect;
    setEditing(axis);
  };

  const onDimensionChange = (axis: 'width' | 'height', text: string) => {
    if (axis === 'width') setWText(text);
    else setHText(text);
    // Anchor on the first change too (focus may not precede it, e.g. typing again after Enter).
    if (editAnchor.current === null) editAnchor.current = rect;
    const anchor = editAnchor.current;
    const parsed = parseDimension(text, axis, aspect, oriented);
    if (parsed.ok) setRect(setRectDimension(anchor, axis, parsed.value, aspect, oriented));
  };

  const onDimensionBlur = () => {
    editAnchor.current = null;
    setEditing(null);
  };

  /** Enter confirms; Esc first reverts an edit in progress (only an untouched field lets Esc cancel the editor). */
  const onDimensionKeyDown = (event: KeyboardEvent<HTMLInputElement>, axis: 'width' | 'height') => {
    if (event.key === 'Enter') {
      onDimensionBlur();
      return;
    }
    if (event.key !== 'Escape') return;
    const anchor = editAnchor.current;
    const text = axis === 'width' ? wText : hText;
    if (anchor === null || (rectEquals(anchor, rect) && text === String(anchor[axis]))) return;
    event.preventDefault();
    setRect(anchor);
    setWText(String(anchor.width));
    setHText(String(anchor.height));
  };

  const changeAspect = (next: AspectRatioId) => {
    setAspect(next);
    setRect((r) => applyAspect(r, next, oriented));
  };

  const reset = () => {
    setAspect(defaults.aspect);
    setRect(defaults.rect);
    setEditing(null);
  };

  // ------------------------------------------------------------- pointer
  const pointFromEvent = useCallback(
    (event: PointerEvent): Point => {
      const el = layerRef.current;
      const bounds = el?.getBoundingClientRect();
      if (!bounds || bounds.width === 0) return { x: 0, y: 0 };
      // Account for any CSS scaling between the layer's box and the mapped view size.
      const kx = mapping.view.width / bounds.width;
      const ky = mapping.view.height / bounds.height;
      return { x: (event.clientX - bounds.left) * kx, y: (event.clientY - bounds.top) * ky };
    },
    [mapping],
  );

  const beginDrag = (event: PointerEvent<HTMLElement>, next: Drag) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    layerRef.current?.setPointerCapture?.(event.pointerId);
    setDrag(next);
  };

  const onLayerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const p = viewToSource(pointFromEvent(event), mapping);
    beginDrag(event, { kind: 'new', anchor: p });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const p = viewToSource(pointFromEvent(event), mapping);
    switch (drag.kind) {
      case 'move':
        setRect(moveRect(drag.start, p.x - drag.origin.x, p.y - drag.origin.y, oriented));
        break;
      case 'resize':
        setRect(resizeRect(drag.start, drag.handle, p.x - drag.origin.x, p.y - drag.origin.y, aspect, oriented));
        break;
      case 'new': {
        const moved = Math.hypot(p.x - drag.anchor.x, p.y - drag.anchor.y) / (oriented.width / mapping.view.width);
        if (moved >= 3) setRect(rectFromPoints(drag.anchor, p, aspect, oriented));
        break;
      }
    }
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    layerRef.current?.releasePointerCapture?.(event.pointerId);
    setDrag(null);
  };

  // ------------------------------------------------------------ keyboard
  const onSelectionKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    // One step ≈ one on-screen pixel (at least one source pixel), ×10 with Shift.
    const base = Math.max(1, Math.round(oriented.width / mapping.view.width));
    const step = base * (event.shiftKey ? 10 : 1);
    const next = nudgeRect(rect, event.key, step, event.altKey, aspect, oriented);
    setRect(next);
    setAnnounce(t('crop.announce', { width: next.width, height: next.height, x: next.x, y: next.y }));
  };

  const view = sourceRectToView(rect, mapping);
  const aspectOptions = ASPECT_RATIOS.map((id) => ({ value: id, label: id === 'free' ? t('crop.aspect.free') : id }));

  const apply = () => {
    if (!fieldsValid) return;
    void commit.commit({ ...defaults.rest, rect, aspect });
  };

  return (
    <EditorFrame
      title={title}
      commit={commit}
      primaryLabel={t('common.apply')}
      onPrimary={apply}
      primaryDisabled={!fieldsValid || drag !== null}
      onReset={reset}
      footerNote={t('editor.outputName', { name: outputFileName(ctx) })}
    >
      <Stage display={mapping.view} checker={ctx.image.hasAlpha}>
        <img src={ctx.source.url} alt={t('editor.sourceAlt')} draggable={false} />
        <div
          ref={layerRef}
          className="crop-layer"
          data-dragging={drag !== null}
          onPointerDown={onLayerPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            className="crop-selection"
            style={{ left: view.x, top: view.y, width: view.width, height: view.height }}
            role="group"
            tabIndex={0}
            aria-label={`${t('crop.selection')} ${t('common.dimensions', { width: rect.width, height: rect.height })}`}
            aria-describedby={helpId}
            onKeyDown={onSelectionKeyDown}
            onPointerDown={(event) => beginDrag(event, { kind: 'move', start: rect, origin: viewToSource(pointFromEvent(event), mapping) })}
          >
            <div className="crop-grid" aria-hidden="true" />
            {HANDLES.map((handle) => (
              <div
                key={handle}
                className="crop-handle"
                data-handle={handle}
                aria-hidden="true"
                onPointerDown={(event) =>
                  beginDrag(event, { kind: 'resize', handle, start: rect, origin: viewToSource(pointFromEvent(event), mapping) })
                }
              />
            ))}
          </div>
        </div>
      </Stage>
      <span id={helpId} className="visually-hidden">
        {t('crop.selectionHelp', { alt: platform === 'darwin' ? 'Option' : 'Alt' })}
      </span>
      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>

      <div className="editor-controls">
        <div className="field-row">
          <span className="field-label">{t('crop.aspect')}</span>
          <Segmented<AspectRatioId> label={t('crop.aspect')} value={aspect} onChange={changeAspect} options={aspectOptions} />
        </div>
        <div className="field-row crop-size-row">
          <span className="field-label">{t('crop.selection')}</span>
          <div className="crop-size">
            <label className="crop-dim" htmlFor={wId}>
              <span aria-hidden="true">{t('common.widthShort')}</span>
              <input
                id={wId}
                className="text-input num-input"
                inputMode="numeric"
                aria-label={t('common.width')}
                aria-invalid={!wResult.ok}
                aria-describedby={wResult.ok ? undefined : `${wId}-err`}
                value={wText}
                onFocus={() => onDimensionFocus('width')}
                onBlur={onDimensionBlur}
                onChange={(event) => onDimensionChange('width', event.target.value)}
                onKeyDown={(event) => onDimensionKeyDown(event, 'width')}
              />
            </label>
            <label className="crop-dim" htmlFor={hId}>
              <span aria-hidden="true">{t('common.heightShort')}</span>
              <input
                id={hId}
                className="text-input num-input"
                inputMode="numeric"
                aria-label={t('common.height')}
                aria-invalid={!hResult.ok}
                aria-describedby={hResult.ok ? undefined : `${hId}-err`}
                value={hText}
                onFocus={() => onDimensionFocus('height')}
                onBlur={onDimensionBlur}
                onChange={(event) => onDimensionChange('height', event.target.value)}
                onKeyDown={(event) => onDimensionKeyDown(event, 'height')}
              />
            </label>
            <span className="unit">{t('common.px')}</span>
          </div>
        </div>
        {!wResult.ok ? (
          <p className="field-error crop-error" id={`${wId}-err`} role="alert">
            {t('common.width')}: {dimensionMessage(t, wResult.error)}
          </p>
        ) : null}
        {!hResult.ok ? (
          <p className="field-error crop-error" id={`${hId}-err`} role="alert">
            {t('common.height')}: {dimensionMessage(t, hResult.error)}
          </p>
        ) : null}
        <p className="editor-meta">
          <span>{t('editor.sourceSize', { width: oriented.width, height: oriented.height })}</span>
          <span>{t('crop.noUpscale')}</span>
        </p>
      </div>
    </EditorFrame>
  );
}
