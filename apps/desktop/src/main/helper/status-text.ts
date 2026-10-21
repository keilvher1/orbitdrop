import type { HelperStatus } from '@orbitdrop/contracts';
import type { Translate } from '../i18n';

/**
 * HelperStatus reasons inside main are developer English (logs, smoke test).
 * The renderer shows `reason` as is, so the status sent over IPC carries a
 * localized sentence from main.json instead; the developer text stays in the
 * main log only.
 */

/** Developer reasons main itself produces (matched to pick the localized text). */
export const HELPER_REASON_NOT_FOUND = 'Helper binary not found';
export const HELPER_REASON_DISABLED_FOR_RUN = 'Native helper disabled for this run';

export function localizeHelperStatus(status: HelperStatus, t: Translate): HelperStatus {
  switch (status.state) {
    case 'unavailable':
      return {
        state: 'unavailable',
        reason: t(
          status.reason === HELPER_REASON_NOT_FOUND
            ? 'helper.reason.notFound'
            : status.reason === HELPER_REASON_DISABLED_FOR_RUN
              ? 'helper.reason.disabledForRun'
              : 'helper.reason.unavailable',
        ),
      };
    case 'crashed':
      return { state: 'crashed', restarts: status.restarts, reason: t('helper.reason.crashed', { n: status.restarts }) };
    case 'running':
      if (status.reason === undefined) return status;
      return status.globalDrag
        ? { state: 'running', helperVersion: status.helperVersion, globalDrag: true }
        : { state: 'running', helperVersion: status.helperVersion, globalDrag: false, reason: t('helper.reason.globalDragUnavailable') };
    default:
      return status;
  }
}
