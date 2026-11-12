import {
  actionTitle,
  baseMenuOrder,
  type ActionId,
  type InputKind,
  type FileSelection,
  type OrbitErrorInfo,
  type SubmitActionResult,
  type WheelMenu,
  type WheelMode,
  type WheelSector,
} from '@orbitdrop/contracts';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useEnv } from '../../app/env';
import { Notice } from '../../components/Notice';
import { Segmented } from '../../components/Segmented';
import { formatBytes } from '../../i18n/format';
import { Wheel } from '../../wheel/Wheel';
import './picker.css';
import { asErrorInfo } from '../../app/errors';

export interface SelectionWheelProps {
  readonly selection: FileSelection;
  readonly initialMode: WheelMode;
  readonly diameter: number;
  /** Called after main accepted the action (jobs queued or editor opened). */
  readonly onSubmitted: (result: Exclude<SubmitActionResult, { kind: 'rejected' }>) => void;
  readonly onEscape?: () => void;
  readonly autoFocus?: boolean;
}

/** Usable files are those main did not flag with a problem. */
export function usableFiles(selection: FileSelection) {
  return selection.files.filter((f) => f.problem === undefined);
}

/**
 * File summary + wheel + mode toggle (변환 / 도구). The wheel comes before the
 * toggle in the tab order so Tab moves from the wheel to the toggle.
 */
const NO_SECTORS: readonly WheelSector[] = [];

/**
 * Whether Claude analysis is available (enabled in Settings and a key saved): it adds a tools sector,
 * the only one for PDFs and mixed selections. Main decides; asked only while the setting is on.
 */
function useAnalysisAvailable(): boolean {
  const { orbit, settings } = useEnv();
  const enabled = settings.analysis.enabled;
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setAvailable(false);
      return undefined;
    }
    let cancelled = false;
    orbit.getAnalysisStatus().then(
      (status) => {
        if (!cancelled) setAvailable(status.available);
      },
      () => {
        if (!cancelled) setAvailable(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orbit, enabled]);
  return available;
}

export function SelectionWheel({ selection, initialMode, diameter, onSubmitted, onEscape, autoFocus = true }: SelectionWheelProps) {
  const { orbit, t, platform, settings } = useEnv();
  const key = selection.menuKey;
  const analysis = useAnalysisAvailable();
  const toolsAvailable = key !== null && baseMenuOrder(key, 'tools', { analysis }).length > 0;
  const [mode, setMode] = useState<WheelMode>(initialMode === 'tools' && !toolsAvailable ? 'convert' : initialMode);
  // The tools wheel of a PDF exists only while analysis is available: opened on it, it shows up once
  // that is known (unless the user picked a wheel meanwhile); when analysis goes away, back to convert.
  const choseMode = useRef(false);
  useEffect(() => {
    if (mode === 'tools' && !toolsAvailable) setMode('convert');
    else if (mode === 'convert' && initialMode === 'tools' && toolsAvailable && !choseMode.current) setMode('tools');
  }, [mode, initialMode, toolsAvailable]);
  const [menu, setMenu] = useState<WheelMenu | null>(null);
  const [menuError, setMenuError] = useState<OrbitErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<OrbitErrorInfo | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const instructionsId = useId();
  const hintId = useId();
  // A submit that resolves after this view went away (Back in the Drop Zone,
  // another selection) must not report back to the parent.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (key === null) return undefined;
    let cancelled = false;
    setMenu(null);
    setMenuError(null);
    orbit.getMenu(selection.selectionId, mode).then(
      (next) => {
        if (!cancelled) setMenu(next);
      },
      (reason: unknown) => {
        if (!cancelled) setMenuError(asErrorInfo(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orbit, selection.selectionId, key, mode, settings.locale]);

  const usable = useMemo(() => usableFiles(selection), [selection]);
  // Titles depend on what is selected (contracts actionTitle: images → DOCX embed pictures, PDFs give text).
  const kinds = useMemo(() => [...new Set(usable.flatMap((f): InputKind[] => (f.kind === null ? [] : [f.kind])))], [usable]);
  const unusable = selection.files.length - usable.length;
  const totalBytes = usable.reduce((sum, f) => sum + f.bytes, 0);
  const sizeText = formatBytes(totalBytes, t.locale, platform);
  const first = usable[0] ?? selection.files[0];

  const submit = useCallback(
    async (actionId: ActionId) => {
      setBusy(true);
      setError(null);
      try {
        const result = await orbit.submitAction({ selectionId: selection.selectionId, actionId });
        if (!mounted.current) return;
        if (result.kind === 'rejected') {
          setError(result.error);
          setBusy(false);
          return;
        }
        onSubmitted(result);
      } catch (reason) {
        if (!mounted.current) return;
        setError(asErrorInfo(reason));
        setBusy(false);
      }
    },
    [orbit, selection.selectionId, onSubmitted],
  );

  if (key === null) {
    return <UnsupportedSelection selection={selection} />;
  }

  const loading = menu === null && menuError === null;
  const sectors = menu?.sectors ?? NO_SECTORS;
  const activeSector = active === null ? undefined : sectors[active];
  const instructions = t('wheel.instructions');
  let hint = instructions;
  if (activeSector !== undefined) {
    const title = t.text(actionTitle(activeSector.actionId, kinds));
    hint = activeSector.enabled ? title : (activeSector.reason ?? t('wheel.unavailable'));
  } else if (menu !== null && sectors.length === 0) {
    hint = mode === 'tools' ? t('picker.noTools') : t('wheel.empty');
  }

  return (
    <div className="selection-wheel">
      <p className="selection-summary tabular" title={first?.name}>
        {usable.length > 1
          ? t('picker.summaryMulti', { name: first?.name ?? '', more: t.plural('common.moreFiles', usable.length - 1), size: sizeText })
          : t('picker.summary', { name: first?.name ?? '', size: sizeText })}
      </p>
      {unusable > 0 ? (
        <Notice tone="warning" live="off">
          {t.plural('picker.someUnusable', unusable)}
        </Notice>
      ) : null}
      <div className="selection-wheel-stage">
        {/* The wheel stays mounted while its menu (re)loads — mode or language change —
            so focus stays where it is (toggle or wheel) instead of being re-grabbed. */}
        <Wheel
          sectors={sectors}
          diameter={diameter}
          label={mode === 'convert' ? t('wheel.label.convert') : t('wheel.label.tools')}
          centerText={loading ? t('common.loading') : usable.length > 1 ? t.plural('common.files', usable.length) : sizeText}
          onActivate={(sector) => void submit(sector.actionId)}
          onEscape={onEscape}
          onActiveChange={setActive}
          busy={busy}
          autoFocus={autoFocus}
          // The hint line (highlighted action's title or why it is unavailable) also describes the menu.
          describedBy={hint === instructions ? instructionsId : `${instructionsId} ${hintId}`}
        />
      </div>
      <span id={instructionsId} className="visually-hidden">
        {t('wheel.instructions')}
      </span>
      <Segmented<WheelMode>
        label={t('mode.label')}
        size="large"
        value={mode}
        onChange={(next) => {
          choseMode.current = true;
          setError(null);
          setMode(next);
        }}
        options={[
          { value: 'convert', label: t('mode.convert') },
          { value: 'tools', label: t('mode.tools'), disabled: !toolsAvailable },
        ]}
      />
      <p id={hintId} className="selection-hint">
        {hint}
      </p>
      {menuError ? <Notice tone="danger">{t.error(menuError)}</Notice> : null}
      {error ? (
        <Notice tone="danger" onDismiss={() => setError(null)} dismissLabel={t('common.dismiss')}>
          <strong>{t('picker.rejected')}</strong> {t.error(error)}
        </Notice>
      ) : null}
    </div>
  );
}

export function UnsupportedSelection({ selection }: { readonly selection: FileSelection }) {
  const { t } = useEnv();
  return (
    <div className="selection-unsupported">
      <Notice tone="warning">
        <strong>{t('picker.unsupportedTitle')}</strong>
        <div>{t('picker.unsupportedHint')}</div>
      </Notice>
      <ul className="problem-list">
        {selection.files.map((file) => (
          <li key={file.fileId}>
            <span className="problem-name">{file.name}</span>
            <span className="muted">{file.problem ? t.error(file.problem) : t.error('UNSUPPORTED_FORMAT')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
