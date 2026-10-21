import { type OrbitErrorInfo, type SubmitActionResult } from '@orbitdrop/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useEnv } from '../../app/env';
import { useEscapeKey } from '../../app/useEscapeKey';
import { useWindowFit } from '../../app/useWindowFit';
import { ConfirmDialog } from '../../components/ConfirmDialog';
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
  /**
   * Unsaved work that closing would throw away (e.g. annotations): × and Esc
   * first ask in an in-window dialog — keep editing (the default) or close
   * without saving — instead of cancelling right away. null / omitted: close
   * immediately.
   */
  readonly confirmClose?: { readonly message: string } | null;
}

/**
 * Common editor panel (440–560 DIP): title bar with ×, body, footer with Reset
 * on the left and the orange primary action on the right. Esc cancels,
 * ⌘/Ctrl+Enter runs the primary action. The window is sized to the panel.
 *
 * With `confirmClose`, × / Esc open a ConfirmDialog instead; while it is open
 * the panel is `inert` (no pointer, focus or shortcut reaches it), and
 * choosing "keep editing" returns focus to where it was (else to ×).
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
  confirmClose = null,
}: EditorFrameProps) {
  const { t } = useEnv();
  const rootRef = useRef<HTMLDivElement>(null);
  useWindowFit(rootRef);

  const [confirming, setConfirming] = useState(false);
  const needsConfirm = confirmClose !== null;
  /** Element focused when the dialog opened; focus returns there when the user keeps editing. */
  const openerRef = useRef<HTMLElement | null>(null);
  const pendingRestoreRef = useRef(false);
  // Nothing left to lose (e.g. the last shape was removed): no dialog, an open one goes away.
  useEffect(() => {
    if (!needsConfirm) setConfirming(false);
  }, [needsConfirm]);
  const showConfirm = confirming && confirmClose !== null;

  const requestClose = (): void => {
    if (commit.busy) return; // × is disabled and Esc ignored while saving; commit.cancel() checks too
    if (!needsConfirm) {
      commit.cancel();
      return;
    }
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setConfirming(true);
  };
  const keepEditing = (): void => {
    pendingRestoreRef.current = true;
    setConfirming(false);
  };
  const discard = (): void => {
    openerRef.current = null;
    setConfirming(false);
    commit.cancel();
  };
  // Runs in the commit that removes `inert`, so the element can take focus again.
  useLayoutEffect(() => {
    if (showConfirm || !pendingRestoreRef.current) return;
    pendingRestoreRef.current = false;
    const opener = openerRef.current;
    openerRef.current = null;
    const target = opener !== null && opener.isConnected ? opener : rootRef.current?.querySelector<HTMLElement>('.titlebar-close:not(:disabled)');
    target?.focus({ preventScroll: true });
  }, [showConfirm]);

  useEscapeKey(requestClose, escapeEnabled && !commit.busy && !showConfirm);

  const canPrimary = !primaryDisabled && !commit.busy;
  const shortcutEnabled = canPrimary && !showConfirm;
  const primaryRef = useRef(onPrimary);
  primaryRef.current = onPrimary;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing && shortcutEnabled) {
        event.preventDefault();
        primaryRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcutEnabled]);

  return (
    <div className="view editor-view" ref={rootRef} style={width === undefined ? undefined : { width }} inert={showConfirm || undefined}>
      <TitleBar title={title} onClose={requestClose} closeDisabled={commit.busy} closeLabel={t('common.cancelAndClose')} />
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
      {showConfirm ? (
        <ConfirmDialog
          title={t('editor.unsaved.title')}
          message={confirmClose.message}
          cancelLabel={t('editor.unsaved.keep')}
          confirmLabel={t('editor.unsaved.discard')}
          onCancel={keepEditing}
          onConfirm={discard}
        />
      ) : null}
    </div>
  );
}
