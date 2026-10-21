import type { WindowContext } from '@orbitdrop/contracts';
import { DropZoneView } from '../views/dropzone/DropZoneView';
import { EditorView } from '../views/editor/EditorView';
import { JobsView } from '../views/jobs/JobsView';
import { PickerView } from '../views/picker/PickerView';
import { AboutView } from '../views/settings/AboutView';
import { SettingsView } from '../views/settings/SettingsView';
import { useT } from './env';
import { ErrorBoundary } from './ErrorBoundary';
import { ViewError } from './ViewState';

/** Picks the view for this window from main's WindowContext. */
export function App({ context }: { readonly context: WindowContext }) {
  const t = useT();
  return (
    <ErrorBoundary fallback={(error) => <ViewError title={t('shell.loadFailed')} detail={error.message} />}>
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
    default:
      return <ViewError title={t('shell.unknownWindow')} />;
  }
}
