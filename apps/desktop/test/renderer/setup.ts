/**
 * Shared setup for renderer tests. Import it first in every renderer test file
 * that uses `// @vitest-environment jsdom`:
 *   import './setup';
 * It registers Testing Library cleanup (vitest globals are off) and fills the
 * jsdom gaps the renderer touches: matchMedia, ResizeObserver, pointer capture,
 * a no-op 2D canvas context, Image.decode.
 */
import '../../src/renderer/src/zod-jitless';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

if (typeof window !== 'undefined') {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string): MediaQueryList =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    });
  }

  if (typeof (window as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: NoopResizeObserver });
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: NoopResizeObserver });
  }

  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (typeof proto.setPointerCapture !== 'function') proto.setPointerCapture = () => undefined;
  if (typeof proto.releasePointerCapture !== 'function') proto.releasePointerCapture = () => undefined;
  if (typeof proto.hasPointerCapture !== 'function') proto.hasPointerCapture = () => false;

  // jsdom has no canvas backend; give components a context that records nothing.
  const noop = () => undefined;
  const fakeContext = new Proxy(
    {
      measureText: (text: string) => ({ width: text.length * 7 }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
    } as Record<string | symbol, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return noop;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => fakeContext });
  Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', { configurable: true, value: () => 'data:image/png;base64,' });
}
