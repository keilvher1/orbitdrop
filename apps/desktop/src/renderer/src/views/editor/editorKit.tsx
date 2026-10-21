import { ACTIONS, FORMAT_INFO, type EditorContext, type OrbitErrorInfo, type PreviewResponse, type ToolOutputFormat } from '@orbitdrop/contracts';
import { toolResultName } from '@orbitdrop/core';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
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

/**
 * Box available for the image stage: full panel width, and a height that
 * leaves `reserved` px for the title bar, controls and footer so the editor
 * fits on small screens.
 */
export function usePreviewBox(reserved: number, maxHeight = 420, width = EDITOR_WIDTH): Size {
  const screenHeight = useScreenHeight();
  const innerWidth = width - 2 * EDITOR_PADDING - 2 * STAGE_PADDING;
  const height = Math.max(180, Math.min(maxHeight, screenHeight - reserved - 60));
  return { width: innerWidth, height };
}

/** Longest edge to request for a preview shown at `display` CSS px. */
export function previewEdgeFor(display: Size): number {
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return Math.round(Math.max(display.width, display.height) * Math.min(dpr, 2));
}

/** Result name shown before saving (the real name may get " (2)" if taken). */
export function outputFileName(ctx: EditorContext, format: ToolOutputFormat | 'png' | 'jpeg' = 'input'): string {
  const file = ctx.files[0];
  const name = file?.name ?? 'image';
  const action = ACTIONS[ctx.actionId];
  let ext = file?.ext ?? '';
  if (format !== 'input') ext = FORMAT_INFO[format].extension;
  else if (action.output !== 'input') ext = FORMAT_INFO[action.output].extension;
  return toolResultName(name, action.outputSuffix, ext);
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

export interface StageProps {
  readonly display: Size;
  readonly children: ReactNode;
  readonly checker?: boolean;
  readonly pending?: boolean;
  readonly label?: string;
  readonly style?: CSSProperties;
}

/** Dark-ish stage that centres the image (or canvas) at `display` CSS px. */
export function Stage({ display, children, checker = false, pending = false, style }: StageProps) {
  const { t } = useEnv();
  return (
    <div className="stage" style={style}>
      <div className={`stage-canvas${checker ? ' checker' : ''}`} style={{ width: display.width, height: display.height }}>
        {children}
      </div>
      {pending ? (
        <div className="stage-busy" role="status">
          <Spinner size={11} />
          <span>{t('editor.previewLoading')}</span>
        </div>
      ) : null}
    </div>
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
