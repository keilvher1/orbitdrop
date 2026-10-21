import type { OrbitApi } from '@orbitdrop/contracts';
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useOrbit } from './env';

const MIN_W = 200;
const MIN_H = 120;
const MAX = 4000;

function observe(el: HTMLElement, orbit: OrbitApi): () => void {
  let last = '';
  let frame = 0;
  const measure = () => {
    frame = 0;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // not laid out (e.g. jsdom)
    const width = Math.min(MAX, Math.max(MIN_W, Math.ceil(rect.width)));
    const height = Math.min(MAX, Math.max(MIN_H, Math.ceil(rect.height)));
    const key = `${width}x${height}`;
    if (key === last) return;
    last = key;
    orbit.resizeWindow(width, height);
  };
  measure();
  if (typeof ResizeObserver === 'undefined') return () => undefined;
  const observer = new ResizeObserver(() => {
    if (frame === 0) frame = requestAnimationFrame(measure);
  });
  observer.observe(el);
  return () => {
    observer.disconnect();
    if (frame !== 0) cancelAnimationFrame(frame);
  };
}

/**
 * Asks main to resize the window so its content area matches the measured size
 * of `ref` (main clamps to the work area). The element should have an
 * intrinsic size (fixed width, natural height) so measuring it does not depend
 * on the current window size. Requests are coalesced per animation frame and
 * only sent when the size actually changes. Follows the element across
 * renders, so views may attach the ref only after a loading state.
 */
export function useWindowFit(ref: RefObject<HTMLElement | null>, enabled = true): void {
  const orbit = useOrbit();
  const current = useRef<{ el: HTMLElement | null; stop: (() => void) | null }>({ el: null, stop: null });

  useLayoutEffect(() => {
    const el = enabled ? ref.current : null;
    if (el === current.current.el) return;
    current.current.stop?.();
    current.current = { el, stop: el ? observe(el, orbit) : null };
  });

  useEffect(
    () => () => {
      current.current.stop?.();
      current.current = { el: null, stop: null };
    },
    [],
  );
}
