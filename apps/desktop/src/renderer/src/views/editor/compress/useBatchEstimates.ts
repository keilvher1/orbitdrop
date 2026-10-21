import type { FileFormat, OrbitErrorInfo, SelectedFile } from '@orbitdrop/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOrbit } from '../../../app/env';
import { asErrorInfo } from '../../../app/errors';

/** Wait this long after the options last changed before estimating every file (slider drags send nothing). */
export const ESTIMATE_DEBOUNCE_MS = 350;

/**
 * Compress estimate of one file for the current options. `pending` may carry
 * the previous options' estimate so the list does not jump while recomputing
 * (shown dimmed, never counted in totals).
 */
export type FileEstimate =
  | { readonly status: 'pending'; readonly previous?: number }
  | {
      readonly status: 'ok';
      readonly bytes: number;
      readonly outputFormat?: FileFormat;
      readonly outputWidth?: number;
      readonly outputHeight?: number;
    }
  | { readonly status: 'error'; readonly error: OrbitErrorInfo };

export interface BatchEstimates {
  /** One entry per file, for the current options (pending until answered). */
  readonly entries: ReadonlyMap<string, FileEstimate>;
}

interface InternalState {
  /** Options key the entries were requested for (null: nothing requested yet). */
  readonly key: string | null;
  readonly seq: number;
  readonly entries: ReadonlyMap<string, FileEstimate>;
}

const EMPTY: ReadonlyMap<string, FileEstimate> = new Map();

function previousOf(entry: FileEstimate | undefined): number | undefined {
  if (entry === undefined) return undefined;
  if (entry.status === 'ok') return entry.bytes;
  return entry.status === 'pending' ? entry.previous : undefined;
}

function pendingFrom(entry: FileEstimate | undefined): FileEstimate {
  const previous = previousOf(entry);
  return previous === undefined ? { status: 'pending' } : { status: 'pending', previous };
}

function withEntry(entries: ReadonlyMap<string, FileEstimate>, fileId: string, entry: FileEstimate): ReadonlyMap<string, FileEstimate> {
  const next = new Map(entries);
  next.set(fileId, entry);
  return next;
}

/**
 * Per-file Compress estimates of a multi-file editor (requestEstimate). Each
 * options change gets one new sequence number shared by every file and is sent
 * only after the options stayed unchanged for `debounceMs`; main runs at most a
 * couple of encodes at once and answers requests of an older sequence `stale`,
 * which are ignored here like any answer that arrives after a newer batch
 * started. Estimates are the byte length of a real full-size encode (what the
 * job would write), cached per file and options by the processors.
 */
export function useBatchEstimates(
  editorId: string,
  files: readonly SelectedFile[],
  options: unknown,
  config: { readonly enabled: boolean; readonly debounceMs?: number },
): BatchEstimates {
  const orbit = useOrbit();
  const seqRef = useRef(0);
  const mounted = useRef(true);
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const [state, setState] = useState<InternalState>({ key: null, seq: 0, entries: EMPTY });

  const key = useMemo(() => JSON.stringify(options ?? null), [options]);
  const fileIds = useMemo(() => files.map((f) => f.fileId), [files]);
  const idsKey = fileIds.join('\n');
  const debounceMs = config.debounceMs ?? ESTIMATE_DEBOUNCE_MS;
  const enabled = config.enabled && fileIds.length > 0;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const ids = idsKey.split('\n');
    const timer = setTimeout(() => {
      seqRef.current += 1;
      const seq = seqRef.current;
      setState((s) => ({ key, seq, entries: new Map(ids.map((id) => [id, pendingFrom(s.entries.get(id))])) }));
      const settle = (fileId: string, entry: FileEstimate) => {
        // Superseded by a newer batch (or the view went away): drop the answer.
        if (!mounted.current || seq !== seqRef.current) return;
        setState((s) => (s.seq === seq ? { ...s, entries: withEntry(s.entries, fileId, entry) } : s));
      };
      for (const fileId of ids) {
        orbit.requestEstimate({ editorId, fileId, seq, options: latestOptions.current }).then(
          (outcome) => {
            if (outcome.ok) {
              settle(fileId, {
                status: 'ok',
                bytes: outcome.estimatedBytes,
                ...(outcome.outputFormat !== undefined ? { outputFormat: outcome.outputFormat } : {}),
                ...(outcome.outputWidth !== undefined ? { outputWidth: outcome.outputWidth } : {}),
                ...(outcome.outputHeight !== undefined ? { outputHeight: outcome.outputHeight } : {}),
              });
            } else if (outcome.stale !== true) {
              settle(fileId, { status: 'error', error: outcome.error });
            }
          },
          (reason: unknown) => settle(fileId, { status: 'error', error: asErrorInfo(reason) }),
        );
      }
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [orbit, editorId, key, idsKey, enabled, debounceMs]);

  const entries = useMemo<ReadonlyMap<string, FileEstimate>>(() => {
    if (!enabled) return EMPTY;
    // Options changed and the new batch has not started (debounce): everything is pending again.
    if (state.key === key) return state.entries;
    return new Map(fileIds.map((id) => [id, pendingFrom(state.entries.get(id))]));
  }, [enabled, state, key, fileIds]);

  return useMemo(() => ({ entries }), [entries]);
}

export interface EstimateSummary {
  readonly total: number;
  /** Files answered (estimate or error) for the current options. */
  readonly done: number;
  readonly complete: boolean;
  readonly failed: number;
  /** Sum of the files' input sizes. */
  readonly inputBytes: number;
  /** Sum of the estimates, only when every file has one. */
  readonly estimatedBytes: number | null;
  /** Files whose estimate is not smaller than the input. */
  readonly notSmaller: number;
}

/** Totals over a batch. An estimate ≥ the input counts as "not smaller" (never shown as a success). */
export function summarizeEstimates(files: readonly SelectedFile[], entries: ReadonlyMap<string, FileEstimate>): EstimateSummary {
  let done = 0;
  let failed = 0;
  let notSmaller = 0;
  let inputBytes = 0;
  let estimated = 0;
  for (const file of files) {
    inputBytes += file.bytes;
    const entry = entries.get(file.fileId);
    if (entry?.status === 'ok') {
      done += 1;
      estimated += entry.bytes;
      if (entry.bytes >= file.bytes) notSmaller += 1;
    } else if (entry?.status === 'error') {
      done += 1;
      failed += 1;
    }
  }
  const complete = files.length > 0 && done === files.length;
  return {
    total: files.length,
    done,
    complete,
    failed,
    inputBytes,
    estimatedBytes: complete && failed === 0 ? estimated : null,
    notSmaller,
  };
}
