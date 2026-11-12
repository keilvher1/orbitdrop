import type { AppInfo, OrbitErrorInfo, Platform } from '@orbitdrop/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEnv } from '../../app/env';
import { asErrorInfo } from '../../app/errors';
import { useEscapeKey } from '../../app/useEscapeKey';
import { useWindowFit } from '../../app/useWindowFit';
import { Notice, Spinner } from '../../components/Notice';
import { TitleBar } from '../../components/TitleBar';
import { capsulePath, sectorShape } from '../../wheel/sectorPath';
import { AboutSupport } from './AboutSupport';
import './settings.css';

const PLATFORM_NAMES: Readonly<Record<Platform, string>> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** Mini four-sector wheel (one orange sector) drawn with the same path generator as the real wheel. */
export function OrbitLogo({ size = 72 }: { readonly size?: number }) {
  const half = size / 2;
  const outer = half - 4;
  const inner = outer * 0.38;
  const shapes = [0, 1, 2, 3].map((index) =>
    sectorShape({ index, count: 4, innerRadius: inner, outerRadius: outer, gap: Math.max(2, size / 28), cornerRadius: size / 16, startAngleDeg: -90 }),
  );
  return (
    <svg className="about-logo" width={size} height={size} viewBox={`${-half} ${-half} ${size} ${size}`} aria-hidden="true" focusable="false">
      <circle className="about-logo-disc" r={half - 1} />
      {shapes.map((shape, index) => (
        <path key={index} d={shape.path} className={index === 1 ? 'about-logo-active' : 'about-logo-sector'} />
      ))}
      <path d={capsulePath(inner * 1.5, inner * 0.8)} className="about-logo-capsule" />
    </svg>
  );
}

/** About content: shown in its own window and in the Settings "About" tab. */
export function AboutContent() {
  const { orbit, t } = useEnv();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<OrbitErrorInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    orbit.getAppInfo().then(
      (next) => {
        if (!cancelled) setInfo(next);
      },
      (reason: unknown) => {
        if (!cancelled) setError(asErrorInfo(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orbit]);

  return (
    <div className="about">
      <OrbitLogo />
      <h2 className="about-name">{info?.name ?? t('app.name')}</h2>
      {info ? (
        <>
          <p className="about-version tabular">{t('about.version', { version: info.version })}</p>
          <p className="about-tagline">{t('about.tagline')}</p>
          <div className="about-details tabular">
            <p>{t('about.runtime', { electron: info.electron, chrome: info.chrome, node: info.node })}</p>
            <p>
              {t('about.platform', {
                platform: PLATFORM_NAMES[info.platform] ?? info.platform,
                arch: info.translated === true ? t('about.archTranslated', { arch: info.arch }) : info.arch,
              })}{' '}
              ·{' '}
              {info.packaged ? t('about.packaged') : t('about.devBuild')}
            </p>
          </div>
        </>
      ) : error ? (
        <Notice tone="danger">{t.error(error)}</Notice>
      ) : (
        <div className="view-loading" role="status">
          <Spinner size={14} />
          <span>{t('common.loading')}</span>
        </div>
      )}
      <AboutSupport />
    </div>
  );
}

/** Window kind 'about'. */
export function AboutView() {
  const { orbit, t } = useEnv();
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => orbit.closeWindow(), [orbit]);
  useWindowFit(rootRef);
  useEscapeKey(close);
  return (
    <div className="view about-view" ref={rootRef}>
      <TitleBar title={t('about.title')} onClose={close} />
      <div className="about-view-body">
        <AboutContent />
      </div>
    </div>
  );
}
