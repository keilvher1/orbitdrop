import { useId, useRef, useState } from 'react';
import { useEnv } from '../../app/env';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Notice, type NoticeTone } from '../../components/Notice';

/**
 * Settings › 일반 › 데이터: open the app data folder (settings, history, logs —
 * main resolves the path), and reset every setting to this computer's defaults
 * after an in-window confirmation (never a native dialog, which could appear
 * in the middle of a drag). The language, history and outputs stay.
 */
export function DataActions() {
  const { orbit, t } = useEnv();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ readonly tone: NoticeTone; readonly text: string } | null>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const folderHintId = useId();
  const resetHintId = useId();

  const openFolder = () => {
    setStatus(null);
    orbit.openDataFolder?.().catch(() => setStatus({ tone: 'danger', text: t('data.openFailed') }));
  };

  const closeDialog = () => {
    setConfirming(false);
    resetRef.current?.focus({ preventScroll: true });
  };

  const reset = () => {
    setConfirming(false);
    if (!orbit.resetSettings || busy) return;
    setBusy(true);
    setStatus(null);
    orbit
      .resetSettings()
      .then(
        () => setStatus({ tone: 'success', text: t('data.resetDone') }),
        () => setStatus({ tone: 'danger', text: t('data.resetFailed') }),
      )
      .finally(() => {
        setBusy(false);
        resetRef.current?.focus({ preventScroll: true });
      });
  };

  return (
    <section className="settings-group" aria-labelledby={titleId}>
      <h2 id={titleId} className="settings-group-title">
        {t('data.title')}
      </h2>
      <div className="settings-field">
        <button type="button" className="btn btn-small" onClick={openFolder} aria-describedby={folderHintId}>
          {t('data.openFolder')}
        </button>
        <p id={folderHintId} className="settings-hint">
          {t('data.folderHint')}
        </p>
      </div>
      <div className="settings-field">
        <button
          ref={resetRef}
          type="button"
          className="btn btn-small"
          onClick={() => {
            if (!busy) setConfirming(true);
          }}
          aria-describedby={resetHintId}
          aria-disabled={busy || undefined}
          disabled={!orbit.resetSettings}
        >
          {t('data.reset')}
        </button>
        <p id={resetHintId} className="settings-hint">
          {t('data.resetHint')}
        </p>
      </div>
      {status ? (
        <Notice tone={status.tone} onDismiss={() => setStatus(null)} dismissLabel={t('common.dismiss')}>
          {status.text}
        </Notice>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={t('data.resetConfirm.title')}
          message={t('data.resetConfirm.message')}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('data.resetConfirm.confirm')}
          onCancel={closeDialog}
          onConfirm={reset}
        />
      ) : null}
    </section>
  );
}
