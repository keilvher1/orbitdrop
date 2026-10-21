import { type FileSelection, type OrbitErrorInfo, type WheelMode } from '@orbitdrop/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEnv } from '../../app/env';
import { useEscapeKey } from '../../app/useEscapeKey';
import { useWindowFit } from '../../app/useWindowFit';
import { ViewError, ViewLoading } from '../../app/ViewState';
import { TitleBar } from '../../components/TitleBar';
import { SelectionWheel } from './SelectionWheel';
import { asErrorInfo } from '../../app/errors';

export interface PickerViewProps {
  readonly selectionId: string;
  readonly initialMode: WheelMode;
}

/**
 * Window opened for a selection that came from the open dialog or the tray
 * (and as a keyboard-accessible alternative to the native drag wheel). Closes
 * itself once main accepted the action (jobs queued or editor opened).
 */
export function PickerView({ selectionId, initialMode }: PickerViewProps) {
  const { orbit, t, settings } = useEnv();
  const [selection, setSelection] = useState<FileSelection | null>(null);
  const [loadError, setLoadError] = useState<OrbitErrorInfo | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => orbit.closeWindow(), [orbit]);
  useWindowFit(rootRef);
  useEscapeKey(close);

  useEffect(() => {
    let cancelled = false;
    orbit.getSelection(selectionId).then(
      (next) => {
        if (!cancelled) setSelection(next);
      },
      (reason: unknown) => {
        if (!cancelled) setLoadError(asErrorInfo(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orbit, selectionId]);

  if (loadError) return <ViewError title={t('shell.loadFailed')} detail={t.error(loadError)} />;
  if (selection === null) return <ViewLoading label={t('common.loading')} title={t('picker.title')} />;

  const diameter = settings.globalDrag.wheelDiameter;
  return (
    <div className="view picker-view" ref={rootRef} style={{ width: diameter + 48 }}>
      <TitleBar title={t('picker.title')} onClose={close} />
      <div className="picker-body">
        <SelectionWheel selection={selection} initialMode={initialMode} diameter={diameter} onSubmitted={close} onEscape={close} />
      </div>
    </div>
  );
}
