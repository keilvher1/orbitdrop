import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  readonly title: string;
  readonly message: string;
  /** The safe choice (e.g. "Keep editing"): focused first, also what Esc does. */
  readonly cancelLabel: string;
  /** The destructive choice (e.g. "Close without saving"). */
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * In-window confirmation (role="alertdialog", modal) — never a native dialog.
 * Rendered into <body> through a portal so the caller can make its own content
 * `inert` while the dialog is open; it overlays the window (position: fixed)
 * without changing the window's size.
 *
 * Keyboard: the safe choice has focus first; Tab / Shift+Tab stay inside the
 * dialog; Esc picks the safe choice; Enter / Space activate the focused
 * button. No key reaches the window beneath: keys inside the dialog stop
 * propagating at the portal (React handles them there, before window
 * listeners such as Esc-to-close, ⌘Enter or undo), and keys aimed at anything
 * else (focus fell to <body>) are swallowed by a capturing window listener —
 * Esc then keeps editing and Tab moves back into the dialog. A click on the
 * backdrop does nothing (it neither confirms nor closes, and keeps focus in
 * the dialog): losing work must take an explicit choice.
 */
export function ConfirmDialog({ title, message, cancelLabel, confirmLabel, onCancel, onConfirm }: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancelHandler = useRef(onCancel);
  cancelHandler.current = onCancel;

  // Focus moves in during the commit that shows the dialog (and makes the caller inert).
  useLayoutEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (panel === null || (event.target instanceof Node && panel.contains(event.target))) return;
      event.stopPropagation();
      event.preventDefault();
      if (event.key === 'Escape' && !event.isComposing) cancelHandler.current();
      else if (event.key === 'Tab') (event.shiftKey ? focusables(panel).at(-1) : focusables(panel)[0])?.focus({ preventScroll: true });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keep window-level shortcuts of the window beneath (Esc-to-close, ⌘/Ctrl+Enter, ⌘Z…) from firing.
    event.stopPropagation();
    if (event.key === 'Escape') {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (panel === null) return;
    event.preventDefault();
    const items = focusables(panel);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : index < 0 || index === items.length - 1 ? 0 : index + 1;
    items[next]?.focus({ preventScroll: true });
  };

  // A press on the backdrop must not move focus out of the dialog (onto the inert page).
  const onBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) event.preventDefault();
  };

  return createPortal(
    <div className="confirm-backdrop" onMouseDown={onBackdropMouseDown}>
      <div
        ref={panelRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="confirm-title">
          {title}
        </h2>
        <p id={messageId} className="confirm-message">
          {message}
        </p>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="btn confirm-discard" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
