import { ORBITDROP_NEW_ISSUE, ORBITDROP_WEBSITE, type Locale } from '@orbitdrop/contracts';
import type { Translate } from '../i18n';

/**
 * Help menu targets (tray / menu bar › 도움말). Pure: the URLs are checked
 * against the external-URL allowlist before main opens them.
 */

/** The website in the UI language (Korean is the main site, English under /en/). */
export function websiteUrl(locale: Locale): string {
  return locale === 'en' ? ORBITDROP_WEBSITE.en : ORBITDROP_WEBSITE.ko;
}

/** What a problem report is prefilled with: the app version, OS version and architecture — nothing else. */
export interface IssueEnvironment {
  readonly appVersion: string;
  /** e.g. "macOS 14.8.7", "Windows 10.0.26100". */
  readonly os: string;
  /** e.g. "arm64", "x64 (Rosetta 2)". */
  readonly arch: string;
}

/**
 * A value that may go into the issue form: short, letters/digits/spaces and
 * . _ ( ) + - only — never anything that could be a path or a file name with
 * a folder (no slashes, backslashes, colons or quotes). Anything else becomes "?".
 */
export function issueToken(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 48 && /^[A-Za-z0-9 ._()+-]+$/.test(trimmed) ? trimmed : '?';
}

/**
 * Help › 문제 신고: GitHub's new-issue form with a short title/body template
 * whose only filled-in facts are the app version, OS version and architecture.
 */
export function issueUrl(env: IssueEnvironment, t: Translate): string {
  const body = t('help.issue.body', { version: issueToken(env.appVersion), os: issueToken(env.os), arch: issueToken(env.arch) });
  return `${ORBITDROP_NEW_ISSUE}?title=${encodeURIComponent(t('help.issue.title'))}&body=${encodeURIComponent(body)}`;
}

/** Display name of the OS for reports and diagnostics. */
export function osName(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
}
