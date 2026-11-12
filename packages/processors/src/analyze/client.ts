import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  ContentTooLargeError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  type ClientOptions,
} from '@anthropic-ai/sdk';
import { ANALYSIS_MODEL, OrbitError } from '@orbitdrop/contracts';

/**
 * The Anthropic API client of Claude analysis, shared by the worker (tool.analyze, ./index.ts) and
 * main ("연결 확인" in Settings, through the `@orbitdrop/processors/analysis` entry). It imports
 * nothing but the SDK and the contracts, so main can load it without the image and PDF engines.
 *
 * The client is pinned so a key only ever goes to api.anthropic.com and never into a log: the base
 * URL is fixed (ANTHROPIC_BASE_URL in the environment is ignored), the key is passed explicitly (the
 * SDK then looks up no other credential: no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, no profile on
 * disk), and the SDK neither logs (ANTHROPIC_LOG would print request details) nor traces.
 */

/** The only host analysis requests go to. */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';

/** Beta of the server-side refusal fallback (`fallbacks: 'default'`). */
export const ANALYSIS_BETAS = ['server-side-fallback-2026-07-01'] as const;

/** Retries the SDK makes itself for 408/409/429/5xx and connection errors. */
export const ANALYSIS_MAX_RETRIES = 2;

/** "연결 확인" waits at most this long per attempt (the default is 10 minutes, meant for long answers). */
export const KEY_CHECK_TIMEOUT_MS = 15_000;

export interface AnalysisClientOptions {
  /** Transport for tests (a fake `fetch` that answers like the API). Production uses the global fetch. */
  readonly fetch?: ClientOptions['fetch'];
}

export function createAnalysisClient(apiKey: string, options: AnalysisClientOptions = {}): Anthropic {
  return new Anthropic({
    apiKey,
    maxRetries: ANALYSIS_MAX_RETRIES,
    baseURL: ANTHROPIC_API_BASE_URL,
    logLevel: 'off',
    openTelemetry: false,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

/** Typed facts of an API error for the logs (`detail`): status, error type, error code. Never its message. */
function describeApiError(error: APIError): string | undefined {
  const parts = [
    error.status === undefined ? null : `status ${error.status}`,
    error.type === null ? null : error.type,
    error.errorCode === null ? null : error.errorCode,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function withDetail(detail: string | undefined): { detail: string } | undefined {
  return detail === undefined ? undefined : { detail };
}

/**
 * An API error that arrived inside the stream (an SSE `error` event) has no HTTP status: the SDK
 * gives it the typed error `type` from the event, which is mapped like the HTTP statuses.
 */
function errorFromStreamType(error: APIError, detail: string | undefined): OrbitError {
  switch (error.type) {
    case 'authentication_error':
    case 'permission_error':
      return new OrbitError('ANALYSIS_AUTH_FAILED', 'The API refused the key', withDetail(detail));
    case 'rate_limit_error':
      return new OrbitError('ANALYSIS_RATE_LIMITED', 'The API is rate limiting this key', withDetail(detail));
    case 'overloaded_error':
    case 'api_error':
    case 'timeout_error':
      return new OrbitError('ANALYSIS_UNAVAILABLE', 'The API is unavailable', withDetail(detail));
    default:
      return new OrbitError('ANALYSIS_FAILED', 'The API request failed', withDetail(detail));
  }
}

/**
 * SDK failure → OrbitError, by the SDK's typed error classes, most specific first (never by message
 * text). Messages and details carry no document content and never the key: an SDK error message can
 * quote the API's response, so only typed fields (status, error type, error code) go into `detail`.
 */
export function analysisError(error: unknown, signal?: AbortSignal): OrbitError {
  if (error instanceof OrbitError) return error;
  if (error instanceof APIUserAbortError || signal?.aborted === true) return new OrbitError('CANCELLED', 'Cancelled');
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return new OrbitError('ANALYSIS_AUTH_FAILED', 'The API refused the key', withDetail(describeApiError(error)));
  }
  if (error instanceof RateLimitError) {
    return new OrbitError('ANALYSIS_RATE_LIMITED', 'The API is rate limiting this key', withDetail(describeApiError(error)));
  }
  if (error instanceof ContentTooLargeError) {
    return new OrbitError('ANALYSIS_INPUT_TOO_LARGE', 'The request is too large for the API', withDetail(describeApiError(error)));
  }
  if (error instanceof APIConnectionError) {
    // Also APIConnectionTimeoutError (a subclass): no answer from the API.
    return new OrbitError('ANALYSIS_UNAVAILABLE', 'The API could not be reached', { detail: error instanceof APIConnectionTimeoutError ? 'timeout' : 'connection' });
  }
  if (error instanceof InternalServerError) {
    // 5xx, 529 (OverloadedError) included.
    return new OrbitError('ANALYSIS_UNAVAILABLE', 'The API is unavailable', withDetail(describeApiError(error)));
  }
  if (error instanceof APIError) {
    const detail = describeApiError(error);
    if (error.status === undefined) return errorFromStreamType(error, detail);
    if (error.status === 413) return new OrbitError('ANALYSIS_INPUT_TOO_LARGE', 'The request is too large for the API', withDetail(detail));
    if (error.status === 529) return new OrbitError('ANALYSIS_UNAVAILABLE', 'The API is overloaded', withDetail(detail));
    return new OrbitError('ANALYSIS_FAILED', 'The API request failed', withDetail(detail));
  }
  const name = error instanceof Error ? error.name : typeof error;
  return new OrbitError('ANALYSIS_FAILED', 'Claude analysis failed', { detail: name.slice(0, 60) });
}

/**
 * "연결 확인": fetch the model's description with the key — a free request that succeeds only for
 * a key the API accepts. Resolves when it works; throws the mapped OrbitError otherwise.
 */
export async function verifyAnalysisKey(apiKey: string, options: AnalysisClientOptions & { readonly signal?: AbortSignal } = {}): Promise<void> {
  const client = createAnalysisClient(apiKey, options);
  try {
    await client.models.retrieve(ANALYSIS_MODEL.id, {}, { timeout: KEY_CHECK_TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    throw analysisError(error, options.signal);
  }
}
