import { LICENSE_FILES, type LicenseFile } from '@orbitdrop/contracts';
import { useId, useState } from 'react';
import { useEnv } from '../../app/env';
import { Notice, type NoticeTone } from '../../components/Notice';
import type { MessageKey } from '../../i18n/catalog';
import './about-support.css';

const LICENSE_LABELS: Readonly<Record<LicenseFile, MessageKey>> = {
  thirdParty: 'about.legal.thirdParty',
  electron: 'about.legal.electron',
  chromium: 'about.legal.chromium',
};

/**
 * The lower part of About (window and Settings › 정보): copyright and licence,
 * the open-source licence files (opened by main with the OS default app),
 * troubleshooting (diagnostics to the clipboard, the log folder) and a short
 * privacy statement. The page never sees a path or the diagnostics text.
 */
export function AboutSupport() {
  const { orbit, t } = useEnv();
  const [status, setStatus] = useState<{ readonly tone: NoticeTone; readonly text: string } | null>(null);
  const [copying, setCopying] = useState(false);
  const troubleId = useId();
  const privacyId = useId();
  const licensesId = useId();

  const fail = (text: string) => () => setStatus({ tone: 'danger', text });

  const copyDiagnostics = () => {
    if (!orbit.copyDiagnostics || copying) return;
    setCopying(true);
    setStatus(null);
    orbit
      .copyDiagnostics()
      .then((result) => setStatus({ tone: 'success', text: t.plural('diag.copied', result.logLines) }), fail(t('diag.copyFailed')))
      .finally(() => setCopying(false));
  };

  const openLogs = () => {
    setStatus(null);
    orbit.openLogFolder?.().catch(fail(t('diag.openFailed')));
  };

  const openLicense = (which: LicenseFile) => {
    setStatus(null);
    orbit.openLicense?.(which).catch(fail(t('about.legal.openFailed')));
  };

  return (
    <div className="about-support">
      <p className="about-legal">
        {t('about.legal.copyright')} · {t('about.legal.license')}
      </p>
      <div className="about-support-group" role="group" aria-labelledby={licensesId}>
        <span id={licensesId} className="about-support-title">
          {t('about.legal.openSource')}
        </span>
        <div className="about-support-buttons">
          {LICENSE_FILES.map((which) => (
            <button key={which} type="button" className="btn btn-small" onClick={() => openLicense(which)}>
              {t(LICENSE_LABELS[which])}
            </button>
          ))}
        </div>
      </div>

      <section className="about-support-group" aria-labelledby={troubleId}>
        <h3 id={troubleId} className="about-support-title">
          {t('diag.title')}
        </h3>
        <div className="about-support-buttons">
          <button type="button" className="btn btn-small" onClick={copyDiagnostics} aria-disabled={copying || undefined}>
            {t('diag.copy')}
          </button>
          <button type="button" className="btn btn-small" onClick={openLogs}>
            {t('diag.openLogs')}
          </button>
        </div>
        <p className="about-support-hint">{t('diag.hint')}</p>
        {status ? (
          <Notice tone={status.tone} onDismiss={() => setStatus(null)} dismissLabel={t('common.dismiss')}>
            {status.text}
          </Notice>
        ) : null}
      </section>

      <section className="about-support-group" aria-labelledby={privacyId}>
        <h3 id={privacyId} className="about-support-title">
          {t('about.legal.privacy')}
        </h3>
        <ul className="about-privacy">
          <li>{t('about.legal.privacyLocal')}</li>
          <li>{t('about.legal.privacyUpdates')}</li>
          <li>{t('about.legal.privacyCrashes')}</li>
          <li>{t('about.legal.privacyHistory')}</li>
        </ul>
      </section>
    </div>
  );
}
