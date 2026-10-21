import {
  RETRY_ELSEWHERE_CODES,
  TERMINAL_JOB_STATES,
  actionTitle,
  inputKindOf,
  type ErrorCode,
  type InputKind,
  type JobSnapshot,
  type JobWarning,
  type Locale,
  type WarningCode,
} from '@orbitdrop/contracts';
import { errorText, type MainStringKey, type Translate } from './i18n';
import type { JobManager, JobRecordView } from './jobs/manager';
import { silentLogger, type Logger } from './log';

/**
 * System notifications for jobs started from a global drag (no window is
 * open then). One notification per drop: a batch is summarized once all of
 * its jobs finished. Clicking a clean success reveals the output; clicking a
 * failure or a result with a warning opens the jobs window, which explains it.
 * Controlled by settings.notifications.
 *
 * The text follows what really happened: a job that finished with a warning
 * (e.g. a compressed file that did not get smaller) is never announced as a
 * plain "Done", and files skipped because they already had the target format
 * are not counted as done.
 */

export interface NotificationRequest {
  readonly title: string;
  readonly body: string;
  readonly onClick: () => void;
}

export interface NotifierDeps {
  readonly show: (request: NotificationRequest) => void;
  readonly enabled: () => boolean;
  readonly locale: () => Locale;
  readonly t: Translate;
  readonly jobs: Pick<JobManager, 'batch'>;
  readonly revealOutput: (outputId: string) => void;
  readonly openJobs: () => void;
  readonly log?: Logger;
}

/**
 * Warnings that only describe the documented behaviour of the action (its
 * title already says so, e.g. "DOCX (image embedded, no OCR)"; conversions drop
 * metadata by default). The others mean "look at the result".
 */
const INFORMATIONAL_WARNINGS: ReadonlySet<WarningCode> = new Set<WarningCode>(['METADATA_REMOVED', 'DOCX_TEXT_ONLY', 'DOCX_IMAGE_ONLY', 'SKIPPED_SAME_FORMAT']);

/** Warnings worth the user's attention (see INFORMATIONAL_WARNINGS). */
export function noteworthyWarnings(warnings: readonly JobWarning[]): JobWarning[] {
  return warnings.filter((warning) => !INFORMATIONAL_WARNINGS.has(warning.code));
}

/** A job main completed without running because the file already had the target format. */
export function isSkippedJob(job: Pick<JobSnapshot, 'state' | 'warnings' | 'outputs'>): boolean {
  return job.state === 'completed' && job.outputs.length === 0 && job.warnings.some((warning) => warning.code === 'SKIPPED_SAME_FORMAT');
}

/** Input kinds of a job (titles depend on them: image → DOCX embeds pictures, PDF → DOCX extracts text). */
export function inputKinds(view: Pick<JobRecordView, 'spec'>): InputKind[] {
  const kinds = new Set<InputKind>();
  for (const input of view.spec.inputs) {
    const kind = inputKindOf(input.format);
    if (kind !== undefined) kinds.add(kind);
  }
  return [...kinds];
}

/**
 * A global-drag job that could not write its output where the files are
 * (read-only folder, disk full, path too long…): the case the Jobs window's
 * "save to another folder" solves, and the one nobody sees when notifications
 * are off or not allowed.
 */
export function needsAnotherFolder(view: Pick<JobRecordView, 'spec' | 'snapshot'>): boolean {
  const { snapshot } = view;
  return view.spec.origin.source === 'globalDrag' && snapshot.state === 'failed' && snapshot.error !== null && RETRY_ELSEWHERE_CODES.has(snapshot.error.code);
}

/** Short notification text per noteworthy warning (main.json; the keys are checked at compile time). */
const WARNING_TEXT: Partial<Readonly<Record<WarningCode, MainStringKey>>> = {
  OUTPUT_LARGER_THAN_INPUT: 'notify.warning.OUTPUT_LARGER_THAN_INPUT',
  EXTENSION_MISMATCH: 'notify.warning.EXTENSION_MISMATCH',
  ALPHA_FLATTENED: 'notify.warning.ALPHA_FLATTENED',
  DOWNSCALED: 'notify.warning.DOWNSCALED',
  PDF_PAGES_WITHOUT_TEXT: 'notify.warning.PDF_PAGES_WITHOUT_TEXT',
  ANNOTATION_FONT_FALLBACK: 'notify.warning.ANNOTATION_FONT_FALLBACK',
};

export class Notifier {
  private readonly notifiedBatches = new Set<string>();
  private readonly log: Logger;

  constructor(private readonly deps: NotifierDeps) {
    this.log = deps.log ?? silentLogger;
  }

  onJobSettled(view: JobRecordView): void {
    if (view.spec.origin.source !== 'globalDrag' || !this.deps.enabled()) return;
    const locale = this.deps.locale();
    const action = actionTitle(view.snapshot.actionId, inputKinds(view))[locale];
    const { t } = this.deps;

    if (view.batchId) {
      const batch = this.deps.jobs.batch(view.batchId);
      if (batch.some((job) => !TERMINAL_JOB_STATES.has(job.snapshot.state))) return;
      if (this.notifiedBatches.has(view.batchId)) return;
      this.notifiedBatches.add(view.batchId);
      if (this.notifiedBatches.size > 500) this.notifiedBatches.clear();
      this.notifyBatch(batch, locale);
      return;
    }

    const { snapshot } = view;
    if (snapshot.state === 'completed') {
      if (isSkippedJob(snapshot)) {
        this.show(t('notify.skipped.title', { action }), t('notify.skipped.body', { name: snapshot.inputName }), () => this.deps.openJobs());
        return;
      }
      const output = snapshot.outputs[0];
      const name = output ? (snapshot.outputs.length > 1 ? t('tray.recentMore', { name: output.name, n: snapshot.outputs.length - 1 }) : output.name) : snapshot.inputName;
      const warning = noteworthyWarnings(snapshot.warnings)[0];
      const warningText = warning === undefined ? null : this.warningText(warning.code);
      if (warning !== undefined) {
        // Never a plain "Done" when the result needs a look (e.g. not smaller than the original).
        const body = warningText === null ? name : t('notify.withWarning.body', { name, warning: warningText });
        this.show(t('notify.doneWarning.title', { action }), body, () => this.deps.openJobs());
        return;
      }
      this.show(t('notify.done.title', { action }), t('notify.done.body', { name }), () =>
        output ? this.deps.revealOutput(output.outputId) : this.deps.openJobs(),
      );
    } else if (snapshot.state === 'failed') {
      const reason = errorText(locale, snapshot.error?.code ?? 'INTERNAL');
      this.show(t('notify.failed.title', { action }), t('notify.failed.body', { name: snapshot.inputName, reason }), () => this.deps.openJobs());
    }
  }

  /** A drop that could not become a job (unsupported file, engine missing, …). */
  rejected(code: ErrorCode): void {
    if (!this.deps.enabled()) return;
    const reason = errorText(this.deps.locale(), code);
    this.show(this.deps.t('notify.rejected.title'), this.deps.t('notify.rejected.body', { reason }), () => this.deps.openJobs());
  }

  /** One notification for a whole drop: done / skipped / failed / with warnings, counted separately. */
  private notifyBatch(batch: readonly JobRecordView[], locale: Locale): void {
    const { t } = this.deps;
    const kinds = new Set<InputKind>(batch.flatMap((job) => inputKinds(job)));
    const first = batch[0];
    if (first === undefined) return;
    const action = actionTitle(first.snapshot.actionId, [...kinds])[locale];
    const skipped = batch.filter((job) => isSkippedJob(job.snapshot));
    const done = batch.filter((job) => job.snapshot.state === 'completed' && !isSkippedJob(job.snapshot));
    const failed = batch.filter((job) => job.snapshot.state === 'failed');
    const warned = done.filter((job) => noteworthyWarnings(job.snapshot.warnings).length > 0);
    if (done.length + failed.length + skipped.length === 0) return; // all cancelled by the user

    const parts: string[] = [];
    if (done.length > 0) parts.push(t('notify.count.done', { count: done.length }));
    if (warned.length > 0) parts.push(t('notify.count.warned', { count: warned.length }));
    if (failed.length > 0) parts.push(t('notify.count.failed', { count: failed.length }));
    if (skipped.length > 0) parts.push(t('notify.count.skipped', { count: skipped.length }));
    const body = parts.join(', ');

    if (failed.length > 0) {
      this.show(t(done.length > 0 ? 'notify.partial.title' : 'notify.failed.title', { action }), body, () => this.deps.openJobs());
    } else if (warned.length > 0) {
      this.show(t('notify.doneWarning.title', { action }), body, () => this.deps.openJobs());
    } else if (done.length === 0) {
      this.show(t('notify.skipped.title', { action }), body, () => this.deps.openJobs());
    } else {
      const firstOutput = done.flatMap((job) => job.snapshot.outputs)[0];
      const summary = skipped.length === 0 ? t('notify.batchDone.body', { count: done.length }) : body;
      this.show(t('notify.done.title', { action }), summary, () => (firstOutput ? this.deps.revealOutput(firstOutput.outputId) : this.deps.openJobs()));
    }
  }

  private warningText(code: WarningCode): string | null {
    const key = WARNING_TEXT[code];
    return key === undefined ? null : this.deps.t(key);
  }

  private show(title: string, body: string, onClick: () => void): void {
    try {
      this.deps.show({ title, body, onClick });
    } catch {
      this.log.warn('notification failed');
    }
  }
}
