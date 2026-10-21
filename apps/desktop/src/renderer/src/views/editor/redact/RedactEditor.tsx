import type { EditorContext, RedactRegion } from '@orbitdrop/contracts';
import { Grid3x3, Plus, Trash2 } from 'lucide-react';
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useEnv } from '../../../app/env';
import { Notice } from '../../../components/Notice';
import { Segmented } from '../../../components/Segmented';
import { SliderField } from '../../../components/SliderField';
import { newShapeId } from '../annotate/annotateModel';
import { SwatchGroup } from '../annotate/SwatchGroup';
import {
  HANDLES,
  editorMapping,
  moveRect,
  nudgeRect,
  rectFromPoints,
  resizeRect,
  sourcePerView,
  sourceRectToView,
  viewToSource,
  type Handle,
  type Point,
  type Rect,
} from '../crop/cropMath';
import { EditorFrame, useEditorCommit } from '../EditorFrame';
import { PreviewError, Stage, isOneOf, pick, previewEdgeFor, useDecodedPreview, usePreviewBox } from '../editorKit';
import { usePreview } from '../usePreview';
import './redact.css';

type RedactStyle = RedactRegion['style'];

/** Height kept free for the title bar, controls, notices and footer. */
const RESERVED = 440;
export const REDACT_COLORS: readonly string[] = ['#000000', '#FFFFFF', '#808080'];
export const BLOCK_SIZE = { min: 4, max: 256, initial: 16 } as const;
/** A pointer that moved less than this (view px) is a click, not a drag. */
const MIN_DRAG = 3;
/** Handle grab radius in view px. */
const HANDLE_HIT = 8;
const TOOL_FORMATS = ['input', 'png', 'jpeg', 'webp'] as const;
const STYLES: readonly RedactStyle[] = ['solid', 'mosaic'];

type Gesture =
  | { readonly kind: 'draw'; readonly anchor: Point; readonly startView: Point; readonly current: Point; readonly pointerId: number }
  | { readonly kind: 'move'; readonly id: string; readonly startView: Point; readonly original: Rect; readonly pointerId: number }
  | { readonly kind: 'resize'; readonly id: string; readonly handle: Handle; readonly startView: Point; readonly original: Rect; readonly pointerId: number };

const HANDLE_CURSORS: Readonly<Record<Handle, string>> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Position of a handle on a view rect. */
function handlePoint(r: Rect, handle: Handle): Point {
  const x = handle.includes('w') ? r.x : handle.includes('e') ? r.x + r.width : r.x + r.width / 2;
  const y = handle.includes('n') ? r.y : handle.includes('s') ? r.y + r.height : r.y + r.height / 2;
  return { x, y };
}

function withAlpha(hex: string, alpha: number): string {
  const value = /^#([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (value === undefined) return hex;
  const n = Number.parseInt(value, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Redact editor (tool.redact): drag rectangles over what must disappear;
 * each region is an opaque box or a mosaic. The base image is the processor
 * preview of the real redaction (or the source while there are no regions);
 * outlines and handles on top are only for editing. Nothing is written before
 * "Save Redacted".
 */
export function RedactEditor({ ctx, title }: { readonly ctx: EditorContext; readonly title: string }) {
  const { t, platform } = useEnv();
  const commit = useEditorCommit(ctx.editorId);
  const helpId = useId();
  const keysHelpId = useId();
  const [announcement, setAnnouncement] = useState('');
  const orientedWidth = Math.max(1, ctx.image.orientedWidth);
  const orientedHeight = Math.max(1, ctx.image.orientedHeight);
  const bounds = useMemo(() => ({ width: orientedWidth, height: orientedHeight }), [orientedWidth, orientedHeight]);
  const box = usePreviewBox(RESERVED, 400);
  const mapping = useMemo(() => editorMapping(bounds, box), [bounds, box.width, box.height]);
  const display = mapping.view;
  const spv = sourcePerView(mapping);
  const outputFormat = pick(ctx.defaults, 'outputFormat', isOneOf(TOOL_FORMATS), 'input');

  const regionsRef = useRef<readonly RedactRegion[]>([]);
  const [regions, setRegionsState] = useState<readonly RedactRegion[]>([]);
  const setRegions = useCallback((next: readonly RedactRegion[]) => {
    regionsRef.current = next;
    setRegionsState(next);
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = regions.find((region) => region.id === selectedId) ?? null;

  // Style for new regions; mirrors the selected region while one is selected.
  const [style, setStyle] = useState<RedactStyle>('solid');
  const [color, setColor] = useState<string>(REDACT_COLORS[0] ?? '#000000');
  const [blockSize, setBlockSize] = useState<number>(BLOCK_SIZE.initial);

  const options = useMemo(() => (regions.length > 0 ? { regions, outputFormat } : null), [regions, outputFormat]);
  const preview = usePreview(ctx.editorId, options, { maxEdge: previewEdgeFor(display) });
  const shown = useDecodedPreview(preview.preview);
  const imageUrl = options !== null && shown !== null ? shown.url : ctx.source.url;

  const selectRegion = useCallback((region: RedactRegion | null) => {
    setSelectedId(region?.id ?? null);
    if (region === null) return;
    setStyle(region.style);
    setColor(region.color);
    setBlockSize(region.blockSize);
  }, []);

  const updateRegion = useCallback(
    (id: string, patch: Partial<Omit<RedactRegion, 'id'>>) => {
      setRegions(regionsRef.current.map((region) => (region.id === id ? { ...region, ...patch } : region)));
    },
    [setRegions],
  );

  const removeRegion = useCallback(
    (id: string) => {
      setRegions(regionsRef.current.filter((region) => region.id !== id));
      setSelectedId((current) => (current === id ? null : current));
    },
    [setRegions],
  );

  // -------------------------------------------------------------- gestures
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const setGesture = (next: Gesture | null) => {
    gestureRef.current = next;
    setGestureState(next);
  };
  const [hoverCursor, setHoverCursor] = useState('crosshair');

  const viewPoint = (event: ReactPointerEvent<HTMLElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    const kx = rect.width > 0 ? display.width / rect.width : 1;
    const ky = rect.height > 0 ? display.height / rect.height : 1;
    return {
      x: clamp((event.clientX - rect.left) * kx, 0, display.width),
      y: clamp((event.clientY - rect.top) * ky, 0, display.height),
    };
  };

  const handleAt = (region: RedactRegion, p: Point): Handle | null => {
    const r = sourceRectToView(region.rect, mapping);
    let best: Handle | null = null;
    let bestDistance = HANDLE_HIT;
    for (const handle of HANDLES) {
      const h = handlePoint(r, handle);
      const distance = Math.hypot(p.x - h.x, p.y - h.y);
      if (distance <= bestDistance) {
        best = handle;
        bestDistance = distance;
      }
    }
    return best;
  };

  const regionAt = (p: Point): RedactRegion | null => {
    const list = regionsRef.current;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const region = list[i];
      if (region === undefined) continue;
      const r = sourceRectToView(region.rect, mapping);
      if (p.x >= r.x - 2 && p.x <= r.x + r.width + 2 && p.y >= r.y - 2 && p.y <= r.y + r.height + 2) return region;
    }
    return null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const p = viewPoint(event);
    surfaceRef.current?.focus({ preventScroll: true });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best effort (unsupported in some test environments).
    }
    if (selected !== null) {
      const handle = handleAt(selected, p);
      if (handle !== null) {
        setGesture({ kind: 'resize', id: selected.id, handle, startView: p, original: selected.rect, pointerId: event.pointerId });
        return;
      }
    }
    const hit = regionAt(p);
    if (hit !== null) {
      selectRegion(hit);
      setGesture({ kind: 'move', id: hit.id, startView: p, original: hit.rect, pointerId: event.pointerId });
      return;
    }
    setSelectedId(null);
    setGesture({ kind: 'draw', anchor: viewToSource(p, mapping), startView: p, current: p, pointerId: event.pointerId });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const p = viewPoint(event);
    const g = gestureRef.current;
    if (g === null) {
      // Hover feedback only.
      const handle = selected !== null ? handleAt(selected, p) : null;
      setHoverCursor(handle !== null ? HANDLE_CURSORS[handle] : regionAt(p) !== null ? 'move' : 'crosshair');
      return;
    }
    if (g.pointerId !== event.pointerId) return;
    if (g.kind === 'draw') {
      setGesture({ ...g, current: p });
      return;
    }
    const dx = (p.x - g.startView.x) * spv;
    const dy = (p.y - g.startView.y) * spv;
    const rect = g.kind === 'move' ? moveRect(g.original, dx, dy, bounds) : resizeRect(g.original, g.handle, dx, dy, 'free', bounds);
    updateRegion(g.id, { rect });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (g === null || g.pointerId !== event.pointerId) return;
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    setGesture(null);
    if (g.kind !== 'draw') return;
    const p = viewPoint(event);
    if (Math.hypot(p.x - g.startView.x, p.y - g.startView.y) < MIN_DRAG) return;
    const rect = rectFromPoints(g.anchor, viewToSource(p, mapping), 'free', bounds);
    const region: RedactRegion = { id: newShapeId('r'), rect, style, color, blockSize };
    if (regionsRef.current.length >= 200) return;
    setRegions([...regionsRef.current, region]);
    setSelectedId(region.id);
  };

  const onPointerCancel = () => {
    setGesture(null);
  };

  const onSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (selected === null) return;
    switch (event.key) {
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        removeRegion(selected.id);
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const step = (event.shiftKey ? 10 : 1) * Math.max(1, Math.round(spv));
        updateRegion(selected.id, { rect: nudgeRect(selected.rect, event.key, step, event.altKey, 'free', bounds) });
        break;
      }
      case 'Escape':
        event.preventDefault();
        setSelectedId(null);
        break;
      default:
        break;
    }
  };

  // ------------------------------------------------------- style controls
  const changeStyle = (next: RedactStyle) => {
    setStyle(next);
    if (selected !== null) updateRegion(selected.id, { style: next });
  };
  const changeColor = (next: string) => {
    setColor(next);
    if (selected !== null) updateRegion(selected.id, { color: next });
  };
  const changeBlockSize = (next: number) => {
    const value = clamp(Math.round(next), BLOCK_SIZE.min, BLOCK_SIZE.max);
    setBlockSize(value);
    if (selected !== null) updateRegion(selected.id, { blockSize: value });
  };

  const altKey = platform === 'darwin' ? 'Option' : 'Alt';

  /**
   * "Add region" (keyboard users): a region in the centre of the image, in the
   * current style, selected, with focus on the canvas — the arrow keys move it
   * and Alt/Option+arrows resize it.
   */
  const insertRegion = () => {
    if (regionsRef.current.length >= 200) return;
    const half = { x: display.width / 6, y: Math.max(6, display.height / 16) };
    const center = { x: display.width / 2, y: display.height / 2 };
    const rect = rectFromPoints(viewToSource({ x: center.x - half.x, y: center.y - half.y }, mapping), viewToSource({ x: center.x + half.x, y: center.y + half.y }, mapping), 'free', bounds);
    const region: RedactRegion = { id: newShapeId('r'), rect, style, color, blockSize };
    setRegions([...regionsRef.current, region]);
    setSelectedId(region.id);
    surfaceRef.current?.focus({ preventScroll: true });
    setAnnouncement(t('redact.added', { alt: altKey }));
  };

  const reset = () => {
    setRegions([]);
    setSelectedId(null);
  };

  const save = () => {
    const list = regionsRef.current;
    if (list.length === 0) return;
    void commit.commit({ regions: list, outputFormat });
  };

  const draft =
    gesture?.kind === 'draw' && Math.hypot(gesture.current.x - gesture.startView.x, gesture.current.y - gesture.startView.y) >= MIN_DRAG
      ? rectFromPoints(gesture.anchor, viewToSource(gesture.current, mapping), 'free', bounds)
      : null;
  const hasMosaic = regions.some((region) => region.style === 'mosaic');
  const styleLabel = (value: RedactStyle) => (value === 'solid' ? t('redact.style.solid') : t('redact.style.mosaic'));
  const viewStyle = (rect: Rect): CSSProperties => {
    const r = sourceRectToView(rect, mapping);
    return { left: r.x, top: r.y, width: Math.max(1, r.width), height: Math.max(1, r.height) };
  };

  return (
    <EditorFrame
      title={title}
      commit={commit}
      primaryLabel={t('redact.save')}
      onPrimary={save}
      primaryDisabled={regions.length === 0}
      onReset={reset}
      resetDisabled={regions.length === 0}
      footerNote={regions.length === 0 ? t('redact.empty') : undefined}
      confirmClose={regions.length > 0 ? { message: t('redact.unsaved') } : null}
    >
      <Stage display={display} pending={preview.pending && options !== null}>
        <img src={imageUrl} alt={options !== null ? t('editor.previewAlt') : t('editor.sourceAlt')} draggable={false} />
        <div className="redact-overlay" aria-hidden="true">
          {regions.map((region) => (
            <div
              key={region.id}
              className="redact-region"
              data-style={region.style}
              data-selected={region.id === selectedId}
              style={{ ...viewStyle(region.rect), ...(region.style === 'solid' ? { backgroundColor: withAlpha(region.color, 0.35) } : null) }}
            >
              {region.style === 'mosaic' ? <Grid3x3 className="redact-badge" size={12} /> : null}
              {region.id === selectedId ? HANDLES.map((handle) => <span key={handle} className="redact-handle" data-handle={handle} />) : null}
            </div>
          ))}
          {draft !== null ? <div className="redact-region redact-draft" style={viewStyle(draft)} /> : null}
        </div>
        <div
          ref={surfaceRef}
          className="redact-surface"
          role="application"
          aria-label={t('redact.canvasLabel')}
          aria-describedby={`${helpId} ${keysHelpId}`}
          tabIndex={0}
          style={{ cursor: gesture?.kind === 'move' ? 'grabbing' : hoverCursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={onSurfaceKeyDown}
        />
      </Stage>

      <PreviewError error={preview.error} />

      <div className="redact-list" role="group" aria-label={t('redact.regions')}>
        <button type="button" className="btn btn-small redact-add" aria-describedby={keysHelpId} onClick={insertRegion}>
          <Plus size={13} aria-hidden="true" />
          {t('redact.add')}
        </button>
        {regions.map((region, index) => (
            <button
              key={region.id}
              type="button"
              className="btn-tool btn-small redact-list-item"
              aria-pressed={region.id === selectedId}
              onClick={() => selectRegion(region.id === selectedId ? null : region)}
              onKeyDown={(event) => {
                if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault();
                  removeRegion(region.id);
                }
              }}
            >
              {t('redact.region', { n: index + 1 })}
              <span className="redact-list-style">{styleLabel(region.style)}</span>
            </button>
          ))}
        {regions.length > 0 ? (
          <button
            type="button"
            className="btn-icon"
            aria-label={t('redact.delete')}
            title={t('redact.delete')}
            disabled={selected === null}
            onClick={() => {
              if (selected !== null) removeRegion(selected.id);
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="redact-controls">
        <div className="field-row">
          <span className="field-label">{t('redact.style')}</span>
          <Segmented<RedactStyle> label={t('redact.style')} value={style} onChange={changeStyle} options={STYLES.map((value) => ({ value, label: styleLabel(value) }))} />
        </div>
        <div className="field-row">
          <span className="field-label">{t('redact.color')}</span>
          <SwatchGroup
            label={t('redact.color')}
            colors={REDACT_COLORS}
            value={color}
            onChange={changeColor}
            optionLabel={(c) => t('redact.colorOption', { color: c })}
            customLabel={t('redact.customColor')}
            disabled={style !== 'solid'}
          />
        </div>
        <SliderField
          label={t('redact.blockSize')}
          value={blockSize}
          min={BLOCK_SIZE.min}
          max={BLOCK_SIZE.max}
          unit={t('common.px')}
          onChange={changeBlockSize}
          disabled={style !== 'mosaic'}
        />
      </div>

      {hasMosaic ? <Notice tone="warning">{t('redact.mosaicNote')}</Notice> : null}
      <Notice tone="info" live="off">
        {t('redact.metadataNote')}
      </Notice>

      <div className="editor-meta">
        <span id={helpId}>{t('redact.help')}</span>
        <span id={keysHelpId} className="visually-hidden">
          {t('redact.keysHelp', { alt: altKey })}
        </span>
        <strong aria-live="polite">{t.plural('redact.count', regions.length)}</strong>
        <span className="visually-hidden" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>
      </div>
    </EditorFrame>
  );
}
