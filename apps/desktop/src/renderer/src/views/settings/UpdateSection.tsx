import { RELEASES_URL, type AppInfo, type Locale, type UpdateState } from '@orbitdrop/contracts';
import { ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useEnv } from '../../app/env';
import { Spinner } from '../../components/Notice';
import type { Translator } from '../../i18n/catalog';
import './update.css';

/** The About version line: the version, plus the short commit a package was built from. */
export function aboutVersionText(info: AppInfo, t: Translator): string {
  const commit = info.build?.commit;
  if (!commit) return t('about.version', { version: info.version });
  return t('update.versionWithCommit', { version: info.version, commit: info.build?.dirty ? `${commit}-dirty` : commit });
}

/** What the update service is doing, in one sentence. */
export function updateStatusText(state: UpdateState, t: Translator): string {
  switch (state.state) {
    case 'unsupported':
      return t(`update.unsupported.${state.reason}`);
    case 'idle':
      return t(state.autoCheck ? 'update.state.idle' : 'update.state.idleAutoOff');
    case 'checking':
      return t('update.state.checking');
    case 'available':
      return t('update.state.available', { version: state.version });
    case 'downloading':
      return t('update.state.downloading', { version: state.version, percent: state.percent });
    case 'downloaded':
      return state.restartPending ? t('update.state.restartPending') : t('update.state.downloaded', { version: state.version });
    case 'upToDate':
      return t('update.state.upToDate');
    case 'error':
      return t(`update.error.${state.error}`);
  }
}

function formatCheckedAt(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

/**
 * About › 업데이트: the update service's state (main pushes changes), "지금 확인", "재시작하여
 * 업데이트" once an update is downloaded, and the releases page. Problems are plain text — never a
 * danger notice (offline is not an error the user has to act on; the smoke test also treats a
 * danger notice in About as a broken window).
 */
export function UpdateSection() {
  const { orbit, t } = useEnv();
  const [state, setState] = useState<UpdateState | null>(null);
  const [requesting, setRequesting] = useState(false);
  const mounted = useRef(true);
  const headingId = useId();

  useEffect(() => {
    mounted.current = true;
    let live = false;
    const unsubscribe = orbit.onUpdateStateChanged((next) => {
      live = true;
      if (mounted.current) setState(next);
    });
    orbit.getUpdateState().then(
      (next) => {
        if (mounted.current && !live) setState(next);
      },
      () => undefined,
    );
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [orbit]);

  const run = useCallback(
    (request: () => Promise<UpdateState>) => {
      setRequesting(true);
      request()
        .then(
          (next) => {
            if (mounted.current) setState(next);
          },
          () => undefined,
        )
        .finally(() => {
          if (mounted.current) setRequesting(false);
        });
    },
    [],
  );

  const openReleases = () => {
    orbit.openExternal(RELEASES_URL).catch(() => undefined);
  };

  const phase = state?.state;
  const busy = phase === 'checking' || phase === 'available' || phase === 'downloading';
  const canCheck = state !== null && phase !== 'unsupported' && phase !== 'downloaded';
  const showChecked = state !== null && state.lastCheckedAt !== null && (phase === 'upToDate' || phase === 'error');

  return (
    <section className="about-update" aria-labelledby={headingId}>
      <h3 id={headingId} className="about-update-title">
        {t('update.title')}
      </h3>
      {state ? <p className="about-update-checked tabular">{t('update.current', { version: state.currentVersion })}</p> : null}
      {state ? (
        <p className="about-update-status" aria-live="polite" aria-atomic="true" aria-busy={busy}>
          {busy ? <Spinner size={11} /> : null}
          <span>{updateStatusText(state, t)}</span>
        </p>
      ) : null}
      {showChecked && state?.lastCheckedAt ? <p className="about-update-checked tabular">{t('update.lastChecked', { time: formatCheckedAt(state.lastCheckedAt, t.locale) })}</p> : null}
      <div className="about-update-actions">
        {state?.state === 'downloaded' ? (
          <button type="button" className="btn btn-primary btn-small" disabled={state.restartPending || requesting} onClick={() => run(() => orbit.restartToUpdate())}>
            {state.restartPending ? t('update.restartWaiting') : t('update.restart')}
          </button>
        ) : null}
        {canCheck ? (
          <button type="button" className="btn btn-small" disabled={busy || requesting} onClick={() => run(() => orbit.checkForUpdates())}>
            {t('update.checkNow')}
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost btn-small about-update-link" onClick={openReleases}>
          <ExternalLink size={12} aria-hidden="true" />
          {t('update.releases')}
        </button>
      </div>
    </section>
  );
}
