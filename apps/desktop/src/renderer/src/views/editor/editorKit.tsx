import { ACTIONS, FORMAT_INFO, type EditorContext, type FileFormat, type OrbitErrorInfo, type PreviewResponse, type ToolOutputFormat } from '@orbitdrop/contracts';
import { toolResultName } from '@orbitdrop/core';
import { createContext, useContext, useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useEnv } from '../../app/env';
import { Notice, Spinner } from '../../components/Notice';
import type { Size } from './crop/cropMath';

/** Content width of an editor panel (DESIGN_TOKENS.editor.defaultWidth minus padding). */
export const EDITOR_WIDTH = 520;
export const EDITOR_PADDING = 16;
export const STAGE_PADDING = 12;

export function useScreenHeight(): number {
  const [height, setHeight] = useState(() => (typeof window !== 'undefined' && window.screen?.availHeight > 0 ? window.screen.availHeight : 900));
  useEffect(() => {
    const onResize = () => {
      if (window.screen?.availHeight > 0) setHeight(window.screen.availHeight);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return height;
}

/** Smallest image stage, so a short screen still shows a usable preview (the panel scrolls below it). */
export const MIN_STAGE_HEIGHT = 180;
/** Gap main keeps between a window and the edge of the work area (main/windows/placement.ts WINDOW_MARGIN). */
const WINDOW_MARGIN = 8;

/**
 * Largest height the `.stage` element may take so the whole panel fits the work area:
 * the work area minus everything else in the panel (`rest`, measured by EditorFrame). It does
 * not depend on the stage's own height, so applying it cannot oscillate.
 */
export function stageBudget(workAreaHeight: number, panelHeight: number, stageHeight: number): number {
  const rest = panelHeight - stageHeight;
  return Math.floor(workAreaHeight - 2 * WINDOW_MARGIN - rest);
}

/** Measured stage budget (null until measured, or when the editor has no stage). */
export const StageBudgetContext = createContext<number | null>(null);

/**
 * Wraps an editor (EditorView): measures the editor panel (`.editor-view`) and its image stage
 * (`.stage`) after every layout change and provides the stage budget. It sits above the editor
 * component because editors call usePreviewBox in their own body, outside EditorFrame.
 */
export function StageBudgetProvider({ children }: { readonly children: ReactNode }) {
  const [budget, setBudget] = useState<number | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const panel = document.querySelector<HTMLElement>('.editor-view');
      const stage = panel?.querySelector<HTMLElement>('.stage');
      const workArea = window.screen?.availHeight > 0 ? window.screen.availHeight : 0;
      const panelHeight = panel?.getBoundingClientRect().height ?? 0;
      if (!panel || !stage || panelHeight === 0 || workArea === 0) {
        setBudget(null);
        return;
      }
      const next = stageBudget(workArea, panelHeight, stage.getBoundingClientRect().height);
      // Sub-pixel layout differences must not cause a re-render loop.
      setBudget((previous) => (previous !== null && Math.abs(previous - next) < 2 ? previous : next));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', schedule);
    // The body grows and shrinks with the panel (controls that appear, a stage that shrinks).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(document.body);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);
  return <StageBudgetContext.Provider value={budget}>{children}</StageBudgetContext.Provider>;
}

/**
 * Box available for the image stage: full panel width, and a height that
 * leaves `reserved` px for the title bar, controls and footer so the editor
 * fits on small screens. Once EditorFrame has measured the panel, the measured
 * budget wins over the `reserved` estimate (controls that grow, such as a
 * chosen background image, would otherwise push the buttons off screen).
 */
export function usePreviewBox(reserved: number, maxHeight = 420, width = EDITOR_WIDTH): Size {
  const screenHeight = useScreenHeight();
  const budget = useContext(StageBudgetContext);
  const innerWidth = width - 2 * EDITOR_PADDING - 2 * STAGE_PADDING;
  let height = Math.min(maxHeight, screenHeight - reserved - 60);
  if (budget !== null) height = Math.min(height, budget - 2 * STAGE_PADDING);
  return { width: innerWidth, height: Math.max(MIN_STAGE_HEIGHT, height) };
}

/** Longest edge to request for a preview shown at `display` CSS px. */
export function previewEdgeFor(display: Size): number {
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return Math.round(Math.max(display.width, display.height) * Math.min(dpr, 2));
}

/**
 * Result name shown before saving (the real name may get " (2)" if taken).
 * `resolved` is the format the processor reported for 'input'
 * (PreviewResponse.outputFormat), e.g. PNG for a GIF.
 */
export function outputFileName(ctx: EditorContext, format: ToolOutputFormat | 'png' | 'jpeg' = 'input', resolved?: FileFormat): string {
  const file = ctx.files[0];
  const name = file?.name ?? 'image';
  const action = ACTIONS[ctx.actionId];
  let ext = file?.ext ?? '';
  if (format !== 'input') ext = FORMAT_INFO[format].extension;
  else if (action.output !== 'input') ext = FORMAT_INFO[action.output].extension;
  else if (resolved !== undefined && resolved !== file?.format) ext = FORMAT_INFO[resolved].extension;
  return toolResultName(name, action.outputSuffix, ext);
}

export interface FormatChange {
  readonly from: FileFormat;
  readonly to: FileFormat;
}

/**
 * "With “original format”, a GIF file is saved as PNG": one line per input
 * format whose output format (as reported by the processor) differs.
 */
export function FormatResolvedNote({ changes, className }: { readonly changes: readonly FormatChange[]; readonly className: string }) {
  const { t } = useEnv();
  const seen = new Set<string>();
  const distinct = changes.filter(({ from, to }) => {
    const key = `${from}>${to}`;
    if (from === to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (distinct.length === 0) return null;
  return (
    <>
      {distinct.map(({ from, to }) => (
        <p key={`${from}>${to}`} className={`${className} muted`}>
          {t('editor.format.resolved', { from: FORMAT_INFO[from].label, to: FORMAT_INFO[to].label })}
        </p>
      ))}
    </>
  );
}

/** Keeps showing the previous image until the next one has decoded (no flash between previews). */
export function useDecodedUrl(url: string | null): string | null {
  const [shown, setShown] = useState<string | null>(url);
  useEffect(() => {
    if (url === null || url === shown) return undefined;
    let cancelled = false;
    const img = new Image();
    if (typeof img.decode !== 'function') {
      setShown(url);
      return undefined;
    }
    img.src = url;
    const done = () => {
      if (!cancelled) setShown(url);
    };
    img.decode().then(done, done);
    return () => {
      cancelled = true;
    };
  }, [url, shown]);
  return shown ?? url;
}

/**
 * Like useDecodedUrl but for a whole PreviewResponse, so the image and its
 * dimensions (and layout/estimate) switch together once the new image decoded.
 */
export function useDecodedPreview(preview: PreviewResponse | null): PreviewResponse | null {
  const [shown, setShown] = useState<PreviewResponse | null>(preview);
  useEffect(() => {
    if (preview === null) {
      setShown(null);
      return undefined;
    }
    if (preview.url === shown?.url) {
      if (preview !== shown) setShown(preview);
      return undefined;
    }
    let cancelled = false;
    const img = new Image();
    if (typeof img.decode !== 'function') {
      setShown(preview);
      return undefined;
    }
    img.src = preview.url;
    const done = () => {
      if (!cancelled) setShown(preview);
    };
    img.decode().then(done, done);
    return () => {
      cancelled = true;
    };
  }, [preview, shown]);
  return shown;
}

/** A preview render must take this long before "Rendering preview…" is shown and announced (quick ones pass silently). */
export const BUSY_DELAY_MS = 500;
/** The busy status keeps its text until rendering has been idle this long: one burst of slider steps, one announcement. */
export const BUSY_HOLD_MS = 1000;
/** Live values (estimates) are announced only after they stayed unchanged this long — never on every slider step. */
export const SETTLE_MS = 700;

/** True once `active` has stayed true for `delayMs`; false again as soon as `active` is. */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) {
      setLate(false);
      return undefined;
    }
    const timer = setTimeout(() => setLate(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && late;
}

/** True while `active`, and for `holdMs` after it last was. */
export function useHeldFlag(active: boolean, holdMs: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (active) {
      setHeld(true);
      return undefined;
    }
    const timer = setTimeout(() => setHeld(false), holdMs);
    return () => clearTimeout(timer);
  }, [active, holdMs]);
  return active || held;
}

/**
 * Text for a persistent polite live region: `text` once it has stayed the same
 * for `delayMs`. `null` (still changing, or nothing to say) empties the region
 * at once, so the next settled value is spoken even when it repeats the last.
 */
export function useSettledAnnouncement(text: string | null, delayMs = SETTLE_MS): string {
  const [spoken, setSpoken] = useState('');
  useEffect(() => {
    if (text === null) {
      setSpoken('');
      return undefined;
    }
    const timer = setTimeout(() => setSpoken(text), delayMs);
    return () => clearTimeout(timer);
  }, [text, delayMs]);
  return spoken;
}

export interface StageProps {
  readonly display: Size;
  readonly children: ReactNode;
  readonly checker?: boolean;
  readonly pending?: boolean;
  readonly label?: string;
  readonly style?: CSSProperties;
}

/**
 * Dark-ish stage that centres the image (or canvas) at `display` CSS px.
 * While `pending` the stage is aria-busy; "Rendering preview…" appears only
 * when a render takes longer than BUSY_DELAY_MS, and is announced through one
 * status element that exists from mount — outside the busy stage, which may
 * hold back announcements — rather than a new status per preview. The status
 * is emptied once rendering has been idle for BUSY_HOLD_MS, so previews that
 * follow each other closely (slider steps) do not repeat it.
 */
export function Stage({ display, children, checker = false, pending = false, style }: StageProps) {
  const { t } = useEnv();
  const slow = useDelayedFlag(pending, BUSY_DELAY_MS);
  const announced = useHeldFlag(slow, BUSY_HOLD_MS);
  return (
    <>
      <div className="stage" style={style} aria-busy={pending || undefined}>
        <div className={`stage-canvas${checker ? ' checker' : ''}`} style={{ width: display.width, height: display.height }}>
          {children}
        </div>
        {slow ? (
          <div className="stage-busy" aria-hidden="true">
            <Spinner size={11} />
            <span>{t('editor.previewLoading')}</span>
          </div>
        ) : null}
      </div>
      <span className="visually-hidden" role="status">
        {announced ? t('editor.previewLoading') : ''}
      </span>
    </>
  );
}

export function PreviewError({ error }: { readonly error: OrbitErrorInfo | null }) {
  const { t } = useEnv();
  if (error === null) return null;
  return (
    <Notice tone="warning">
      {t('editor.previewFailed')} <span className="muted">{t.error(error)}</span>
    </Notice>
  );
}

export function MultiFileNote({ ctx }: { readonly ctx: EditorContext }) {
  const { t } = useEnv();
  if (ctx.files.length <= 1) return null;
  return <Notice tone="info" live="off">{t.plural('editor.applyToAll', ctx.files.length)}</Notice>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a field from `ctx.defaults` if it has the expected type. */
export function pick<T>(defaults: unknown, key: string, guard: (v: unknown) => v is T, fallback: T): T {
  if (!isRecord(defaults)) return fallback;
  const value = defaults[key];
  return guard(value) ? value : fallback;
}

export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
export const isString = (v: unknown): v is string => typeof v === 'string';
export function isOneOf<T extends string>(values: readonly T[]) {
  return (v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);
}
