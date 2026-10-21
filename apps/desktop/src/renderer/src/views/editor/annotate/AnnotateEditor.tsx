import type { AnnotationShape, EditorContext } from '@orbitdrop/contracts';
import { ANNOTATION_LINE_HEIGHT, annotationBounds, annotationFontFamilyCss, drawAnnotations } from '@orbitdrop/core';
import { MousePointer2, MoveUpRight, Redo2, Square, Trash2, Type, Undo2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { useEnv } from '../../../app/env';
import { Segmented } from '../../../components/Segmented';
import { SliderField } from '../../../components/SliderField';
import { editorMapping, sourcePerView, sourceToView, viewToSource, type Point } from '../crop/cropMath';
import { EditorFrame, useEditorCommit } from '../EditorFrame';
import { Stage, isOneOf, pick, usePreviewBox } from '../editorKit';
import {
  addShape,
  arrowFromDrag,
  canRedo,
  canUndo,
  commitHistory,
  createHistory,
  fontSizeToSource,
  hitTestShapes,
  moveShape,
  normalizeText,
  rectFromDrag,
  redo,
  removeShape,
  replacePresent,
  sourceToUi,
  strokeToSource,
  textShapeAt,
  undo,
  updateShape,
  withStyle,
  type AnnotationTool,
  type History,
  type ShapeStyle,
  type TextMeasurer,
} from './annotateModel';
import { SwatchGroup } from './SwatchGroup';
import './annotate.css';

/** Height kept free for the title bar, toolbar, style rows, help line and footer. */
const RESERVED = 372;
export const ANNOTATE_PALETTE: readonly string[] = ['#F2552C', '#E53935', '#FDD835', '#43A047', '#1E88E5', '#111111', '#FFFFFF'];
/** On-screen (view) px ranges of the style sliders. */
export const STROKE_UI = { min: 1, max: 24, initial: 4 } as const;
export const FONT_UI = { min: 8, max: 72, initial: 24 } as const;
/** A pointer that moved less than this (view px) is a click, not a drag. */
const MIN_DRAG = 3;
/** Hit tolerance around shapes, in view px. */
const HIT_TOLERANCE = 6;
/** Consecutive edits of the same property within this window form one undo step. */
const COALESCE_MS = 900;
const TOOL_FORMATS = ['input', 'png', 'jpeg', 'webp'] as const;

type Gesture =
  | { readonly kind: 'draw'; readonly tool: 'rect' | 'arrow'; readonly start: Point; readonly current: Point; readonly pointerId: number }
  | { readonly kind: 'move'; readonly id: string; readonly start: Point; readonly current: Point; readonly original: AnnotationShape; readonly pointerId: number };

interface TextEdit {
  /** Shape being edited; null for a new text. */
  readonly id: string | null;
  /** Top-left of the text in view px. */
  readonly at: Point;
  readonly color: string;
  readonly fontUi: number;
  readonly initial: string;
  readonly session: number;
}

type ShapeList = readonly AnnotationShape[];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function focusRingColor(): string {
  if (typeof document === 'undefined') return '#1E5FD6';
  const value = getComputedStyle(document.documentElement).getPropertyValue('--c-focus-ring').trim();
  return value || '#1E5FD6';
}

/** Dashed outline around everything the selected shape paints (editor overlay only, never saved). */
function drawSelection(g: CanvasRenderingContext2D, shape: AnnotationShape, scale: number, fontFamily: string, dpr: number): void {
  const b = annotationBounds([shape], { scale, fontFamily }, g);
  if (b === null) return;
  const pad = 2 * dpr;
  g.save();
  g.setLineDash([]);
  g.lineWidth = 3 * dpr;
  g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  g.strokeRect(b.x - pad, b.y - pad, b.width + 2 * pad, b.height + 2 * pad);
  g.lineWidth = 1.5 * dpr;
  g.strokeStyle = focusRingColor();
  g.setLineDash([5 * dpr, 4 * dpr]);
  g.strokeRect(b.x - pad, b.y - pad, b.width + 2 * pad, b.height + 2 * pad);
  g.restore();
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true;
  if (target instanceof HTMLInputElement) return ['text', 'search', 'number', 'email', 'url', 'tel', 'password'].includes(target.type);
  return false;
}

/**
 * Annotate editor (tool.annotate): text, arrows and rectangles drawn over the
 * source preview. The canvas is painted with core `drawAnnotations` — the same
 * routine the processor uses for the saved file — so the preview matches the
 * result. Nothing is written until "Save Annotations".
 */
export function AnnotateEditor({ ctx, title }: { readonly ctx: EditorContext; readonly title: string }) {
  const { orbit, t, platform } = useEnv();
  const commit = useEditorCommit(ctx.editorId);
  const helpId = useId();
  const orientedWidth = Math.max(1, ctx.image.orientedWidth);
  const orientedHeight = Math.max(1, ctx.image.orientedHeight);
  const box = usePreviewBox(RESERVED, 400);
  const mapping = useMemo(
    () => editorMapping({ width: orientedWidth, height: orientedHeight }, box),
    [orientedWidth, orientedHeight, box.width, box.height],
  );
  const display = mapping.view;
  const spv = sourcePerView(mapping);
  const outputFormat = pick(ctx.defaults, 'outputFormat', isOneOf(TOOL_FORMATS), 'input');

  // Hangul-capable font list; the processor's own pick goes first when known.
  const [fontFamily, setFontFamily] = useState(() => annotationFontFamilyCss());
  useEffect(() => {
    let cancelled = false;
    orbit.getCapabilities().then(
      (caps) => {
        if (!cancelled) setFontFamily(annotationFontFamilyCss(caps.probe.koreanFont));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [orbit]);

  // ---------------------------------------------------------------- history
  const historyRef = useRef<History<ShapeList>>(createHistory<ShapeList>([]));
  const [history, setHistory] = useState<History<ShapeList>>(historyRef.current);
  const coalesceRef = useRef<{ readonly key: string; readonly at: number } | null>(null);
  const shapes = history.present;

  /** Apply a change to the shapes as one undo step (or merged into the previous one with the same key). */
  const update = useCallback((change: (list: ShapeList) => ShapeList, coalesceKey?: string): History<ShapeList> => {
    const current = historyRef.current;
    const nextShapes = change(current.present);
    if (nextShapes === current.present) return current;
    const now = Date.now();
    const last = coalesceRef.current;
    const merge = coalesceKey !== undefined && last !== null && last.key === coalesceKey && now - last.at < COALESCE_MS;
    const next = merge ? replacePresent(current, nextShapes) : commitHistory(current, nextShapes);
    coalesceRef.current = coalesceKey === undefined ? null : { key: coalesceKey, at: now };
    historyRef.current = next;
    setHistory(next);
    return next;
  }, []);

  const travel = useCallback((step: (h: History<ShapeList>) => History<ShapeList>) => {
    coalesceRef.current = null;
    const next = step(historyRef.current);
    if (next === historyRef.current) return;
    historyRef.current = next;
    setHistory(next);
  }, []);

  // ------------------------------------------------------------ tool & style
  const [tool, setTool] = useState<AnnotationTool>('arrow');
  const [color, setColor] = useState<string>(ANNOTATE_PALETTE[0] ?? '#F2552C');
  const [strokeUi, setStrokeUi] = useState<number>(STROKE_UI.initial);
  const [fontUi, setFontUi] = useState<number>(FONT_UI.initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = shapes.find((shape) => shape.id === selectedId) ?? null;

  const currentStyle = useMemo<ShapeStyle>(
    () => ({ color, strokeWidth: strokeToSource(strokeUi, mapping), fontSize: fontSizeToSource(fontUi, mapping) }),
    [color, strokeUi, fontUi, mapping],
  );

  /** Select a shape and show its style in the controls (new shapes then use it too). */
  const select = useCallback(
    (shape: AnnotationShape | null) => {
      setSelectedId(shape?.id ?? null);
      if (shape === null) return;
      setColor(shape.color);
      if (shape.type === 'text') setFontUi(Math.max(1, Math.round(sourceToUi(shape.fontSize, mapping))));
      else setStrokeUi(Math.max(1, Math.round(sourceToUi(shape.strokeWidth, mapping))));
    },
    [mapping],
  );

  // --------------------------------------------------------------- canvas
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const measurer = useCallback((): TextMeasurer | undefined => canvasRef.current?.getContext('2d') ?? undefined, []);

  // ----------------------------------------------------------- text entry
  const [textEdit, setTextEditState] = useState<TextEdit | null>(null);
  const textEditRef = useRef<TextEdit | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const sessionRef = useRef(0);
  const [draftHasText, setDraftHasText] = useState(false);

  const openText = useCallback((edit: Omit<TextEdit, 'session'>) => {
    sessionRef.current += 1;
    composingRef.current = false;
    const next = { ...edit, session: sessionRef.current };
    textEditRef.current = next;
    setTextEditState(next);
    setDraftHasText(edit.initial.trim().length > 0);
  }, []);

  /** Close the text box; when `save`, add/update/remove the text shape. Returns the resulting shapes. */
  const finishText = useCallback(
    (save: boolean): ShapeList => {
      const edit = textEditRef.current;
      if (edit === null) return historyRef.current.present;
      const value = textareaRef.current?.value ?? edit.initial;
      textEditRef.current = null;
      composingRef.current = false;
      setTextEditState(null);
      setDraftHasText(false);
      if (!save) return historyRef.current.present;
      const text = normalizeText(value);
      if (edit.id === null) {
        const shape = textShapeAt(edit.at, text, mapping, { color: edit.color, strokeWidth: 1, fontSize: fontSizeToSource(edit.fontUi, mapping) });
        if (shape === null) return historyRef.current.present;
        const next = update((list) => addShape(list, shape));
        setSelectedId(shape.id);
        return next.present;
      }
      const id = edit.id;
      if (text === '') {
        setSelectedId(null);
        return update((list) => removeShape(list, id)).present;
      }
      return update((list) => updateShape(list, id, (shape) => (shape.type === 'text' && shape.text !== text ? { ...shape, text } : shape))).present;
    },
    [mapping, update],
  );

  const startEditText = useCallback(
    (shape: Extract<AnnotationShape, { type: 'text' }>) => {
      select(shape);
      openText({
        id: shape.id,
        at: sourceToView({ x: shape.x, y: shape.y }, mapping),
        color: shape.color,
        fontUi: sourceToUi(shape.fontSize, mapping),
        initial: shape.text,
      });
    },
    [mapping, openText, select],
  );

  useEffect(() => {
    if (textEdit === null) return;
    const el = textareaRef.current;
    if (el === null) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [textEdit]);

  // -------------------------------------------------------------- gestures
  const gestureRef = useRef<Gesture | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const setGesture = (next: Gesture | null) => {
    gestureRef.current = next;
    setGestureState(next);
  };

  /** Shapes as currently visible: the moved shape at its dragged position, the shape being drawn, minus the text being edited. */
  const liveShapes = useMemo<ShapeList>(() => {
    let list: ShapeList = shapes;
    if (gesture?.kind === 'move') {
      const moved = moveShape(gesture.original, (gesture.current.x - gesture.start.x) * spv, (gesture.current.y - gesture.start.y) * spv);
      list = updateShape(list, gesture.id, () => moved);
    } else if (gesture?.kind === 'draw' && Math.hypot(gesture.current.x - gesture.start.x, gesture.current.y - gesture.start.y) >= MIN_DRAG) {
      const draft =
        gesture.tool === 'rect'
          ? rectFromDrag(gesture.start, gesture.current, mapping, currentStyle, 'draft')
          : arrowFromDrag(gesture.start, gesture.current, mapping, currentStyle, 'draft');
      if (draft !== null) list = [...list, draft];
    }
    if (textEdit?.id) {
      const hidden = textEdit.id;
      list = list.filter((shape) => shape.id !== hidden);
    }
    return list;
  }, [shapes, gesture, textEdit, spv, mapping, currentStyle]);

  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? Math.min(window.devicePixelRatio, 3) : 1;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const width = Math.max(1, Math.round(display.width * dpr));
    const height = Math.max(1, Math.round(display.height * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const g = canvas.getContext('2d');
    if (g === null) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, width, height);
    const scale = width / orientedWidth;
    try {
      drawAnnotations(g, liveShapes, { scale, fontFamily });
      const shown = liveShapes.find((shape) => shape.id === selectedId);
      if (shown !== undefined && gesture?.kind !== 'draw') drawSelection(g, shown, scale, fontFamily, dpr);
    } catch (error) {
      console.error('[annotate] drawing failed', error instanceof Error ? error.message : String(error));
    }
  }, [liveShapes, selectedId, gesture, display.width, display.height, dpr, orientedWidth, fontFamily]);

  const viewPoint = (event: ReactPointerEvent<HTMLElement> | ReactMouseEvent<HTMLElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    const kx = rect.width > 0 ? display.width / rect.width : 1;
    const ky = rect.height > 0 ? display.height / rect.height : 1;
    return {
      x: clamp((event.clientX - rect.left) * kx, 0, display.width),
      y: clamp((event.clientY - rect.top) * ky, 0, display.height),
    };
  };
  const tolerance = HIT_TOLERANCE * spv;
  const hitAt = (p: Point) => hitTestShapes(historyRef.current.present, viewToSource(p, mapping), tolerance, fontFamily, measurer());

  // Text boxes open on pointerup: by then the browser has finished moving focus
  // for the press, so the new text box keeps it.
  const textPressRef = useRef<{ readonly pointerId: number; readonly at: Point } | null>(null);
  const swallowPressRef = useRef<number | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (textEditRef.current !== null) {
      // The first press outside the text box only confirms the text.
      finishText(true);
      swallowPressRef.current = event.pointerId;
      return;
    }
    const p = viewPoint(event);
    if (tool === 'text') {
      textPressRef.current = { pointerId: event.pointerId, at: p };
      return;
    }
    surfaceRef.current?.focus({ preventScroll: true });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best effort (unsupported in some test environments).
    }
    if (tool === 'select') {
      const hit = hitAt(p);
      select(hit);
      if (hit !== null) setGesture({ kind: 'move', id: hit.id, start: p, current: p, original: hit, pointerId: event.pointerId });
      return;
    }
    setGesture({ kind: 'draw', tool, start: p, current: p, pointerId: event.pointerId });
  };

  const [hoverShape, setHoverShape] = useState(false);
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (g === null) {
      // Hover feedback for the select tool: a move cursor over shapes.
      if (tool === 'select' && event.pointerType !== 'touch') setHoverShape(hitAt(viewPoint(event)) !== null);
      return;
    }
    if (g.pointerId !== event.pointerId) return;
    setGesture({ ...g, current: viewPoint(event) });
  };

  const releasePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (swallowPressRef.current === event.pointerId) {
      swallowPressRef.current = null;
      return;
    }
    const press = textPressRef.current;
    if (press !== null && press.pointerId === event.pointerId) {
      textPressRef.current = null;
      if (tool !== 'text' || textEditRef.current !== null) return;
      const hit = hitAt(press.at);
      if (hit?.type === 'text') startEditText(hit);
      else {
        setSelectedId(null);
        openText({ id: null, at: press.at, color, fontUi, initial: '' });
      }
      return;
    }
    const g = gestureRef.current;
    if (g === null || g.pointerId !== event.pointerId) return;
    const p = viewPoint(event);
    releasePointer(event);
    setGesture(null);
    if (g.kind === 'move') {
      const moved = moveShape(g.original, (p.x - g.start.x) * spv, (p.y - g.start.y) * spv);
      if (moved !== g.original) update((list) => updateShape(list, g.id, () => moved));
      return;
    }
    if (Math.hypot(p.x - g.start.x, p.y - g.start.y) < MIN_DRAG) {
      // A click with a drawing tool picks the shape under the pointer.
      select(hitAt(p));
      return;
    }
    const shape = g.tool === 'rect' ? rectFromDrag(g.start, p, mapping, currentStyle) : arrowFromDrag(g.start, p, mapping, currentStyle);
    if (shape === null) return;
    update((list) => addShape(list, shape));
    setSelectedId(shape.id);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    releasePointer(event);
    textPressRef.current = null;
    swallowPressRef.current = null;
    setGesture(null);
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (textEditRef.current !== null) return;
    const hit = hitAt(viewPoint(event));
    if (hit?.type === 'text') startEditText(hit);
  };

  const deleteSelected = useCallback(() => {
    const id = selectedId;
    if (id === null) return;
    update((list) => removeShape(list, id));
    setSelectedId(null);
  }, [selectedId, update]);

  const onSurfaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (textEditRef.current !== null || selected === null) return;
    const step = (event.shiftKey ? 10 : 1) * Math.max(1, Math.round(spv));
    const nudge = (dx: number, dy: number) => {
      event.preventDefault();
      update((list) => updateShape(list, selected.id, (shape) => moveShape(shape, dx, dy)), `nudge:${selected.id}`);
    };
    switch (event.key) {
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        deleteSelected();
        break;
      case 'ArrowLeft':
        nudge(-step, 0);
        break;
      case 'ArrowRight':
        nudge(step, 0);
        break;
      case 'ArrowUp':
        nudge(0, -step);
        break;
      case 'ArrowDown':
        nudge(0, step);
        break;
      case 'Enter':
        if (selected.type === 'text') {
          event.preventDefault();
          startEditText(selected);
        }
        break;
      case 'Escape':
        event.preventDefault();
        setSelectedId(null);
        break;
      default:
        break;
    }
  };

  // Undo / redo shortcuts: ⌘Z / ⇧⌘Z on macOS, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z elsewhere.
  // Text fields keep their own undo.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || isTextEntry(event.target)) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const isZ = key === 'z' || event.code === 'KeyZ';
      const isY = key === 'y' || event.code === 'KeyY';
      if (isZ && !event.shiftKey) {
        event.preventDefault();
        travel(undo);
      } else if ((isZ && event.shiftKey) || (isY && event.ctrlKey && !event.metaKey)) {
        event.preventDefault();
        travel(redo);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [travel]);

  // ------------------------------------------------------- style controls
  const changeColor = (value: string) => {
    setColor(value);
    if (selected !== null) update((list) => updateShape(list, selected.id, (shape) => withStyle(shape, { color: value })), `color:${selected.id}`);
  };
  const changeStroke = (ui: number) => {
    setStrokeUi(ui);
    if (selected !== null && selected.type !== 'text') {
      update((list) => updateShape(list, selected.id, (shape) => withStyle(shape, { strokeWidth: strokeToSource(ui, mapping) })), `stroke:${selected.id}`);
    }
  };
  const changeFont = (ui: number) => {
    setFontUi(ui);
    if (selected !== null && selected.type === 'text') {
      update((list) => updateShape(list, selected.id, (shape) => withStyle(shape, { fontSize: fontSizeToSource(ui, mapping) })), `font:${selected.id}`);
    }
  };

  const reset = () => {
    finishText(false);
    setSelectedId(null);
    update((list) => (list.length === 0 ? list : []));
  };

  const save = () => {
    const finalShapes = textEditRef.current !== null ? finishText(true) : historyRef.current.present;
    if (finalShapes.length === 0) return;
    void commit.commit({ shapes: finalShapes, outputFormat });
  };

  const mac = platform === 'darwin';
  const toolLabel = (icon: ReactElement, text: string) => (
    <span className="annot-tool-label">
      {icon}
      {text}
    </span>
  );
  const editingFont = textEdit?.fontUi ?? fontUi;

  return (
    <EditorFrame
      title={title}
      commit={commit}
      primaryLabel={t('annotate.save')}
      onPrimary={save}
      primaryDisabled={shapes.length === 0 && !draftHasText}
      onReset={reset}
      resetDisabled={shapes.length === 0 && textEdit === null}
      footerNote={shapes.length === 0 ? t('annotate.empty') : undefined}
      escapeEnabled={textEdit === null}
    >
      <div className="annot-toolbar">
        <Segmented<AnnotationTool>
          label={t('annotate.tools')}
          size="large"
          value={tool}
          onChange={(next) => {
            finishText(true);
            setTool(next);
          }}
          options={[
            { value: 'select', label: toolLabel(<MousePointer2 size={14} aria-hidden="true" />, t('annotate.tool.select')) },
            { value: 'text', label: toolLabel(<Type size={14} aria-hidden="true" />, t('annotate.tool.text')) },
            { value: 'arrow', label: toolLabel(<MoveUpRight size={14} aria-hidden="true" />, t('annotate.tool.arrow')) },
            { value: 'rect', label: toolLabel(<Square size={14} aria-hidden="true" />, t('annotate.tool.rect')) },
          ]}
        />
        <div className="annot-toolbar-spacer" />
        <button
          type="button"
          className="btn-icon"
          aria-label={t('annotate.undo')}
          title={`${t('annotate.undo')} (${mac ? '⌘Z' : 'Ctrl+Z'})`}
          aria-keyshortcuts={mac ? 'Meta+Z' : 'Control+Z'}
          disabled={!canUndo(history)}
          onClick={() => travel(undo)}
        >
          <Undo2 size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="btn-icon"
          aria-label={t('annotate.redo')}
          title={`${t('annotate.redo')} (${mac ? '⇧⌘Z' : 'Ctrl+Y'})`}
          aria-keyshortcuts={mac ? 'Shift+Meta+Z' : 'Control+Y'}
          disabled={!canRedo(history)}
          onClick={() => travel(redo)}
        >
          <Redo2 size={16} aria-hidden="true" />
        </button>
        <button type="button" className="btn-icon" aria-label={t('annotate.delete')} title={t('annotate.delete')} disabled={selected === null} onClick={deleteSelected}>
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>

      <Stage display={display}>
        <img src={ctx.source.url} alt={t('editor.sourceAlt')} draggable={false} />
        <canvas ref={canvasRef} className="annot-canvas" aria-hidden="true" />
        <div
          ref={surfaceRef}
          className="annot-surface"
          role="application"
          aria-label={t('annotate.canvasLabel')}
          aria-describedby={helpId}
          tabIndex={0}
          data-tool={tool}
          data-hover={tool === 'select' && (hoverShape || gesture?.kind === 'move')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onDoubleClick={onDoubleClick}
          onKeyDown={onSurfaceKeyDown}
        />
        {textEdit !== null ? (
          <textarea
            key={textEdit.session}
            ref={textareaRef}
            className="annot-text-input"
            aria-label={t('annotate.textLabel')}
            placeholder={t('annotate.textPlaceholder')}
            defaultValue={textEdit.initial}
            maxLength={2000}
            rows={1}
            spellCheck={false}
            style={{
              left: textEdit.at.x,
              // CSS centres glyphs in the line box; canvas text is top-anchored.
              top: textEdit.at.y - ((ANNOTATION_LINE_HEIGHT - 1) / 2) * editingFont,
              fontSize: editingFont,
              lineHeight: ANNOTATION_LINE_HEIGHT,
              color: textEdit.color,
              caretColor: textEdit.color,
              fontFamily,
              maxWidth: Math.max(40, display.width - textEdit.at.x),
            }}
            onInput={(event) => setDraftHasText(event.currentTarget.value.trim().length > 0)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              // While a Korean (or any IME) composition is open, Enter/Escape belong to the IME.
              const composing = composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229;
              if (event.key === 'Enter' && !event.shiftKey) {
                if (composing) return;
                event.preventDefault();
                finishText(true);
                surfaceRef.current?.focus({ preventScroll: true });
              } else if (event.key === 'Escape') {
                if (composing) return;
                event.preventDefault();
                finishText(false);
                surfaceRef.current?.focus({ preventScroll: true });
              }
            }}
            onBlur={() => {
              finishText(true);
            }}
          />
        ) : null}
      </Stage>

      <div className="annot-styles">
        <div className="annot-swatch-row">
          <span className="field-label">{t('annotate.color')}</span>
          <SwatchGroup
            label={t('annotate.color')}
            colors={ANNOTATE_PALETTE}
            value={color}
            onChange={changeColor}
            optionLabel={(c) => t('annotate.colorOption', { color: c })}
            customLabel={t('annotate.customColor')}
          />
        </div>
        <SliderField label={t('annotate.stroke')} value={strokeUi} min={STROKE_UI.min} max={STROKE_UI.max} onChange={changeStroke} />
        <SliderField label={t('annotate.fontSize')} value={fontUi} min={FONT_UI.min} max={FONT_UI.max} onChange={changeFont} />
      </div>

      <div className="editor-meta">
        <span id={helpId}>{t('annotate.help')}</span>
        <strong aria-live="polite">{t.plural('annotate.count', shapes.length)}</strong>
      </div>
    </EditorFrame>
  );
}
