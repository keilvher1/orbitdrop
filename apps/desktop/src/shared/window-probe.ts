/**
 * The smoke test's window check (apps/desktop/src/main/smoke.ts): WINDOW_PROBE
 * runs inside the hidden About window's page, judgeWindow (in main) decides
 * whether the renderer really rendered. Shared so the renderer tests can run
 * the probe against the real About view (no imports: both tsconfigs build it).
 */

/** What the window check reads from the page (WINDOW_PROBE). */
export interface WindowProbe {
  readonly preload: boolean;
  /** Text of an error the page shows instead of its view (bootstrap's FatalError, ViewError, a danger notice). */
  readonly failure: string | null;
  readonly view: boolean;
  /** Text of the About view's version line. */
  readonly version: string | null;
  readonly stylesheets: number;
  readonly stylesheetsLoaded: number;
}

/** Runs in the page (main world): what the window shows. */
export const WINDOW_PROBE = `(() => {
  const failure = document.querySelector('.view-error, .notice[data-tone="danger"]');
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  return {
    preload: typeof window.orbit === 'object' && window.orbit !== null,
    failure: failure ? (failure.textContent || '').trim().slice(0, 300) : null,
    view: document.querySelector('.about-view') !== null,
    version: document.querySelector('.about-view .about-version')?.textContent ?? null,
    stylesheets: links.length,
    stylesheetsLoaded: links.filter((link) => Boolean(link.sheet)).length,
  };
})()`;

/**
 * Judges one probe of the About window: `rendered` once it shows the view
 * with the app version (only main knows it: the IPC round trip worked) and
 * every stylesheet loaded; an error the page shows ends the check.
 */
export function judgeWindow(probe: WindowProbe, version: string): { readonly rendered: boolean; readonly error: string | null } {
  if (probe.failure !== null) return { rendered: false, error: `the window shows an error: ${probe.failure}` };
  const rendered = probe.preload && probe.view && probe.version !== null && probe.version.includes(version) && probe.stylesheetsLoaded === probe.stylesheets;
  return { rendered, error: null };
}

export function describeProbe(probe: WindowProbe | null): string {
  if (!probe) return 'page not readable';
  return `preload ${probe.preload}, view ${probe.view}, version ${JSON.stringify(probe.version)}, stylesheets ${probe.stylesheetsLoaded}/${probe.stylesheets}`;
}
