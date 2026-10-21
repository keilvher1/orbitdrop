import { RETRYABLE_ERROR_CODES, isErrorCode, toErrorInfo, type OrbitErrorInfo } from '@orbitdrop/contracts';

const CODED_MESSAGE = /^([A-Z][A-Z_]+):\s*(.*)$/s;

/**
 * Normalise a rejected OrbitApi call. The preload rejects with
 * `Error("<ErrorCode>: <message>")`; recover the code so the UI can show the
 * localized message (error.<CODE>). Anything else becomes INTERNAL.
 */
export function asErrorInfo(reason: unknown): OrbitErrorInfo {
  if (typeof reason === 'object' && reason !== null && 'code' in reason && isErrorCode((reason as { code: unknown }).code)) {
    const info = reason as Partial<OrbitErrorInfo> & { code: OrbitErrorInfo['code'] };
    return { code: info.code, message: info.message ?? info.code, retryable: info.retryable ?? RETRYABLE_ERROR_CODES.has(info.code) };
  }
  if (reason instanceof Error) {
    const match = CODED_MESSAGE.exec(reason.message);
    if (match && isErrorCode(match[1])) {
      return { code: match[1], message: match[2] ?? '', retryable: RETRYABLE_ERROR_CODES.has(match[1]) };
    }
  }
  return toErrorInfo(reason);
}
