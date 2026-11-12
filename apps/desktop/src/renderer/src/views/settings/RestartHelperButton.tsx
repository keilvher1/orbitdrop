import { useState } from 'react';
import { useEnv } from '../../app/env';

/**
 * Settings › 드래그, when the drag helper gave up after repeated crashes: start
 * it again (with a fresh crash budget, like the tray item). The status above
 * follows through onHelperStatusChanged (starting → running).
 */
export function RestartHelperButton() {
  const { orbit, t } = useEnv();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const restart = () => {
    if (!orbit.restartHelper || busy) return;
    setBusy(true);
    setFailed(false);
    orbit
      .restartHelper()
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <div className="settings-actions">
      <button type="button" className="btn btn-small" onClick={restart} aria-disabled={busy || undefined}>
        {t('crash.helper.restart')}
      </button>
      {failed ? (
        <span className="field-error" role="alert">
          {t('crash.helper.restartFailed')}
        </span>
      ) : null}
    </div>
  );
}
