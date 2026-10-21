import {
  COMPOSITION_LIMITS,
  WHEEL_DIAMETER_RANGE,
  isAllowedExternalUrl,
  type HelperStatus,
  type ModifierKey,
  type OrbitErrorInfo,
  type Platform,
  type Settings,
  type SettingsPatch,
} from '@orbitdrop/contracts';
import { Accessibility, Gauge, Images, Info, MousePointer2, Settings as SettingsIcon, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useEnv } from '../../app/env';
import { asErrorInfo } from '../../app/errors';
import { useEscapeKey } from '../../app/useEscapeKey';
import { Notice, Spinner, type NoticeTone } from '../../components/Notice';
import { NumberInput } from '../../components/NumberInput';
import { Segmented } from '../../components/Segmented';
import { SliderField } from '../../components/SliderField';
import { TitleBar } from '../../components/TitleBar';
import type { Translator } from '../../i18n/catalog';
import { AboutContent } from './AboutView';
import { WheelSizePreview } from './WheelSizePreview';
import {
  MODIFIER_ORDER,
  comboWarnings,
  isModifierSupported,
  normalizeCombo,
  sameCombo,
  toggleModifier,
  validateIntegerInRange,
  validateModifierCombos,
  type ComboError,
  type ComboWarning,
} from './settingsValidation';
import './settings.css';

type TabId = 'general' | 'output' | 'drag' | 'processing' | 'accessibility' | 'about';

const TABS: readonly { readonly id: TabId; readonly icon: LucideIcon }[] = [
  { id: 'general', icon: SettingsIcon },
  { id: 'output', icon: Images },
  { id: 'drag', icon: MousePointer2 },
  { id: 'processing', icon: Gauge },
  { id: 'accessibility', icon: Accessibility },
  { id: 'about', icon: Info },
];

/** System Settings panes the app may open (all start with an ALLOWED_EXTERNAL_URL_PREFIXES entry). */
export const PERMISSION_URLS: Readonly<Record<'accessibility' | 'inputMonitoring', string>> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
};

type Apply = (patch: SettingsPatch) => void;

/**
 * Settings window. Every control applies immediately through updateSettings;
 * invalid input (equal modifier combos, out-of-range numbers) is never sent.
 */
export function SettingsView() {
  const { orbit, t, settings, updateSettings } = useEnv();
  const [tab, setTab] = useState<TabId>('general');
  const [saveError, setSaveError] = useState<OrbitErrorInfo | null>(null);
  const baseId = useId();
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const close = useCallback(() => orbit.closeWindow(), [orbit]);
  useEscapeKey(close);

  const apply = useCallback<Apply>(
    (patch) => {
      setSaveError(null);
      updateSettings(patch).catch((reason: unknown) => setSaveError(asErrorInfo(reason)));
    },
    [updateSettings],
  );

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((x) => x.id === tab);
    const n = TABS.length;
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (index + 1) % n;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (index - 1 + n) % n;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const id = TABS[next]?.id ?? 'general';
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  const tabId = (id: TabId) => `${baseId}-tab-${id}`;
  const panelId = (id: TabId) => `${baseId}-panel-${id}`;

  return (
    <div className="view settings-view">
      <TitleBar title={t('settings.title')} onClose={close} separated />
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist" aria-orientation="vertical" aria-label={t('settings.sections')} onKeyDown={onTabKeyDown}>
          {TABS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[id] = el;
              }}
              type="button"
              role="tab"
              id={tabId(id)}
              className="settings-tab"
              aria-selected={tab === id}
              aria-controls={panelId(id)}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{t(`settings.tab.${id}`)}</span>
            </button>
          ))}
        </div>
        <div className="settings-panel" role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)} tabIndex={0}>
          {saveError ? (
            <Notice tone="danger" onDismiss={() => setSaveError(null)} dismissLabel={t('common.dismiss')}>
              <strong>{t('settings.saveFailed')}</strong> {t.error(saveError)}
            </Notice>
          ) : null}
          {tab === 'general' ? <GeneralPanel settings={settings} apply={apply} /> : null}
          {tab === 'output' ? <OutputPanel settings={settings} apply={apply} /> : null}
          {tab === 'drag' ? <DragPanel settings={settings} apply={apply} /> : null}
          {tab === 'processing' ? <ProcessingPanel settings={settings} apply={apply} /> : null}
          {tab === 'accessibility' ? <AccessibilityPanel settings={settings} apply={apply} /> : null}
          {tab === 'about' ? <AboutContent /> : null}
        </div>
      </div>
    </div>
  );
}

interface PanelProps {
  readonly settings: Settings;
  readonly apply: Apply;
}

// ------------------------------------------------------------------ building blocks

function SettingsField({ label, htmlFor, hint, children }: { readonly label: string; readonly htmlFor?: string; readonly hint?: string; readonly children: ReactNode }) {
  return (
    <div className="settings-field">
      {htmlFor ? (
        <label className="settings-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="settings-label">{label}</span>
      )}
      {children}
      {hint ? <p className="settings-hint">{hint}</p> : null}
    </div>
  );
}

function CheckboxField({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange: (value: boolean) => void }) {
  return (
    <label className="checkbox-row settings-checkbox">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/**
 * Slider that updates its value live but saves at most every `delay` ms (and on unmount).
 * `onLiveChange` follows the value as shown — every movement, and values saved elsewhere —
 * for live previews that must not wait for the save.
 */
function DebouncedSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onCommit,
  onLiveChange,
  delay = 250,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly unit?: string;
  readonly onCommit: (value: number) => void;
  readonly onLiveChange?: (value: number) => void;
  readonly delay?: number;
}) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const liveRef = useRef(onLiveChange);
  liveRef.current = onLiveChange;

  useEffect(() => {
    if (pending.current !== null) return;
    setLocal(value);
    liveRef.current?.(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (pending.current !== null) commitRef.current(pending.current);
      pending.current = null;
    },
    [],
  );

  const onChange = (next: number) => {
    setLocal(next);
    liveRef.current?.(next);
    pending.current = next;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const latest = pending.current;
      pending.current = null;
      if (latest !== null) commitRef.current(latest);
    }, delay);
  };

  return <SliderField label={label} value={local} min={min} max={max} step={step} unit={unit} onChange={onChange} />;
}

/** Commit a whole number only when it is inside [min, max]. */
function intCommit(min: number, max: number, send: (value: number) => void) {
  return (value: number) => {
    if (validateIntegerInRange(value, min, max) === null) send(value);
  };
}

// ---------------------------------------------------------------------- panels

function GeneralPanel({ settings, apply }: PanelProps) {
  const { t } = useEnv();
  return (
    <div className="settings-group">
      <SettingsField label={t('settings.language')}>
        <Segmented<'ko' | 'en'>
          label={t('settings.language')}
          value={settings.locale}
          onChange={(locale) => apply({ locale })}
          options={[
            { value: 'ko', label: t('settings.language.ko') },
            { value: 'en', label: t('settings.language.en') },
          ]}
        />
      </SettingsField>
      <CheckboxField label={t('settings.launchAtLogin')} checked={settings.launchAtLogin} onChange={(launchAtLogin) => apply({ launchAtLogin })} />
      <CheckboxField label={t('settings.notifications')} checked={settings.notifications} onChange={(notifications) => apply({ notifications })} />
    </div>
  );
}

function OutputPanel({ settings, apply }: PanelProps) {
  const { t } = useEnv();
  const maxEdgeId = useId();
  const { min, max } = COMPOSITION_LIMITS.maxEdge;
  return (
    <div className="settings-group">
      <SettingsField label={t('settings.pdfDpi')}>
        <Segmented<'150' | '300'>
          label={t('settings.pdfDpi')}
          value={settings.pdf.dpi === 150 ? '150' : '300'}
          onChange={(dpi) => apply({ pdf: { dpi: dpi === '150' ? 150 : 300 } })}
          options={[
            { value: '150', label: t('settings.dpi', { dpi: 150 }) },
            { value: '300', label: t('settings.dpi', { dpi: 300 }) },
          ]}
        />
      </SettingsField>
      <SettingsField label={t('settings.location')}>
        <Segmented<'source' | 'ask'>
          label={t('settings.location')}
          value={settings.output.location}
          onChange={(location) => apply({ output: { location } })}
          options={[
            { value: 'source', label: t('settings.location.source') },
            { value: 'ask', label: t('settings.location.ask') },
          ]}
        />
      </SettingsField>
      <div className="settings-sliders">
        <DebouncedSlider label={t('settings.quality.jpeg')} value={settings.output.jpegQuality} min={1} max={100} onCommit={intCommit(1, 100, (jpegQuality) => apply({ output: { jpegQuality } }))} />
        <DebouncedSlider label={t('settings.quality.webp')} value={settings.output.webpQuality} min={1} max={100} onCommit={intCommit(1, 100, (webpQuality) => apply({ output: { webpQuality } }))} />
        <DebouncedSlider label={t('settings.quality.avif')} value={settings.output.avifQuality} min={1} max={100} onCommit={intCommit(1, 100, (avifQuality) => apply({ output: { avifQuality } }))} />
        <DebouncedSlider label={t('settings.quality.heic')} value={settings.output.heicQuality} min={1} max={100} onCommit={intCommit(1, 100, (heicQuality) => apply({ output: { heicQuality } }))} />
      </div>
      <SettingsField label={t('settings.bgMaxEdge')} htmlFor={maxEdgeId} hint={t('settings.numberError', { min, max })}>
        <span className="settings-inline">
          <NumberInput
            id={maxEdgeId}
            value={settings.background.maxEdge}
            min={min}
            max={max}
            step={100}
            onCommit={intCommit(min, max, (maxEdge) => apply({ background: { maxEdge } }))}
          />
          <span className="unit">{t('common.px')}</span>
        </span>
      </SettingsField>
    </div>
  );
}

function modifierLabel(t: Translator, key: ModifierKey, platform: Platform): string {
  if (key === 'shift') return t('settings.key.shift');
  return t(`settings.key.${key}.${platform === 'darwin' ? 'mac' : 'pc'}`);
}

const MAC_GLYPHS: Readonly<Record<ModifierKey, string>> = { shift: '⇧', alt: '⌥', control: '⌃', command: '⌘' };

function ModifierCombos({ settings, apply }: PanelProps) {
  const { t, platform } = useEnv();
  const convert = settings.globalDrag.convertModifiers;
  const tools = settings.globalDrag.toolsModifiers;
  const [draft, setDraft] = useState(() => ({ convert: normalizeCombo(convert), tools: normalizeCombo(tools) }));
  const [announcement, setAnnouncement] = useState('');
  const hintId = useId();
  const macNoteId = useId();
  const winNoteId = useId();
  const savedKey = JSON.stringify([normalizeCombo(convert), normalizeCombo(tools)]);

  // Follow changes saved elsewhere (or our own save coming back).
  useEffect(() => {
    setDraft({ convert: normalizeCombo(convert), tools: normalizeCombo(tools) });
  }, [savedKey]); // savedKey encodes both combos

  const validation = validateModifierCombos(draft.convert, draft.tools, platform);

  const toggle = (field: 'convert' | 'tools', key: ModifierKey) => {
    const next = { ...draft, [field]: toggleModifier(draft[field], key) };
    setDraft(next);
    const result = validateModifierCombos(next.convert, next.tools, platform);
    if (result.valid) {
      setAnnouncement('');
      if (!sameCombo(next.convert, convert) || !sameCombo(next.tools, tools)) {
        apply({ globalDrag: { convertModifiers: next.convert, toolsModifiers: next.tools } });
      }
    } else {
      const error = result[field] ?? result.convert ?? result.tools;
      if (error) setAnnouncement(t(`settings.keys.error.${error}`));
    }
  };

  return (
    <div className="settings-group">
      <p id={hintId} className="settings-hint">
        {t('settings.keysHint')}
      </p>
      {platform === 'darwin' ? (
        <p id={macNoteId} className="settings-hint">
          {t('settings.keysMacNote')}
        </p>
      ) : null}
      {platform === 'win32' ? (
        <p id={winNoteId} className="settings-hint">
          {t('settings.keysWinNote')}
        </p>
      ) : null}
      <ModifierPicker
        field="convert"
        label={t('settings.convertKeys')}
        combo={draft.convert}
        error={validation.convert}
        warnings={comboWarnings(draft.convert, platform)}
        hintId={hintId}
        macNoteId={macNoteId}
        platform={platform}
        onToggle={toggle}
      />
      <ModifierPicker
        field="tools"
        label={t('settings.toolsKeys')}
        combo={draft.tools}
        error={validation.tools}
        warnings={comboWarnings(draft.tools, platform)}
        hintId={hintId}
        macNoteId={macNoteId}
        platform={platform}
        onToggle={toggle}
      />
      <div className="visually-hidden" aria-live="assertive" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}

function ModifierPicker({
  field,
  label,
  combo,
  error,
  warnings,
  hintId,
  macNoteId,
  platform,
  onToggle,
}: {
  readonly field: 'convert' | 'tools';
  readonly label: string;
  readonly combo: readonly ModifierKey[];
  readonly error: ComboError | null;
  /** Works, but collides with an OS shortcut (Windows: Alt+Shift, the Windows key). */
  readonly warnings: readonly ComboWarning[];
  readonly hintId: string;
  readonly macNoteId: string;
  readonly platform: Platform;
  readonly onToggle: (field: 'convert' | 'tools', key: ModifierKey) => void;
}) {
  const { t } = useEnv();
  const labelId = useId();
  const errorId = useId();
  const warningId = useId();
  const describedBy = [error ? errorId : null, warnings.length > 0 ? warningId : null, hintId].filter(Boolean).join(' ');
  return (
    <div className="settings-field">
      <span className="settings-label" id={labelId}>
        {label}
      </span>
      <div className="modifier-group" role="group" aria-labelledby={labelId} aria-describedby={describedBy} data-invalid={error !== null}>
        {MODIFIER_ORDER.map((key) => {
          const pressed = combo.includes(key);
          const supported = isModifierSupported(key, platform);
          // Unsupported keys (Control/Command on macOS) can't be added; one that is
          // already in a saved combo stays enabled so it can be removed.
          const describedByKey = [error ? errorId : null, supported ? null : macNoteId].filter(Boolean).join(' ') || undefined;
          return (
            <button
              key={key}
              type="button"
              className="btn-tool modifier-key"
              aria-pressed={pressed}
              aria-describedby={describedByKey}
              data-unsupported={!supported || undefined}
              disabled={!supported && !pressed}
              title={supported ? undefined : t('settings.keys.error.macUnsupported')}
              onClick={() => onToggle(field, key)}
            >
              {platform === 'darwin' ? (
                <span className="modifier-glyph" aria-hidden="true">
                  {MAC_GLYPHS[key]}
                </span>
              ) : null}
              {modifierLabel(t, key, platform)}
            </button>
          );
        })}
      </div>
      {error ? (
        <p id={errorId} className="field-error">
          {t(`settings.keys.error.${error}`)}
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <p id={warningId} className="field-warning">
          {warnings.map((warning) => t(`settings.keys.warn.${warning}`)).join(' ')}
        </p>
      ) : null}
    </div>
  );
}

function DragPanel({ settings, apply }: PanelProps) {
  const { t } = useEnv();
  // The slider's value as shown (follows every movement; the save is debounced).
  const [liveDiameter, setLiveDiameter] = useState(settings.globalDrag.wheelDiameter);
  return (
    <>
      <div className="settings-group">
        <CheckboxField label={t('settings.globalDrag')} checked={settings.globalDrag.enabled} onChange={(enabled) => apply({ globalDrag: { enabled } })} />
      </div>
      <ModifierCombos settings={settings} apply={apply} />
      <div className="settings-group">
        <div className="settings-sliders">
          <DebouncedSlider
            label={t('settings.wheelDiameter')}
            value={settings.globalDrag.wheelDiameter}
            min={WHEEL_DIAMETER_RANGE.min}
            max={WHEEL_DIAMETER_RANGE.max}
            unit={t('common.px')}
            onLiveChange={setLiveDiameter}
            onCommit={intCommit(WHEEL_DIAMETER_RANGE.min, WHEEL_DIAMETER_RANGE.max, (wheelDiameter) => apply({ globalDrag: { wheelDiameter } }))}
          />
        </div>
        <WheelSizePreview diameter={liveDiameter} />
      </div>
      <HelperStatusPanel />
    </>
  );
}

function HelperStatusPanel() {
  const { orbit, t, platform } = useEnv();
  const [status, setStatus] = useState<HelperStatus | null>(null);
  const [error, setError] = useState<OrbitErrorInfo | null>(null);
  const headingId = useId();

  useEffect(() => {
    let cancelled = false;
    let live = false;
    const unsubscribe = orbit.onHelperStatusChanged((next) => {
      live = true;
      if (!cancelled) setStatus(next);
    });
    orbit.getHelperStatus().then(
      (next) => {
        if (!cancelled && !live) setStatus(next);
      },
      (reason: unknown) => {
        if (!cancelled && !live) setError(asErrorInfo(reason));
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [orbit]);

  const openPane = (url: string) => {
    if (!isAllowedExternalUrl(url)) return;
    orbit.openExternal(url).catch((reason: unknown) => setError(asErrorInfo(reason)));
  };

  let tone: NoticeTone = 'info';
  let message: ReactNode = null;
  let fallback = false;
  let actions: ReactNode = null;

  if (status === null) {
    message = error ? (
      t.error(error)
    ) : (
      <span className="settings-inline">
        <Spinner size={12} /> {t('settings.helper.loading')}
      </span>
    );
    tone = error ? 'danger' : 'info';
  } else {
    switch (status.state) {
      case 'disabled':
        message = t('settings.helper.disabled');
        fallback = true;
        break;
      case 'starting':
        message = (
          <span className="settings-inline">
            <Spinner size={12} /> {t('settings.helper.starting')}
          </span>
        );
        break;
      case 'running':
        if (status.globalDrag) {
          tone = 'success';
          message = t('settings.helper.running', { version: status.helperVersion });
        } else {
          tone = 'warning';
          message = t('settings.helper.noGlobalDrag', { reason: status.reason ?? '—' });
          fallback = true;
        }
        break;
      case 'needsPermission': {
        tone = 'warning';
        const names = status.permissions.map((p) => t(`settings.helper.permission.${p}`));
        message = (
          <>
            <div>{t('settings.helper.needsPermission', { permissions: names.join(', ') })}</div>
            <div className="settings-hint">{t('settings.helper.permissionSteps')}</div>
          </>
        );
        fallback = true;
        if (platform === 'darwin') {
          actions = (
            <div className="settings-actions">
              {status.permissions.map((permission) => (
                <button key={permission} type="button" className="btn btn-small" onClick={() => openPane(PERMISSION_URLS[permission])}>
                  {t('settings.helper.openSettings', { permission: t(`settings.helper.permission.${permission}`) })}
                </button>
              ))}
            </div>
          );
        }
        break;
      }
      case 'unavailable':
        tone = 'warning';
        message = t('settings.helper.unavailable', { reason: status.reason });
        fallback = true;
        break;
      case 'crashed':
        tone = 'danger';
        message = t('settings.helper.crashed', { restarts: status.restarts, reason: status.reason });
        fallback = true;
        break;
      default:
        break;
    }
  }

  return (
    <section className="settings-group" aria-labelledby={headingId}>
      <h2 id={headingId} className="settings-group-title">
        {t('settings.helper')}
      </h2>
      <Notice tone={tone} live="polite">
        {message}
        {fallback ? <div className="settings-hint settings-fallback">{t('settings.helper.fallback')}</div> : null}
        {actions}
      </Notice>
      {status !== null && error ? <Notice tone="danger">{t.error(error)}</Notice> : null}
      {platform === 'darwin' && !(status?.state === 'needsPermission' && status.permissions.includes('inputMonitoring')) ? (
        // Optional permission: global drag works without it, but Esc then closes the wheel only under the pointer.
        <div className="settings-input-monitoring">
          <p className="settings-hint">{t('settings.inputMonitoring.note')}</p>
          <button type="button" className="btn btn-small" onClick={() => openPane(PERMISSION_URLS.inputMonitoring)}>
            {t('settings.helper.openSettings', { permission: t('settings.helper.permission.inputMonitoring') })}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ProcessingPanel({ settings, apply }: PanelProps) {
  const { t } = useEnv();
  const timeoutId = useId();
  return (
    <div className="settings-group">
      <SettingsField label={t('settings.concurrency')}>
        <Segmented<'1' | '2' | '3' | '4'>
          label={t('settings.concurrency')}
          value={String(settings.processing.concurrency) as '1' | '2' | '3' | '4'}
          onChange={(value) => apply({ processing: { concurrency: Number(value) } })}
          options={(['1', '2', '3', '4'] as const).map((value) => ({ value, label: value }))}
        />
      </SettingsField>
      <SettingsField label={t('settings.timeout')} htmlFor={timeoutId} hint={t('settings.numberError', { min: 10, max: 3600 })}>
        <span className="settings-inline">
          <NumberInput
            id={timeoutId}
            value={settings.processing.timeoutSec}
            min={10}
            max={3600}
            step={10}
            onCommit={intCommit(10, 3600, (timeoutSec) => apply({ processing: { timeoutSec } }))}
          />
          <span className="unit">{t('settings.secondsUnit')}</span>
        </span>
      </SettingsField>
    </div>
  );
}

function AccessibilityPanel({ settings, apply }: PanelProps) {
  const { t } = useEnv();
  const choices = (['system', 'on', 'off'] as const).map((value) => ({ value, label: t(`settings.choice.${value}`) }));
  return (
    <div className="settings-group">
      <SettingsField label={t('settings.reduceMotion')}>
        <Segmented<'system' | 'on' | 'off'>
          label={t('settings.reduceMotion')}
          value={settings.accessibility.reduceMotion}
          onChange={(reduceMotion) => apply({ accessibility: { reduceMotion } })}
          options={choices}
        />
      </SettingsField>
      <SettingsField label={t('settings.highContrast')}>
        <Segmented<'system' | 'on' | 'off'>
          label={t('settings.highContrast')}
          value={settings.accessibility.highContrast}
          onChange={(highContrast) => apply({ accessibility: { highContrast } })}
          options={choices}
        />
      </SettingsField>
    </div>
  );
}
