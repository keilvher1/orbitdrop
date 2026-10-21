import { type OrbitErrorInfo, type PreviewResponse } from '@orbitdrop/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOrbit } from '../../app/env';
import { PreviewSequencer } from './previewSequencer';
import { asErrorInfo } from '../../app/errors';

export const PREVIEW_DEBOUNCE_MS = 60;

export interface PreviewState {
  /** Last successfully rendered preview (kept while newer ones are pending or fail). */
  readonly preview: PreviewResponse | null;
  /** A request newer than the shown preview is in flight. */
  readonly pending: boolean;
  /** Error of the newest answered request, cleared by the next good preview. */
  readonly error: OrbitErrorInfo | null;
}

export interface PreviewConfig {
  /** Longest edge of the requested preview, in device pixels (64–2400). */
  readonly maxEdge: number;
  readonly enabled?: boolean;
  readonly debounceMs?: number;
}

export function clampPreviewEdge(edge: number): number {
  return Math.min(2400, Math.max(64, Math.round(edge)));
}

/**
 * Debounced, sequence-ordered processor previews for an editor. `options`
 * null means "nothing to preview" (e.g. no redaction regions yet): the last
 * preview is dropped and no request is made.
 */
export function usePreview(editorId: string, options: unknown, config: PreviewConfig): PreviewState {
  const orbit = useOrbit();
  const sequencer = useRef(new PreviewSequencer());
  const mounted = useRef(true);
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const [state, setState] = useState<PreviewState>({ preview: null, pending: false, error: null });

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
      setState({ preview: null, pending: false, error: null });
      return undefined;
    }
    const timer = setTimeout(() => {
      const seqr = sequencer.current;
      const seq = seqr.next();
      setState((s) => (s.pending ? s : { ...s, pending: true }));
      orbit.requestPreview({ editorId, seq, options: latestOptions.current, maxEdge }).then(
        (outcome) => {
          if (!mounted.current || !seqr.accept(outcome.seq)) return;
          if (outcome.ok) {
            const { ok: _ok, ...preview } = outcome;
            setState({ preview, pending: seqr.pending, error: null });
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

  return state;
}
