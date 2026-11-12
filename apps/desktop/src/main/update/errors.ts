import type { UpdateErrorKind } from '@orbitdrop/contracts';

/**
 * What a failed check or download means for the user. electron-updater reports Chromium network
 * errors in the message (`net::ERR_…`), HTTP failures as HttpError (statusCode, "404 Not Found …")
 * and its own problems with an `ERR_UPDATER_…` code.
 *  - noRelease: nothing is published that this platform could update to — no release yet, only
 *    prereleases or drafts, or the latest release has no update file for this OS (e.g. the macOS
 *    part of a release that is still being uploaded). Shown as "up to date", logged at info level.
 *  - offline / network / failed: UpdateErrorKind (quiet: About and the log, never a dialog).
 *
 * The GitHub provider wraps every failure of `releases/latest` into ERR_UPDATER_INVALID_RELEASE_FEED
 * and appends the whole Atom feed ("…\nXML:\n<feed>…") — release notes included. Only the text
 * before that is looked at, so words in release notes never change the verdict.
 */
export type UpdateFailure = UpdateErrorKind | 'noRelease';

const OFFLINE = /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED)\b|\b(ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN)\b/;
const NETWORK = /net::ERR_[A-Z_]+|\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EHOSTUNREACH)\b|\bsocket hang up\b|\btimeout\b/i;
const NO_RELEASE_CODES = new Set(['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND']);
/** `releases/latest` answers 404 while nothing but prereleases (or drafts) exists. */
const NO_STABLE_RELEASE = /Unable to find latest version on GitHub[\s\S]*?\b404\b/;
const FEED_MARKER = '\nXML:\n';

function messageOf(error: unknown): string {
  const text = error instanceof Error ? `${error.message}\n${typeof error.stack === 'string' ? error.stack : ''}` : String(error);
  const feed = text.indexOf(FEED_MARKER);
  return feed >= 0 ? text.slice(0, feed) : text;
}

export function classifyUpdateError(error: unknown): UpdateFailure {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  const text = messageOf(error);
  // Network first: the wrapped `releases/latest` errors carry whatever made the request fail.
  if (OFFLINE.test(text)) return 'offline';
  if (NO_RELEASE_CODES.has(code) || /No published versions on GitHub/.test(text)) return 'noRelease';
  if ((code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || code === 'ERR_UPDATER_INVALID_RELEASE_FEED') && NO_STABLE_RELEASE.test(text)) return 'noRelease';
  if (typeof statusCode === 'number') return statusCode === 404 ? 'failed' : 'network';
  if (/\bHttpError: (5\d\d|429|403)\b|status(Code)?[ =:]+(5\d\d|429)\b/.test(text)) return 'network';
  if (NETWORK.test(text)) return 'network';
  return 'failed';
}
