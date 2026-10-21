import { DEFAULT_SETTINGS, type OrbitApi, type Settings, type WindowContext } from '@orbitdrop/contracts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createTranslator } from '../i18n/catalog';
import { applyAppearance, readMediaFlags, resolveAppearance } from '../theme/appearance';
import { ensureTokenStyles } from '../theme/tokensCss';
import { App } from './App';
import { EnvProvider } from './env';

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

function FatalError({ message }: { readonly message: string }) {
  const t = createTranslator('ko');
  const en = createTranslator('en');
  return (
    <div className="view-error" role="alert">
      <strong>{t('shell.loadFailed')}</strong>
      <span className="muted">{en('shell.loadFailed')}</span>
      <code className="muted">{message}</code>
    </div>
  );
}

/** Renderer entry used by main.tsx (real OrbitApi) and the dev harness (mock). */
export async function bootstrap(container: HTMLElement, orbit: OrbitApi | undefined): Promise<void> {
  ensureTokenStyles();
  installDropGuard();
  const platform = orbit?.platform ?? 'darwin';
  applyAppearance(document.documentElement, resolveAppearance(DEFAULT_SETTINGS.accessibility, readMediaFlags()), platform);
  const root = createRoot(container);

  if (orbit === undefined) {
    root.render(<FatalError message="window.orbit is missing (preload not loaded)" />);
    return;
  }

  let context: WindowContext;
  let settings: Settings;
  try {
    [context, settings] = await Promise.all([orbit.getWindowContext(), orbit.getSettings().catch(() => DEFAULT_SETTINGS)]);
  } catch (error) {
    root.render(<FatalError message={error instanceof Error ? error.message : String(error)} />);
    return;
  }

  applyAppearance(document.documentElement, resolveAppearance(settings.accessibility, readMediaFlags()), platform);
  document.documentElement.lang = settings.locale;

  root.render(
    <StrictMode>
      <EnvProvider orbit={orbit} initialSettings={settings}>
        <App context={context} />
      </EnvProvider>
    </StrictMode>,
  );
}
