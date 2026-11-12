/**
 * Error codes shared by processors, main and renderer. The renderer maps each
 * code to a localized, user-readable message (locales/*.json → `error.<CODE>`).
 * Messages must never include the content of user documents.
 */
export const ERROR_CODES = [
  'UNSUPPORTED_FORMAT',
  'EXTENSION_MISMATCH',
  'FILE_NOT_FOUND',
  'NOT_A_FILE',
  /** Zero-byte file with a supported extension. */
  'FILE_EMPTY',
  'FILE_TOO_LARGE',
  'IMAGE_TOO_LARGE',
  'TOO_MANY_PAGES',
  'TOO_MANY_FILES',
  'PDF_ENCRYPTED',
  'PDF_CORRUPT',
  'PDF_NO_TEXT',
  'IMAGE_CORRUPT',
  'READ_PERMISSION_DENIED',
  'OUTPUT_DIR_NOT_WRITABLE',
  'OUTPUT_WRITE_FAILED',
  'DISK_FULL',
  'PATH_TOO_LONG',
  'CLOUD_PLACEHOLDER',
  'VIRTUAL_FILE',
  'NETWORK_PATH_FAILED',
  'SYMLINK_LOOP',
  'ENGINE_UNAVAILABLE',
  'INVALID_OPTIONS',
  'CANCELLED',
  'TIMEOUT',
  'WORKER_CRASHED',
  'HELPER_UNAVAILABLE',
  // Claude analysis (opt-in, added later). Messages never contain document content or the key.
  /** Analysis is off in Settings or no API key is saved. */
  'ANALYSIS_NOT_CONFIGURED',
  /** The pasted text is not an Anthropic API key (format check before saving). */
  'ANALYSIS_KEY_INVALID',
  /** The OS cannot encrypt (or decrypt) the key on this computer: it is not saved / cannot be used. */
  'ANALYSIS_KEY_STORAGE_UNAVAILABLE',
  /** The API refused the key (401/403). */
  'ANALYSIS_AUTH_FAILED',
  /** Too many requests or a usage limit (429). */
  'ANALYSIS_RATE_LIMITED',
  /** The file is too large to send: PDFs over ANALYSIS_LIMITS (pages, bytes) or a 413 from the API. */
  'ANALYSIS_INPUT_TOO_LARGE',
  /** No connection, a timeout, or the API is overloaded / failing (5xx, 529). */
  'ANALYSIS_UNAVAILABLE',
  /** Claude declined to analyse the file (stop_reason "refusal"). */
  'ANALYSIS_REFUSED',
  /** Any other API failure, or an answer without text. */
  'ANALYSIS_FAILED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** Error codes for which retrying the same request may succeed. */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'OUTPUT_DIR_NOT_WRITABLE',
  'OUTPUT_WRITE_FAILED',
  'DISK_FULL',
  'NETWORK_PATH_FAILED',
  'CLOUD_PLACEHOLDER',
  'TIMEOUT',
  'WORKER_CRASHED',
  'ANALYSIS_RATE_LIMITED',
  'ANALYSIS_UNAVAILABLE',
]);

/** Serializable error carried across process boundaries. */
export interface OrbitErrorInfo {
  readonly code: ErrorCode;
  /** Developer-facing message in English. Never contains document content. */
  readonly message: string;
  /** Optional technical detail for logs (still no document content). */
  readonly detail?: string;
  readonly retryable: boolean;
}

/** Error thrown inside processors/core; converted to OrbitErrorInfo at process boundaries. */
export class OrbitError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, message: string, options?: { detail?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OrbitError';
    this.code = code;
    this.detail = options?.detail;
  }

  toInfo(): OrbitErrorInfo {
    return {
      code: this.code,
      message: this.message,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      retryable: RETRYABLE_ERROR_CODES.has(this.code),
    };
  }
}

export function toErrorInfo(error: unknown): OrbitErrorInfo {
  if (error instanceof OrbitError) return error.toInfo();
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'CANCELLED', message: 'Cancelled', retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'INTERNAL', message, retryable: false };
}
