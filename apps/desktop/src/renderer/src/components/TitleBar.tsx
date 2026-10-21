import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useEnv } from '../app/env';

export interface TitleBarProps {
  readonly title: string;
  /** Close / cancel handler. Defaults to closing the window. */
  readonly onClose?: () => void;
  readonly closeLabel?: string;
  /** Draw a hairline under the bar (for scrolling content). */
  readonly separated?: boolean;
  readonly actions?: ReactNode;
}

/**
 * Title bar for frameless windows: the whole bar is a window drag region, the
 * title is centred, and the × button closes (top-left on macOS like the
 * reference panels, top-right on Windows).
 */
export function TitleBar({ title, onClose, closeLabel, separated = false, actions }: TitleBarProps) {
  const { orbit, platform, t } = useEnv();
  const close = onClose ?? (() => orbit.closeWindow());
  // The page title becomes the window title (window switchers, screen readers).
  useEffect(() => {
    document.title = title === 'OrbitDrop' ? title : `${title} — OrbitDrop`;
  }, [title]);
  return (
    <header className="titlebar" data-platform={platform} data-separated={separated}>
      <button type="button" className="btn-icon titlebar-close" aria-label={closeLabel ?? t('common.close')} title={closeLabel ?? t('common.close')} onClick={close}>
        <X size={15} strokeWidth={2.25} aria-hidden="true" />
      </button>
      <h1 className="titlebar-title">{title}</h1>
      {platform === 'win32' ? null : <div className="titlebar-actions">{actions}</div>}
    </header>
  );
}
