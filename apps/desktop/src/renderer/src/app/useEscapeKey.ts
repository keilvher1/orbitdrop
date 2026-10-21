import { useEffect, useRef } from 'react';

/**
 * Window-level Escape handler (close / cancel). Ignored when a focused control
 * already handled the key (preventDefault), e.g. a text field reverting its
 * edit or an IME composition in progress.
 */
export function useEscapeKey(handler: () => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
