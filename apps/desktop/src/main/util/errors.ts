import type { OrbitErrorInfo } from '@orbitdrop/contracts';
import { scrubPaths } from '../log';

/**
 * Error info as it may leave main (JobSnapshot.error, PreviewOutcome,
 * history.json). Processors put raw sharp/libvips/fs messages — which can
 * contain the input path — into `message`/`detail`; the renderer must never
 * receive absolute paths, so both are scrubbed and bounded here.
 */
export function publicErrorInfo(info: OrbitErrorInfo): OrbitErrorInfo {
  const message = scrubPaths(info.message).slice(0, 500);
  const detail = info.detail === undefined ? undefined : scrubPaths(info.detail).slice(0, 300);
  return { code: info.code, message, ...(detail === undefined ? {} : { detail }), retryable: info.retryable };
}
