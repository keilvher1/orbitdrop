import { useEffect, useRef } from 'react';

/**
 * Whether a keydown belongs to an IME composition (Korean, Japanese, Chinese…):
 * Enter/Escape/Backspace/arrows then edit or end the composition and must not
 * act as shortcuts. keyCode 229 covers engines that report the composing key
 * without `isComposing` (e.g. the keydown that ends a Hangul syllable).
 */
export function isImeKey(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * Window-level Escape handler (close / cancel). Ignored when a focused control
 * already handled the key (preventDefault), e.g. a text field reverting its
 * edit, or while an IME composition is in progress.
 */
export function useEscapeKey(handler: () => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeKey(event)) return;
      event.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
