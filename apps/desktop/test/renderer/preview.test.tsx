// @vitest-environment jsdom
import './setup';
import { DEFAULT_SETTINGS, type OrbitApi, type PreviewOutcome, type PreviewRequestIpc } from '@orbitdrop/contracts';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvProvider } from '../../src/renderer/src/app/env';
import { PreviewSequencer } from '../../src/renderer/src/views/editor/previewSequencer';
import { PREVIEW_DEBOUNCE_MS, usePreview } from '../../src/renderer/src/views/editor/usePreview';
import { createFakeOrbit, deferred, type FakeOrbit } from './helpers';

describe('PreviewSequencer', () => {
  it('issues monotonic seqs starting at 1', () => {
    const s = new PreviewSequencer();
    expect([s.next(), s.next(), s.next()]).toEqual([1, 2, 3]);
    expect(s.latestRequested).toBe(3);
  });

  it('applies only responses newer than the last applied one', () => {
    const s = new PreviewSequencer();
    s.next();
    s.next();
    s.next();
    expect(s.accept(2)).toBe(true);
    expect(s.pending).toBe(true);
    expect(s.accept(1)).toBe(false); // older than what is shown
    expect(s.accept(2)).toBe(false); // duplicate
    expect(s.accept(3)).toBe(true);
    expect(s.pending).toBe(false);
    expect(s.accept(4)).toBe(false); // never requested
    expect(s.accept(Number.NaN)).toBe(false);
  });
});

function ok(seq: number, url: string): PreviewOutcome {
  return { ok: true, seq, url, width: 200, height: 100 };
}

describe('usePreview', () => {
  let orbit: FakeOrbit;
  let calls: { request: PreviewRequestIpc; resolve: (o: PreviewOutcome) => void; reject: (e: unknown) => void }[];

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    orbit = createFakeOrbit();
    orbit.requestPreview.mockImplementation((request) => {
      const d = deferred<PreviewOutcome>();
      calls.push({ request, resolve: d.resolve, reject: d.reject });
      return d.promise;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <EnvProvider orbit={orbit as unknown as OrbitApi} initialSettings={DEFAULT_SETTINGS}>
      {children}
    </EnvProvider>
  );

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  it('debounces option changes (~60 ms) and sends seq-ordered requests', async () => {
    const { rerender } = renderHook(({ options }) => usePreview('ed1', options, { maxEdge: 900 }), { wrapper, initialProps: { options: { v: 1 } as unknown } });
    rerender({ options: { v: 2 } });
    rerender({ options: { v: 3 } });
    expect(calls).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toEqual({ editorId: 'ed1', seq: 1, options: { v: 3 }, maxEdge: 900 });
  });

  it('ignores out-of-order (stale) responses and keeps the newest preview', async () => {
    const { result, rerender } = renderHook(({ options }) => usePreview('ed1', options, { maxEdge: 900 }), { wrapper, initialProps: { options: { v: 1 } as unknown } });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    rerender({ options: { v: 2 } });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    expect(calls.map((c) => c.request.seq)).toEqual([1, 2]);
    expect(result.current.pending).toBe(true);

    calls[1]?.resolve(ok(2, 'url-2'));
    await flush();
    expect(result.current.preview?.url).toBe('url-2');
    expect(result.current.pending).toBe(false);

    // The slow first request arrives late: ignored.
    calls[0]?.resolve(ok(1, 'url-1'));
    await flush();
    expect(result.current.preview?.url).toBe('url-2');
  });

  it('shows an older response that arrives first, then the newer one', async () => {
    const { result, rerender } = renderHook(({ options }) => usePreview('ed1', options, { maxEdge: 900 }), { wrapper, initialProps: { options: { v: 1 } as unknown } });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    rerender({ options: { v: 2 } });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    calls[0]?.resolve(ok(1, 'url-1'));
    await flush();
    expect(result.current.preview?.url).toBe('url-1');
    expect(result.current.pending).toBe(true);
    calls[1]?.resolve(ok(2, 'url-2'));
    await flush();
    expect(result.current.preview?.url).toBe('url-2');
  });

  it('keeps the last good preview on errors, ignores stale answers, clears the error on the next success', async () => {
    const { result, rerender } = renderHook(({ options }) => usePreview('ed1', options, { maxEdge: 900 }), { wrapper, initialProps: { options: { v: 1 } as unknown } });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    calls[0]?.resolve(ok(1, 'good'));
    await flush();

    rerender({ options: { v: 2 } });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    calls[1]?.resolve({ ok: false, seq: 2, error: { code: 'INVALID_OPTIONS', message: 'bad', retryable: false } });
    await flush();
    expect(result.current.preview?.url).toBe('good');
    expect(result.current.error?.code).toBe('INVALID_OPTIONS');

    rerender({ options: { v: 3 } });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    rerender({ options: { v: 4 } });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    // Main answers the superseded request as stale: no error shown for it.
    calls[2]?.resolve({ ok: false, seq: 3, stale: true, error: { code: 'CANCELLED', message: 'Superseded', retryable: false } });
    await flush();
    expect(result.current.error?.code).toBe('INVALID_OPTIONS');
    calls[3]?.resolve(ok(4, 'better'));
    await flush();
    expect(result.current.preview?.url).toBe('better');
    expect(result.current.error).toBeNull();
  });

  it('turns IPC rejections into error codes (preload "CODE: message" format)', async () => {
    const { result } = renderHook(() => usePreview('ed1', { v: 1 }, { maxEdge: 900 }), { wrapper });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    calls[0]?.reject(new Error('TIMEOUT: preview took too long'));
    await flush();
    expect(result.current.error?.code).toBe('TIMEOUT');
    expect(result.current.pending).toBe(false);
  });

  it('makes no request for null options and clamps maxEdge to 64–2400', async () => {
    const { rerender } = renderHook(({ options, edge }) => usePreview('ed1', options, { maxEdge: edge }), { wrapper, initialProps: { options: null as unknown, edge: 9000 } });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 3);
    });
    expect(calls).toHaveLength(0);
    rerender({ options: { v: 1 }, edge: 9000 });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    expect(calls[0]?.request.maxEdge).toBe(2400);
  });

  it('ignores responses after unmount', async () => {
    const { result, unmount } = renderHook(() => usePreview('ed1', { v: 1 }, { maxEdge: 900 }), { wrapper });
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    });
    const before = result.current;
    unmount();
    calls[0]?.resolve(ok(1, 'late'));
    await flush();
    expect(result.current).toBe(before);
  });
});
