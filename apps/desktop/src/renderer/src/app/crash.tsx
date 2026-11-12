import type { Locale, WindowNotice } from '@orbitdrop/contracts';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Notice } from '../components/Notice';
import { TitleBar } from '../components/TitleBar';
import { createTranslator, type MessageKey } from '../i18n/catalog';
import { useEnv } from './env';
import { useEscapeKey } from './useEscapeKey';
import { useWindowFit } from './useWindowFit';
import './crash.css';

/**
 * What a window shows when its view crashed (ErrorBoundary: 'view') or when
 * main reloaded it after a second page crash ('failed'): what happened, what
 * was lost (an editor's unsaved work), and a way out — close the window, open
 * the log folder. Never the view itself, so it cannot crash the same way.
 */
export function CrashScreen({
  variant,
  editor,
  unsavedLost,
  detail,
}: {
  readonly variant: 'view' | 'failed';
  /** An editor window: its unsaved work (options, shapes) is gone. */
  readonly editor: boolean;
  /** Main had a close guard for this window (Annotate shapes, Redact regions) when it crashed. */
  readonly unsavedLost: boolean;
  /** Developer text (the error message), behind a disclosure. */
  readonly detail?: string;
}) {
  const { orbit, t } = useEnv();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [logsFailed, setLogsFailed] = useState(false);
  const close = () => orbit.closeWindow();
  useWindowFit(rootRef);
  useEscapeKey(close);

  useEffect(() => {
    // The work is gone with the view: closing must not ask about it any more.
    orbit.setCloseGuard?.(false);
    closeRef.current?.focus({ preventScroll: true });
  }, [orbit]);

  const openLogs = orbit.openLogFolder
    ? () => {
        setLogsFailed(false);
        orbit.openLogFolder?.().catch(() => setLogsFailed(true));
      }
    : null;

  return (
    <div className="view crash-view" ref={rootRef}>
      <TitleBar title={t('app.name')} onClose={close} />
      <div className="crash-body" role="alert" data-window-failure="">
        <TriangleAlert className="crash-icon" size={26} aria-hidden="true" />
        <h2 className="crash-title">{variant === 'failed' ? t('crash.failed.title') : t('crash.view.title')}</h2>
        <p>{variant === 'failed' ? t('crash.failed.body') : t('crash.view.body')}</p>
        {editor ? <p>{t('crash.editorLost')}</p> : null}
        {unsavedLost ? <p>{t('crash.unsavedLost')}</p> : null}
        <p className="muted">{t('crash.report')}</p>
        {detail ? (
          <details className="crash-details">
            <summary>{t('crash.details')}</summary>
            <code>{detail}</code>
          </details>
        ) : null}
        <div className="crash-actions">
          {openLogs ? (
            <button type="button" className="btn" onClick={openLogs}>
              {t('crash.openLogs')}
            </button>
          ) : null}
          <button ref={closeRef} type="button" className="btn btn-primary" onClick={close}>
            {t('crash.close')}
          </button>
        </div>
        {logsFailed ? <Notice tone="danger">{t('diag.openFailed')}</Notice> : null}
      </div>
    </div>
  );
}

/**
 * The first time a window's page crashed main reloaded it ('recovered'): the
 * view is back, and this says so — for an editor, that the options it had
 * were reset (and unsaved shapes are gone). Floats under the title bar so the
 * view's own layout and size stay as they are; dismissible.
 */
export function WindowNoticeBanner({ notice, editor }: { readonly notice: WindowNotice; readonly editor: boolean }) {
  const { t } = useEnv();
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="window-notice">
      <Notice tone="warning" live="assertive" onDismiss={() => setOpen(false)} dismissLabel={t('common.dismiss')}>
        <strong>{t('crash.recovered')}</strong>
        {editor ? <div>{t('crash.recoveredEditor')}</div> : null}
        {notice.unsavedLost ? <div>{t('crash.unsavedLost')}</div> : null}
      </Notice>
    </div>
  );
}

/**
 * The window could not even start its view (no preload, main did not answer):
 * no settings, so the text is in the settings' language when main could still
 * tell it, otherwise in Korean and English. Close button included.
 */
export function StartupFailure({
  message,
  locale,
  onClose,
  onOpenLogs,
}: {
  readonly message: string;
  readonly locale: Locale | null;
  readonly onClose: () => void;
  readonly onOpenLogs?: () => void;
}) {
  const locales: readonly Locale[] = locale === null ? ['ko', 'en'] : [locale];
  const translators = locales.map((code) => createTranslator(code));
  const label = (key: MessageKey): string => translators.map((tr) => tr(key)).join(' / ');
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="view-error crash-startup" role="alert">
      {translators.map((tr) => (
        <div key={tr.locale} lang={tr.locale} className="crash-startup-text">
          <strong>{tr('shell.loadFailed')}</strong>
          <span>{tr('crash.view.body')}</span>
        </div>
      ))}
      <code className="muted crash-startup-detail">{message}</code>
      <div className="crash-actions">
        {onOpenLogs ? (
          <button type="button" className="btn" onClick={onOpenLogs}>
            {label('crash.openLogs')}
          </button>
        ) : null}
        <button ref={closeRef} type="button" className="btn btn-primary" onClick={onClose}>
          {label('crash.close')}
        </button>
      </div>
    </div>
  );
}
