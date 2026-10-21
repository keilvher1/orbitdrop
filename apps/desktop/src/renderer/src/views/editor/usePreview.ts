import { type OrbitErrorInfo, type PreviewResponse } from '@orbitdrop/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOrbit } from '../../app/env';
import { asErrorInfo } from '../../app/errors';
import { PreviewSequencer } from './previewSequencer';

export const PREVIEW_DEBOUNCE_MS = 60;

export interface PreviewState {
  /** Last successfully rendered preview (kept while newer ones are pending or fail). */
  readonly preview: PreviewResponse | null;
  /** A request newer than the shown preview is in flight. */
  readonly pending: boolean;
  /** Error of the newest answered request, cleared by the next good preview. */
  readonly error: OrbitErrorInfo | null;
  /**
   * The shown preview was rendered for the current options. False while a newer
   * request is pending or after the newest request failed, so values derived
   * from the preview (output size, layout) may describe older settings.
   */
  readonly upToDate: boolean;
}

export interface PreviewConfig {
  /** Longest edge of the requested preview, in device pixels (64–2400). */
  readonly maxEdge: number;
  readonly enabled?: boolean;
  readonly debounceMs?: number;
}

interface InternalState {
  readonly preview: PreviewResponse | null;
  readonly pending: boolean;
  readonly error: OrbitErrorInfo | null;
  /** Options key the shown preview was requested with. */
  readonly previewKey: string | null;
}

const EMPTY: InternalState = { preview: null, pending: false, error: null, previewKey: null };

export function clampPreviewEdge(edge: number): number {
  return Math.min(2400, Math.max(64, Math.round(edge)));
}

/**
 * Debounced, sequence-ordered processor previews for an editor. `options`
 * null means "nothing to preview" (e.g. no redaction regions yet): the last
 * preview is dropped, requests still in flight are invalidated (their late
 * answers can't bring it back) and no request is made.
 */
export function usePreview(editorId: string, options: unknown, config: PreviewConfig): PreviewState {
  const orbit = useOrbit();
  const sequencer = useRef(new PreviewSequencer());
  const mounted = useRef(true);
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const [state, setState] = useState<InternalState>(EMPTY);

  const key = useMemo(() => (options === null || options === undefined ? null : JSON.stringify(options)), [options]);
  const enabled = config.enabled ?? true;
  const maxEdge = clampPreviewEdge(config.maxEdge);
  const debounceMs = config.debounceMs ?? PREVIEW_DEBOUNCE_MS;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    if (key === null) {
      sequencer.current.invalidate();
      setState(EMPTY);
      return undefined;
    }
    const timer = setTimeout(() => {
      const seqr = sequencer.current;
      const seq = seqr.next();
      const requestKey = key;
      setState((s) => (s.pending ? s : { ...s, pending: true }));
      orbit.requestPreview({ editorId, seq, options: latestOptions.current, maxEdge }).then(
        (outcome) => {
          if (!mounted.current || !seqr.accept(outcome.seq)) return;
          if (outcome.ok) {
            const { ok: _ok, ...preview } = outcome;
            setState({ preview, pending: seqr.pending, error: null, previewKey: requestKey });
          } else if (outcome.stale === true) {
            setState((s) => ({ ...s, pending: seqr.pending }));
          } else {
            setState((s) => ({ ...s, pending: seqr.pending, error: outcome.error }));
          }
        },
        (reason: unknown) => {
          if (!mounted.current || !seqr.accept(seq)) return;
          setState((s) => ({ ...s, pending: seqr.pending, error: asErrorInfo(reason) }));
        },
      );
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [orbit, editorId, key, maxEdge, enabled, debounceMs]);

  return useMemo<PreviewState>(
    () => ({
      preview: state.preview,
      pending: state.pending,
      error: state.error,
      upToDate: state.preview !== null && state.previewKey === key && state.error === null && !state.pending,
    }),
    [state, key],
  );
}
