import {
  ANALYSIS_LIMITS,
  ANALYSIS_MODEL,
  ANTHROPIC_KEYS_URL,
  isAllowedExternalUrl,
  isPlausibleAnalysisKey,
  normalizeAnalysisKey,
  type AnalysisStatus,
  type OrbitErrorInfo,
  type Settings,
  type SettingsPatch,
} from '@orbitdrop/contracts';
import { ExternalLink } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useEnv } from '../../app/env';
import { asErrorInfo } from '../../app/errors';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Notice, Spinner, type NoticeTone } from '../../components/Notice';
import './analysis.css';

/**
 * Settings › Claude 분석 (opt-in, bring your own key). Turning it on, what is sent and what it costs,
 * the API key (saved encrypted by main — this page only ever learns "saved · …abcd"), "연결 확인",
 * the optional standing request and the model. The key typed here lives in this component's state
 * until it is saved, then the field is emptied; it is never shown again.
 */
export interface AnalysisPanelProps {
  readonly settings: Settings;
  readonly apply: (patch: SettingsPatch) => void;
}

type Busy = 'save' | 'delete' | 'test' | null;

export function AnalysisPanel({ settings, apply }: AnalysisPanelProps) {
  const { orbit, t } = useEnv();
  const enabled = settings.analysis.enabled;
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [statusError, setStatusError] = useState<OrbitErrorInfo | null>(null);
  const [draft, setDraft] = useState('');
  const [formatError, setFormatError] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [result, setResult] = useState<{ readonly tone: NoticeTone; readonly text: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const privacyId = useId();
  const keyTitleId = useId();
  const keyId = useId();
  const keyHintId = useId();
  const keyErrorId = useId();
  const statusId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Main's view (key saved? encryption available?), again whenever analysis is turned on or off.
  useEffect(() => {
    let cancelled = false;
    orbit.getAnalysisStatus().then(
      (next) => {
        if (cancelled) return;
        setStatus(next);
        setStatusError(null);
      },
      (reason: unknown) => {
        if (!cancelled) setStatusError(asErrorInfo(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orbit, enabled]);

  const hasKey = status?.hasKey === true;
  const canEncrypt = status?.encryptionAvailable !== false;

  const settle = (work: Promise<void>, kind: Exclude<Busy, null>) => {
    setBusy(kind);
    setResult(null);
    work
      .catch((reason: unknown) => {
        if (mounted.current) setResult({ tone: 'danger', text: t.error(asErrorInfo(reason)) });
      })
      .finally(() => {
        if (mounted.current) setBusy(null);
      });
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (busy !== null || !canEncrypt || draft.trim() === '') return;
    const key = normalizeAnalysisKey(draft);
    if (!isPlausibleAnalysisKey(key)) {
      // Checked here first: a key that cannot be one never leaves the page.
      setFormatError(true);
      setResult(null);
      keyInputRef.current?.focus();
      return;
    }
    setFormatError(false);
    settle(
      orbit.saveAnalysisKey(key).then((next) => {
        if (!mounted.current) return;
        setStatus(next);
        setDraft('');
        setResult({ tone: 'success', text: t('analysis.key.saved') });
      }),
      'save',
    );
  };

  const test = () => {
    if (busy !== null) return;
    settle(
      orbit.testAnalysisKey().then((outcome) => {
        if (!mounted.current) return;
        setResult(outcome.ok ? { tone: 'success', text: t('analysis.key.testOk') } : { tone: 'danger', text: t.error(outcome.error) });
      }),
      'test',
    );
  };

  const remove = () => {
    setConfirmingDelete(false);
    if (busy !== null) return;
    settle(
      orbit.deleteAnalysisKey().then((next) => {
        if (!mounted.current) return;
        setStatus(next);
        setResult({ tone: 'success', text: t('analysis.key.deleted') });
        keyInputRef.current?.focus({ preventScroll: true });
      }),
      'delete',
    );
  };

  const closeDeleteDialog = () => {
    setConfirmingDelete(false);
    deleteRef.current?.focus({ preventScroll: true });
  };

  const openKeysPage = () => {
    if (!isAllowedExternalUrl(ANTHROPIC_KEYS_URL)) return;
    orbit.openExternal(ANTHROPIC_KEYS_URL).catch((reason: unknown) => setResult({ tone: 'danger', text: t.error(asErrorInfo(reason)) }));
  };

  let keyStatus: string;
  if (status === null) keyStatus = statusError ? t.error(statusError) : t('analysis.key.status.loading');
  else keyStatus = hasKey && status.keyHint !== null ? t('analysis.key.status.saved', { hint: status.keyHint }) : t('analysis.key.status.none');
  const describedBy = [formatError ? keyErrorId : null, keyHintId, statusId].filter(Boolean).join(' ');

  return (
    <div className="settings-group analysis-panel">
      <p className="settings-hint">{t('analysis.intro')}</p>
      <label className="checkbox-row settings-checkbox">
        <input type="checkbox" checked={enabled} onChange={(event) => apply({ analysis: { enabled: event.target.checked } })} />
        <span>{t('analysis.enable')}</span>
      </label>
      {enabled && status !== null ? (
        <Notice tone={status.available ? 'success' : 'info'} live="polite">
          {status.available ? t('analysis.state.ready') : t('analysis.state.needsKey')}
        </Notice>
      ) : null}

      <section className="analysis-section" aria-labelledby={privacyId}>
        <h2 id={privacyId} className="settings-group-title">
          {t('analysis.privacy.title')}
        </h2>
        <ul className="analysis-privacy">
          <li>{t('analysis.privacy.sent')}</li>
          <li>{t('analysis.privacy.billing')}</li>
          <li>{t('analysis.privacy.onDrop')}</li>
          <li>{t('analysis.privacy.key')}</li>
        </ul>
      </section>

      <section className="analysis-section" aria-labelledby={keyTitleId}>
        <h2 id={keyTitleId} className="settings-group-title">
          {t('analysis.key.title')}
        </h2>
        <p id={statusId} className="analysis-key-status" data-saved={hasKey || undefined} role="status" aria-live="polite">
          {keyStatus}
        </p>
        {status !== null && !status.encryptionAvailable ? (
          <Notice tone="warning" live="off">
            {t('analysis.key.noEncryption')}
          </Notice>
        ) : null}
        <form className="analysis-key-form" onSubmit={save} noValidate>
          <label className="settings-label" htmlFor={keyId}>
            {t('analysis.key.label')}
          </label>
          <input
            ref={keyInputRef}
            id={keyId}
            className="text-input analysis-key-input"
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="sk-ant-…"
            maxLength={1024}
            value={draft}
            aria-invalid={formatError || undefined}
            aria-describedby={describedBy}
            onChange={(event) => {
              setDraft(event.target.value);
              if (formatError) setFormatError(false);
            }}
          />
          {formatError ? (
            <p id={keyErrorId} className="field-error">
              {t('analysis.key.error.format')}
            </p>
          ) : null}
          <p id={keyHintId} className="settings-hint">
            {t('analysis.key.hint')}
          </p>
          <div className="settings-actions">
            {/* aria-disabled, not disabled: after a save empties the field, focus stays on the button. */}
            <button type="submit" className="btn btn-small" aria-disabled={draft.trim() === '' || !canEncrypt || busy !== null || undefined}>
              {t('analysis.key.save')}
            </button>
            <button type="button" className="btn btn-small" onClick={test} disabled={!hasKey} aria-disabled={busy !== null || undefined}>
              {t('analysis.key.test')}
            </button>
            <button
              ref={deleteRef}
              type="button"
              className="btn btn-small"
              onClick={() => {
                if (busy === null) setConfirmingDelete(true);
              }}
              disabled={!hasKey}
              aria-disabled={busy !== null || undefined}
            >
              {t('analysis.key.delete')}
            </button>
          </div>
        </form>
        <button type="button" className="btn btn-small analysis-keys-link" onClick={openKeysPage}>
          {t('analysis.key.get')}
          <ExternalLink size={13} aria-hidden="true" />
        </button>
        {busy === 'test' ? (
          <span className="settings-inline settings-hint" role="status">
            <Spinner size={12} /> {t('analysis.key.testing')}
          </span>
        ) : null}
        {result ? (
          <Notice tone={result.tone} onDismiss={() => setResult(null)} dismissLabel={t('common.dismiss')}>
            {result.text}
          </Notice>
        ) : null}
      </section>

      <InstructionField settings={settings} apply={apply} />

      <p className="settings-hint">{t('analysis.model', { model: ANALYSIS_MODEL.name, language: t(`settings.language.${settings.locale}`) })}</p>

      {confirmingDelete ? (
        <ConfirmDialog
          title={t('analysis.deleteConfirm.title')}
          message={t('analysis.deleteConfirm.message')}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('analysis.deleteConfirm.confirm')}
          onCancel={closeDeleteDialog}
          onConfirm={remove}
        />
      ) : null}
    </div>
  );
}

/**
 * The standing request: edited locally (IME composition included), saved 600 ms after the last change,
 * on blur and when the panel closes. A value saved elsewhere replaces the text only while nothing is
 * waiting to be saved.
 */
function InstructionField({ settings, apply }: AnalysisPanelProps) {
  const { t } = useEnv();
  const saved = settings.analysis.instruction;
  const max = ANALYSIS_LIMITS.maxInstructionLength;
  const [draft, setDraft] = useState(saved);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const id = useId();
  const hintId = useId();
  const countId = useId();

  useEffect(() => {
    if (pending.current === null) setDraft(saved);
  }, [saved]);

  const flush = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const value = pending.current;
    pending.current = null;
    if (value !== null && value !== savedRef.current) applyRef.current({ analysis: { instruction: value } });
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  return (
    <div className="settings-field analysis-instruction">
      <label className="settings-label" htmlFor={id}>
        {t('analysis.instruction.label')}
      </label>
      <textarea
        id={id}
        className="text-input analysis-instruction-input"
        rows={3}
        maxLength={max}
        value={draft}
        aria-describedby={`${hintId} ${countId}`}
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          pending.current = value;
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => flushRef.current(), 600);
        }}
        onBlur={() => flush()}
      />
      <p id={hintId} className="settings-hint">
        {t('analysis.instruction.hint')}
      </p>
      <p id={countId} className="settings-hint analysis-count tabular">
        {t('analysis.instruction.count', { count: draft.length, max })}
      </p>
    </div>
  );
}
