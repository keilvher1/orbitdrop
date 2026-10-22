// @vitest-environment jsdom
import './setup';
import type { OrbitApi } from '@orbitdrop/contracts';
import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/renderer/src/app/bootstrap';
import { AboutView } from '../../src/renderer/src/views/settings/AboutView';
import { WINDOW_PROBE, judgeWindow, type WindowProbe } from '../../src/shared/window-probe';
import { createFakeOrbit, renderWithEnv } from './helpers';

/**
 * `--smoke-test` (main/smoke.ts) opens the About window hidden and runs
 * WINDOW_PROBE in its page. These tests run the same probe against the real
 * views, so renaming what it looks for fails here — not only when a package
 * is smoke-tested.
 */

const probe = (): WindowProbe => (0, eval)(WINDOW_PROBE) as WindowProbe;
const containers: HTMLElement[] = [];

async function boot(orbit: OrbitApi | undefined): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  await act(async () => {
    await bootstrap(container, orbit);
  });
}

afterEach(() => {
  delete (window as { orbit?: unknown }).orbit;
  for (const container of containers.splice(0)) container.remove();
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) link.remove();
});

describe('smoke test window probe', () => {
  it('counts the About view as rendered once it shows the version main sent', async () => {
    const { orbit } = renderWithEnv(<AboutView />);
    (window as { orbit?: unknown }).orbit = orbit;
    expect(judgeWindow(probe(), '0.1.0')).toEqual({ rendered: false, error: null }); // app info still loading
    await screen.findByText(/0\.1\.0/);
    expect(probe()).toMatchObject({ preload: true, failure: null, view: true, stylesheets: 0, stylesheetsLoaded: 0 });
    expect(judgeWindow(probe(), '0.1.0')).toEqual({ rendered: true, error: null });
    expect(judgeWindow(probe(), '0.2.0').rendered).toBe(false); // not the version this app reports
  });

  it('a page without the preload: bootstrap shows its error and the check fails at once', async () => {
    await boot(undefined);
    const result = probe();
    expect(result.preload).toBe(false);
    const verdict = judgeWindow(result, '0.1.0');
    expect(verdict.rendered).toBe(false);
    expect(verdict.error).toContain('window.orbit is missing');
  });

  it('main refusing the window over IPC (untrusted sender) fails the check', async () => {
    const orbit = createFakeOrbit();
    orbit.getWindowContext.mockRejectedValue(new Error('Untrusted sender'));
    (window as { orbit?: unknown }).orbit = orbit;
    await boot(orbit as unknown as OrbitApi);
    expect(judgeWindow(probe(), '0.1.0').error).toContain('Untrusted sender');
  });

  it('app info that cannot be read (danger notice) fails the check', async () => {
    const orbit = createFakeOrbit();
    orbit.getAppInfo.mockRejectedValue({ code: 'INTERNAL', message: 'boom' });
    renderWithEnv(<AboutView />, { orbit });
    (window as { orbit?: unknown }).orbit = orbit;
    await screen.findByRole('alert');
    expect(judgeWindow(probe(), '0.1.0').error).toMatch(/^the window shows an error: /);
  });

  it('waits until every linked stylesheet has loaded', async () => {
    const { orbit } = renderWithEnv(<AboutView />);
    (window as { orbit?: unknown }).orbit = orbit;
    await screen.findByText(/0\.1\.0/);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = './assets/missing.css';
    document.head.append(link);
    expect(probe()).toMatchObject({ stylesheets: 1, stylesheetsLoaded: 0 });
    expect(judgeWindow(probe(), '0.1.0')).toEqual({ rendered: false, error: null });
  });
});
