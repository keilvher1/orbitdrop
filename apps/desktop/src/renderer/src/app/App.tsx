import type { WindowContext, WindowNotice } from '@orbitdrop/contracts';
import { DropZoneView } from '../views/dropzone/DropZoneView';
import { EditorView } from '../views/editor/EditorView';
import { JobsView } from '../views/jobs/JobsView';
import { PickerView } from '../views/picker/PickerView';
import { AboutView } from '../views/settings/AboutView';
import { SettingsView } from '../views/settings/SettingsView';
import { WelcomeView } from '../views/welcome/WelcomeView';
import { CrashScreen, WindowNoticeBanner } from './crash';
import { useEnv, useT } from './env';
import { ErrorBoundary } from './ErrorBoundary';
import { reportRendererError } from './reportError';
import { ViewError } from './ViewState';

/**
 * Picks the view for this window from main's WindowContext. A view that
 * crashes is reported to main.log and replaced by a crash screen; a page main
 * reloaded after a crash says so (`notice`, from getWindowNotice), and after a
 * second crash shows only the crash screen.
 */
export function App({ context, notice = null }: { readonly context: WindowContext; readonly notice?: WindowNotice | null }) {
  const { orbit } = useEnv();
  const editor = context.kind === 'editor';
  if (notice?.kind === 'failed') return <CrashScreen variant="failed" editor={editor} unsavedLost={notice.unsavedLost} />;
  return (
    <ErrorBoundary
      onError={(error, info) => reportRendererError(orbit, 'boundary', error, info.componentStack)}
      fallback={(error) => <CrashScreen variant="view" editor={editor} unsavedLost={false} detail={error.message} />}
    >
      {notice?.kind === 'recovered' ? <WindowNoticeBanner notice={notice} editor={editor} /> : null}
      <AppView context={context} />
    </ErrorBoundary>
  );
}

function AppView({ context }: { readonly context: WindowContext }) {
  const t = useT();
  switch (context.kind) {
    case 'picker':
      return <PickerView selectionId={context.selectionId} initialMode={context.initialMode} />;
    case 'editor':
      return <EditorView editorId={context.editorId} />;
    case 'jobs':
      return <JobsView />;
    case 'settings':
      return <SettingsView />;
    case 'dropzone':
      return <DropZoneView />;
    case 'about':
      return <AboutView />;
    case 'welcome':
      return <WelcomeView />;
    default:
      return <ViewError title={t('shell.unknownWindow')} />;
  }
}
