// @vitest-environment jsdom
import './setup';
import { act } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWindowFit } from '../../src/renderer/src/app/useWindowFit';
import { renderWithEnv } from './helpers';

function Fitted({ loading }: { readonly loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useWindowFit(ref);
  if (loading) return <p>loading</p>;
  return <div ref={ref} data-testid="root" />;
}

function Toggle() {
  const [loading, setLoading] = useState(true);
  (globalThis as { __finishLoading?: () => void }).__finishLoading = () => setLoading(false);
  return <Fitted loading={loading} />;
}

describe('useWindowFit', () => {
  afterEach(() => vi.restoreAllMocks());

  it('measures the element even when it appears only after a loading state', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 407.4, height: 548.2, x: 0, y: 0, top: 0, left: 0, right: 407.4, bottom: 548.2, toJSON: () => ({}) } as DOMRect);
    const { orbit } = renderWithEnv(<Toggle />);
    expect(orbit.resizeWindow).not.toHaveBeenCalled();
    act(() => (globalThis as { __finishLoading?: () => void }).__finishLoading?.());
    expect(orbit.resizeWindow).toHaveBeenCalledWith(408, 549);
  });

  it('a window main made shorter than its content asks for the width its scrollbar takes (no sideways scrolling)', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 520, height: 675, x: 0, y: 0, top: 0, left: 0, right: 520, bottom: 675, toJSON: () => ({}) } as DOMRect);
    const clientWidth = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(520);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(520);
    const { orbit } = renderWithEnv(<Fitted loading={false} />);
    expect(orbit.resizeWindow).toHaveBeenLastCalledWith(520, 675);
    // Main clamped the height to the work area: a 15 px classic scrollbar appears and the window is resized.
    clientWidth.mockReturnValue(505);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(orbit.resizeWindow).toHaveBeenLastCalledWith(535, 675);
  });

  it('clamps to the IPC schema range and skips unmeasured (0×0) elements', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    spy.mockReturnValue({ width: 0, height: 0 } as DOMRect);
    const first = renderWithEnv(<Fitted loading={false} />);
    expect(first.orbit.resizeWindow).not.toHaveBeenCalled();
    first.unmount();
    spy.mockReturnValue({ width: 120, height: 9000 } as DOMRect);
    const second = renderWithEnv(<Fitted loading={false} />);
    expect(second.orbit.resizeWindow).toHaveBeenCalledWith(200, 4000);
  });
});
