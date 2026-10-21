import { ACTIONS, TERMINAL_JOB_STATES, type ErrorCode, type Locale } from '@orbitdrop/contracts';
import { errorText, type Translate } from './i18n';
import type { JobManager, JobRecordView } from './jobs/manager';
import { silentLogger, type Logger } from './log';

/**
 * System notifications for jobs started from a global drag (no window is
 * open then). One notification per drop: a batch is summarized once all of
 * its jobs finished. Clicking a success reveals the output, clicking a
 * failure opens the jobs window. Controlled by settings.notifications.
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

export class Notifier {
  private readonly notifiedBatches = new Set<string>();
  private readonly log: Logger;

  constructor(private readonly deps: NotifierDeps) {
    this.log = deps.log ?? silentLogger;
  }

  onJobSettled(view: JobRecordView): void {
    if (view.spec.origin.source !== 'globalDrag' || !this.deps.enabled()) return;
    const locale = this.deps.locale();
    const action = ACTIONS[view.snapshot.actionId].title[locale];
    const { t } = this.deps;

    if (view.batchId) {
      const batch = this.deps.jobs.batch(view.batchId);
      if (batch.some((job) => !TERMINAL_JOB_STATES.has(job.snapshot.state))) return;
      if (this.notifiedBatches.has(view.batchId)) return;
      this.notifiedBatches.add(view.batchId);
      if (this.notifiedBatches.size > 500) this.notifiedBatches.clear();
      const done = batch.filter((job) => job.snapshot.state === 'completed');
      const failed = batch.filter((job) => job.snapshot.state === 'failed');
      if (done.length + failed.length === 0) return; // all cancelled by the user
      const firstOutput = done.flatMap((job) => job.snapshot.outputs)[0];
      if (failed.length === 0) {
        this.show(t('notify.done.title', { action }), t('notify.batchDone.body', { count: done.length }), () =>
          firstOutput ? this.deps.revealOutput(firstOutput.outputId) : this.deps.openJobs(),
        );
      } else {
        this.show(t('notify.partial.title', { action }), t('notify.partial.body', { done: done.length, failed: failed.length }), () => this.deps.openJobs());
      }
      return;
    }

    const { snapshot } = view;
    if (snapshot.state === 'completed') {
      const output = snapshot.outputs[0];
      const name = output ? (snapshot.outputs.length > 1 ? t('tray.recentMore', { name: output.name, n: snapshot.outputs.length - 1 }) : output.name) : snapshot.inputName;
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

  private show(title: string, body: string, onClick: () => void): void {
    try {
      this.deps.show({ title, body, onClick });
    } catch {
      this.log.warn('notification failed');
    }
  }
}
