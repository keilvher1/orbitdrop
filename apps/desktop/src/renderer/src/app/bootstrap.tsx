import { DEFAULT_SETTINGS, type Locale, type OrbitApi, type Settings, type WindowContext, type WindowNotice } from '@orbitdrop/contracts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyAppearance, readMediaFlags, resolveAppearance } from '../theme/appearance';
import { ensureTokenStyles } from '../theme/tokensCss';
import { App } from './App';
import { StartupFailure } from './crash';
import { EnvProvider } from './env';
import { reportRendererError } from './reportError';

/**
 * Files dropped anywhere except a real drop target (the Drop Zone) must not
 * make Chromium navigate to file://. Drop targets call preventDefault first;
 * everywhere else the cursor shows "no drop".
 */
export function installDropGuard(target: Window = window): () => void {
  const onDragOver = (event: DragEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
  };
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('drop', onDrop);
  return () => {
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('drop', onDrop);
  };
}

/** Renderer entry used by main.tsx (real OrbitApi) and the dev harness (mock). */
export async function bootstrap(container: HTMLElement, orbit: OrbitApi | undefined): Promise<void> {
  ensureTokenStyles();
  installDropGuard();
  const platform = orbit?.platform ?? 'darwin';
  applyAppearance(document.documentElement, resolveAppearance(DEFAULT_SETTINGS.accessibility, readMediaFlags()), platform);
  const root = createRoot(container);

  if (orbit === undefined) {
    // No preload, so no main to ask: Korean and English, and the window closes itself.
    root.render(<StartupFailure message="window.orbit is missing (preload not loaded)" locale={null} onClose={() => window.close()} />);
    return;
  }

  let context: WindowContext;
  let settings: Settings;
  let notice: WindowNotice | null;
  try {
    [context, settings, notice] = await Promise.all([
      orbit.getWindowContext(),
      orbit.getSettings().catch(() => DEFAULT_SETTINGS),
      // Main reloaded this page after a crash: the view says so (App).
      orbit.getWindowNotice ? orbit.getWindowNotice().catch(() => null) : Promise.resolve(null),
    ]);
  } catch (error) {
    reportRendererError(orbit, 'bootstrap', error);
    const locale: Locale | null = await orbit.getSettings().then(
      (current) => current.locale,
      () => null,
    );
    root.render(
      <StartupFailure
        message={error instanceof Error ? error.message : String(error)}
        locale={locale}
        onClose={() => orbit.closeWindow()}
        {...(orbit.openLogFolder ? { onOpenLogs: () => void orbit.openLogFolder?.().catch(() => undefined) } : {})}
      />,
    );
    return;
  }

  applyAppearance(document.documentElement, resolveAppearance(settings.accessibility, readMediaFlags()), platform);
  document.documentElement.lang = settings.locale;

  root.render(
    <StrictMode>
      <EnvProvider orbit={orbit} initialSettings={settings}>
        <App context={context} notice={notice} />
      </EnvProvider>
    </StrictMode>,
  );
}
