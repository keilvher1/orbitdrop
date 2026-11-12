/**
 * Claude analysis ("Claude 분석" / "Analyze with Claude"): an opt-in tool that
 * sends one dropped file to Anthropic's API with the user's own API key and
 * writes the answer as a Markdown report next to the original. Everything else
 * in OrbitDrop stays on the computer; this is the only feature that sends a
 * file anywhere, and only when the user turned it on, saved a key and dropped
 * the file on its sector.
 *
 * The key is never a setting and never part of a job: main keeps it encrypted
 * in its own file (Electron safeStorage) and hands it to the worker next to
 * the job for each attempt (ProcessorCredentials). The renderer only ever sees
 * whether a key is saved and its last four characters.
 */

/** The model every analysis uses. */
export const ANALYSIS_MODEL = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' } as const;

export const ANALYSIS_LIMITS = {
  /** PDFs with more pages are not sent (ANALYSIS_INPUT_TOO_LARGE). */
  maxPdfPages: 100,
  /** PDFs larger than this are not sent (ANALYSIS_INPUT_TOO_LARGE). 30 MiB. */
  maxPdfBytes: 30 * 1024 * 1024,
  /** Images are sent as a copy that fits in this square (long edge, pixels), never enlarged. */
  maxImageEdge: 1568,
  /** The standing request from Settings (characters). */
  maxInstructionLength: 1000,
  /** Output tokens of one report (max_tokens). */
  maxOutputTokens: 16000,
} as const;

/** Where users create an API key (Settings › Claude 분석 opens it in the browser; allowlisted in ALLOWED_WEB_PAGES). */
export const ANTHROPIC_KEYS_URL = 'https://platform.claude.com/settings/keys';

/** Characters an Anthropic API key consists of after its `sk-ant-` prefix. */
const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]+$/;

/** Length bounds of a key OrbitDrop accepts (real keys are about 108 characters). */
export const ANALYSIS_KEY_LENGTH = { min: 32, max: 256 } as const;

/** A pasted key without the whitespace (spaces, line breaks) that often comes along when copying. */
export function normalizeAnalysisKey(raw: string): string {
  return raw.trim();
}

/**
 * Whether `key` looks like an Anthropic API key: `sk-ant-` followed by letters,
 * digits, `-` and `_` only, 32–256 characters in total. Checked in the renderer
 * before sending and again in main before encrypting; the API decides whether
 * it is valid ("연결 확인").
 */
export function isPlausibleAnalysisKey(key: string): boolean {
  return key.length >= ANALYSIS_KEY_LENGTH.min && key.length <= ANALYSIS_KEY_LENGTH.max && KEY_PATTERN.test(key);
}

/** What the renderer may show of a saved key: an ellipsis and its last four characters. */
export function analysisKeyHint(key: string): string {
  return `…${key.slice(-4)}`;
}
