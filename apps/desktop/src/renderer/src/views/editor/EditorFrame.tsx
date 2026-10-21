import { type OrbitErrorInfo, type SubmitActionResult } from '@orbitdrop/contracts';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useEnv } from '../../app/env';
import { useEscapeKey } from '../../app/useEscapeKey';
import { useWindowFit } from '../../app/useWindowFit';
import { Notice, Spinner } from '../../components/Notice';
import { TitleBar } from '../../components/TitleBar';
import './editor.css';
import { asErrorInfo } from '../../app/errors';

export interface EditorCommit {
  readonly busy: boolean;
  readonly error: OrbitErrorInfo | null;
  readonly clearError: () => void;
  /** commitEditor; closes the window when main accepted it (unless `stayOpen`). */
  readonly commit: (options: unknown, stayOpen?: boolean) => Promise<SubmitActionResult | null>;
  /** cancelEditor + close. Nothing has been written at this point. */
  readonly cancel: () => void;
}

export function useEditorCommit(editorId: string): EditorCommit {
  const { orbit } = useEnv();
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState<OrbitErrorInfo | null>(null);
  // Read synchronously by cancel(): once "Saving…" started, closing must not
  // cancel the editor (main may already be writing the result).
  const busyRef = useRef(false);
  const setBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusyState(value);
  }, []);

  const commit = useCallback(
    async (options: unknown, stayOpen = false) => {
      if (busyRef.current) return null;
      setBusy(true);
      setError(null);
      try {
        const result = await orbit.commitEditor({ editorId, options });
        if (result.kind === 'rejected') {
          setError(result.error);
          setBusy(false);
          return result;
        }
        if (stayOpen) setBusy(false);
        else orbit.closeWindow();
        return result;
      } catch (reason) {
        setError(asErrorInfo(reason));
        setBusy(false);
        return null;
      }
    },
    [orbit, editorId, setBusy],
  );

  const cancel = useCallback(() => {
    if (busyRef.current) return;
    void orbit.cancelEditor(editorId).catch(() => undefined);
    orbit.closeWindow();
  }, [orbit, editorId]);

  return { busy, error, clearError: () => setError(null), commit, cancel };
}

export interface EditorFrameProps {
  readonly title: string;
  readonly commit: EditorCommit;
  readonly primaryLabel: string;
  readonly onPrimary: () => void;
  readonly primaryDisabled?: boolean;
  readonly onReset?: () => void;
  readonly resetDisabled?: boolean;
  readonly children: ReactNode;
  /** Short note shown above the footer buttons (e.g. the result file name). */
  readonly footerNote?: ReactNode;
  /** Replace the default footer (e.g. a result view). */
  readonly footer?: ReactNode;
  readonly width?: number;
  /** Disable the window-level Esc (e.g. while a text overlay is open). */
  readonly escapeEnabled?: boolean;
}

/**
 * Common editor panel (440–560 DIP): title bar with ×, body, footer with Reset
 * on the left and the orange primary action on the right. Esc cancels,
 * ⌘/Ctrl+Enter runs the primary action. The window is sized to the panel.
 */
export function EditorFrame({
  title,
  commit,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  onReset,
  resetDisabled = false,
  children,
  footerNote,
  footer,
  width,
  escapeEnabled = true,
}: EditorFrameProps) {
  const { t } = useEnv();
  const rootRef = useRef<HTMLDivElement>(null);
  useWindowFit(rootRef);
  useEscapeKey(commit.cancel, escapeEnabled && !commit.busy);

  const canPrimary = !primaryDisabled && !commit.busy;
  const primaryRef = useRef(onPrimary);
  primaryRef.current = onPrimary;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing && canPrimary) {
        event.preventDefault();
        primaryRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canPrimary]);

  return (
    <div className="view editor-view" ref={rootRef} style={width === undefined ? undefined : { width }}>
      <TitleBar title={title} onClose={commit.cancel} closeDisabled={commit.busy} closeLabel={t('common.cancelAndClose')} />
      <div className="editor-body">{children}</div>
      {commit.error ? (
        <div className="editor-error">
          <Notice tone="danger" onDismiss={commit.clearError} dismissLabel={t('common.dismiss')}>
            <strong>{t('editor.commitFailed')}</strong> {t.error(commit.error)}
          </Notice>
        </div>
      ) : null}
      {footer === undefined && footerNote ? <p className="editor-footnote">{footerNote}</p> : null}
      {footer ?? (
        <footer className="editor-footer">
          {onReset ? (
            <button type="button" className="btn" onClick={onReset} disabled={resetDisabled || commit.busy}>
              {t('common.reset')}
            </button>
          ) : null}
          <div className="editor-footer-spacer" />
          <button type="button" className="btn btn-primary" onClick={onPrimary} disabled={!canPrimary} aria-busy={commit.busy || undefined}>
            {commit.busy ? <Spinner size={13} /> : null}
            {commit.busy ? t('editor.saving') : primaryLabel}
          </button>
        </footer>
      )}
    </div>
  );
}
