import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';

export type NoticeTone = 'info' | 'warning' | 'danger' | 'success';

export interface NoticeProps {
  readonly tone?: NoticeTone;
  readonly children: ReactNode;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
  /** Announce politely (status) or assertively (alert). Defaults by tone. */
  readonly live?: 'polite' | 'assertive' | 'off';
  readonly id?: string;
  readonly className?: string;
}

const ICONS = { info: Info, warning: TriangleAlert, danger: CircleAlert, success: CircleCheck } as const;

export function Notice({ tone = 'info', children, onDismiss, dismissLabel, live, id, className }: NoticeProps) {
  const Icon = ICONS[tone];
  const mode = live ?? (tone === 'danger' ? 'assertive' : 'polite');
  const role = mode === 'off' ? undefined : mode === 'assertive' ? 'alert' : 'status';
  return (
    <div className={`notice ${className ?? ''}`} data-tone={tone} role={role} id={id}>
      <Icon size={15} aria-hidden="true" />
      <div className="notice-body">{children}</div>
      {onDismiss ? (
        <button type="button" className="btn-icon" aria-label={dismissLabel} onClick={onDismiss}>
          <X size={13} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function Spinner({ size = 14, label }: { readonly size?: number; readonly label?: string }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
