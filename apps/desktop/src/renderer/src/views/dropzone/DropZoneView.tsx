import { type FileSelection, type OrbitErrorInfo } from '@orbitdrop/contracts';
import { ArrowDownToLine, ChevronLeft, FolderOpen } from 'lucide-react';
import { useCallback, useRef, useState, type DragEvent } from 'react';
import { useEnv } from '../../app/env';
import { useEscapeKey } from '../../app/useEscapeKey';
import { useWindowFit } from '../../app/useWindowFit';
import { Notice, Spinner } from '../../components/Notice';
import { TitleBar } from '../../components/TitleBar';
import { SelectionWheel, UnsupportedSelection } from '../picker/SelectionWheel';
import './dropzone.css';
import { asErrorInfo } from '../../app/errors';

type DropState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'registering' }
  | { readonly kind: 'choose'; readonly selection: FileSelection }
  | { readonly kind: 'unsupported'; readonly selection: FileSelection };

type Status =
  | { readonly kind: 'started' }
  | { readonly kind: 'editor' }
  | { readonly kind: 'notFiles' }
  | { readonly kind: 'error'; readonly error: OrbitErrorInfo }
  | null;

export function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Small always-on-top drop target (fallback when global drag is unavailable).
 * HTML5 drop → orbit.registerDroppedFiles (paths are resolved in preload and
 * validated in main) → inline wheel → submitAction.
 */
export function DropZoneView() {
  const { orbit, t, settings } = useEnv();
  const [state, setState] = useState<DropState>({ kind: 'idle' });
  const [status, setStatus] = useState<Status>(null);
  const [dragOver, setDragOver] = useState(false);
  const depth = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  useWindowFit(rootRef);

  const reset = useCallback(() => setState({ kind: 'idle' }), []);
  useEscapeKey(reset, state.kind === 'choose' || state.kind === 'unsupported');

  const accept = useCallback((selection: FileSelection) => {
    setStatus(null);
    setState(selection.menuKey === null ? { kind: 'unsupported', selection } : { kind: 'choose', selection });
  }, []);

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = hasFiles(event) ? 'copy' : 'none';
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragOver(false);
  };
  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    depth.current = 0;
    setDragOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) {
      setStatus({ kind: 'notFiles' });
      return;
    }
    setStatus(null);
    setState({ kind: 'registering' });
    try {
      accept(await orbit.registerDroppedFiles(files));
    } catch (reason) {
      setState({ kind: 'idle' });
      setStatus({ kind: 'error', error: asErrorInfo(reason) });
    }
  };

  const openFiles = async () => {
    try {
      const selection = await orbit.openFileDialog();
      if (selection !== null) accept(selection);
    } catch (reason) {
      setStatus({ kind: 'error', error: asErrorInfo(reason) });
    }
  };

  const choosing = state.kind === 'choose' || state.kind === 'unsupported';
  const diameter = Math.min(settings.globalDrag.wheelDiameter, 340);
  const width = choosing ? diameter + 48 : 280;

  return (
    <div
      className="view dropzone-view"
      ref={rootRef}
      style={{ width }}
      data-drag-over={dragOver}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(event) => void onDrop(event)}
    >
      <TitleBar title={t('dropzone.title')} />
      <div className="dropzone-body">
        {choosing ? (
          <>
            <button type="button" className="btn btn-ghost btn-small dropzone-back" onClick={reset}>
              <ChevronLeft size={14} aria-hidden="true" />
              {t('dropzone.back')}
            </button>
            {state.kind === 'choose' ? (
              <SelectionWheel
                key={state.selection.selectionId}
                selection={state.selection}
                initialMode="convert"
                diameter={diameter}
                onEscape={reset}
                onSubmitted={(result) => {
                  setState({ kind: 'idle' });
                  setStatus(result.kind === 'jobs' ? { kind: 'started' } : { kind: 'editor' });
                }}
              />
            ) : (
              <UnsupportedSelection selection={state.selection} />
            )}
          </>
        ) : (
          <>
            <div className="drop-area" data-active={dragOver} role="group" aria-label={t('dropzone.areaLabel')} aria-busy={state.kind === 'registering' || undefined}>
              {state.kind === 'registering' ? (
                <>
                  <Spinner size={22} />
                  <span className="drop-title">{t('dropzone.registering')}</span>
                </>
              ) : (
                <>
                  <ArrowDownToLine size={30} strokeWidth={2} aria-hidden="true" className="drop-icon" />
                  <span className="drop-title">{dragOver ? t('dropzone.release') : t('dropzone.prompt')}</span>
                  <span className="drop-sub">{t('dropzone.promptSub')}</span>
                </>
              )}
            </div>
            <button type="button" className="btn dropzone-open" onClick={() => void openFiles()} disabled={state.kind === 'registering'}>
              <FolderOpen size={15} aria-hidden="true" />
              {t('dropzone.open')}
            </button>
            <StatusLine status={status} onShowJobs={() => void orbit.openWindow('jobs')} onDismiss={() => setStatus(null)} />
          </>
        )}
      </div>
    </div>
  );
}

function StatusLine({ status, onShowJobs, onDismiss }: { readonly status: Status; readonly onShowJobs: () => void; readonly onDismiss: () => void }) {
  const { t } = useEnv();
  if (status === null) return <div className="dropzone-status" />;
  switch (status.kind) {
    case 'started':
      return (
        <Notice tone="success" onDismiss={onDismiss} dismissLabel={t('common.dismiss')}>
          {t('dropzone.started')}{' '}
          <button type="button" className="link-button" onClick={onShowJobs}>
            {t('dropzone.showJobs')}
          </button>
        </Notice>
      );
    case 'editor':
      return (
        <Notice tone="info" onDismiss={onDismiss} dismissLabel={t('common.dismiss')}>
          {t('dropzone.editorOpened')}
        </Notice>
      );
    case 'notFiles':
      return (
        <Notice tone="warning" onDismiss={onDismiss} dismissLabel={t('common.dismiss')}>
          {t('dropzone.notFiles')}
        </Notice>
      );
    case 'error':
      return (
        <Notice tone="danger" onDismiss={onDismiss} dismissLabel={t('common.dismiss')}>
          {t.error(status.error)}
        </Notice>
      );
    default:
      return null;
  }
}
