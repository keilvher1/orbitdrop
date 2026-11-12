import type { OrbitErrorInfo } from '@orbitdrop/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useEnv } from '../../app/env';
import { asErrorInfo } from '../../app/errors';
import { KeyCombo } from '../../app/keys';
import { useEscapeKey } from '../../app/useEscapeKey';
import { useWindowFit } from '../../app/useWindowFit';
import { Notice } from '../../components/Notice';
import { TitleBar } from '../../components/TitleBar';
import { OrbitLogo } from '../settings/AboutView';
import './welcome.css';

type WelcomeError = { readonly kind: 'save' | 'open'; readonly error: OrbitErrorInfo };

/**
 * Window kind 'welcome': shown once on the first run (main opens it while
 * settings.onboarding.welcomeDone is false and marks it done when the window
 * closes — 시작하기, ×, Esc) and again from the tray's 도움말 › 사용법.
 *
 * Teaches the gesture with the user's real keys and this platform's key names
 * (Option on macOS, Alt / Ctrl on Windows), says where the app lives (menu
 * bar; notification area, which Windows 11 may hide under ^), offers the Drop
 * Zone, the "launch at login" switch (off unless the user turns it on) and the
 * "check for updates automatically" switch (settings.updates.autoCheck: on by
 * default, or as chosen in the Windows installer), the app's only network use.
 * Keyboard: Tab through the controls, Esc closes; focus starts on the heading
 * so a screen reader reads the page from the top.
 */
export function WelcomeView() {
  const { orbit, t, settings, platform, updateSettings } = useEnv();
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [problem, setProblem] = useState<WelcomeError | null>(null);
  const howId = useId();
  const whereId = useId();
  const keysId = useId();
  const loginHintId = useId();
  const autoCheckHintId = useId();
  const close = useCallback(() => orbit.closeWindow(), [orbit]);
  useWindowFit(rootRef);
  useEscapeKey(close);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const mac = platform === 'darwin';

  const setLaunchAtLogin = (launchAtLogin: boolean) => {
    setProblem(null);
    updateSettings({ launchAtLogin }).catch((reason: unknown) => setProblem({ kind: 'save', error: asErrorInfo(reason) }));
  };

  const setAutoCheck = (autoCheck: boolean) => {
    setProblem(null);
    updateSettings({ updates: { autoCheck } }).catch((reason: unknown) => setProblem({ kind: 'save', error: asErrorInfo(reason) }));
  };

  const openDropZone = () => {
    setProblem(null);
    orbit.openWindow('dropzone').catch((reason: unknown) => setProblem({ kind: 'open', error: asErrorInfo(reason) }));
  };

  return (
    <div className="view welcome-view" ref={rootRef}>
      <TitleBar title={t('welcome.title')} onClose={close} />
      <div className="welcome-body">
        <header className="welcome-header">
          <OrbitLogo size={48} />
          <h2 ref={headingRef} className="welcome-heading" tabIndex={-1}>
            {t('welcome.heading')}
          </h2>
          <p className="welcome-lead">{t('welcome.lead')}</p>
        </header>

        <section className="welcome-section" aria-labelledby={howId}>
          <h3 id={howId} className="welcome-section-title">
            {t('welcome.how.title')}
          </h3>
          <ol className="welcome-steps">
            <li>{mac ? t('welcome.how.dragMac') : t('welcome.how.dragPc')}</li>
            <li>
              <span id={keysId}>{t('welcome.how.keys')}</span>
              <dl className="welcome-keys" aria-labelledby={keysId}>
                <div className="welcome-key-row">
                  <dt>
                    <KeyCombo combo={settings.globalDrag.convertModifiers} />
                  </dt>
                  <dd>{t('welcome.how.convert')}</dd>
                </div>
                <div className="welcome-key-row">
                  <dt>
                    <KeyCombo combo={settings.globalDrag.toolsModifiers} />
                  </dt>
                  <dd>{t('welcome.how.tools')}</dd>
                </div>
              </dl>
            </li>
            <li>{t('welcome.how.drop')}</li>
          </ol>
          <p className="welcome-hint">{t('welcome.how.keysNote')}</p>
          {!settings.globalDrag.enabled ? (
            <Notice tone="warning" live="off">
              {t('welcome.how.disabled')}
            </Notice>
          ) : null}
        </section>

        <section className="welcome-section" aria-labelledby={whereId}>
          <h3 id={whereId} className="welcome-section-title">
            {t('welcome.where.title')}
          </h3>
          <p>{mac ? t('welcome.where.mac') : t('welcome.where.win')}</p>
          {platform === 'win32' ? <p className="welcome-hint">{t('welcome.where.winOverflow')}</p> : null}
          <p>{t('welcome.fallback')}</p>
          <div>
            <button type="button" className="btn btn-small" onClick={openDropZone}>
              {t('welcome.openDropZone')}
            </button>
          </div>
        </section>

        <div className="welcome-options">
          <div className="welcome-option">
            <label className="checkbox-row">
              <input
                type="checkbox"
                role="switch"
                checked={settings.launchAtLogin}
                aria-describedby={loginHintId}
                onChange={(event) => setLaunchAtLogin(event.target.checked)}
              />
              <span className="welcome-option-label">{t('welcome.launchAtLogin')}</span>
            </label>
            <p id={loginHintId} className="welcome-hint">
              {t('welcome.launchAtLoginHint')}
            </p>
          </div>
          <div className="welcome-option">
            <label className="checkbox-row">
              <input
                type="checkbox"
                role="switch"
                checked={settings.updates.autoCheck}
                aria-describedby={autoCheckHintId}
                onChange={(event) => setAutoCheck(event.target.checked)}
              />
              <span className="welcome-option-label">{t('update.settings.autoCheck')}</span>
            </label>
            <p id={autoCheckHintId} className="welcome-hint">
              {t('welcome.autoCheckHint')}
            </p>
          </div>
        </div>

        {problem ? (
          <Notice tone="danger" onDismiss={() => setProblem(null)} dismissLabel={t('common.dismiss')}>
            {problem.kind === 'save' ? <strong>{t('settings.saveFailed')} </strong> : null}
            {t.error(problem.error)}
          </Notice>
        ) : null}

        <footer className="welcome-footer">
          <p className="welcome-privacy">{t('welcome.privacy')}</p>
          <button type="button" className="btn btn-primary" onClick={close}>
            {t('welcome.start')}
          </button>
        </footer>
      </div>
    </div>
  );
}
