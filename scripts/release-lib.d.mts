// Types for scripts/release-lib.mjs (used by the TypeScript tests in tests/integration).

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface RunOptions {
  readonly input?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** What the echoed command line shows instead of the arguments (secrets masked). */
  readonly display?: readonly string[];
  readonly quiet?: boolean;
}
export type Runner = (cmd: string, args?: readonly string[], options?: RunOptions) => RunResult;

export interface UpdateFile {
  url: string;
  sha512: string;
  size?: number;
  blockMapSize?: number;
}
export interface UpdateInfo {
  version: string;
  files: UpdateFile[];
  path?: string;
  sha512?: string;
  releaseDate?: string;
  [key: string]: unknown;
}
export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  html_url?: string;
  assets?: { name: string; digest?: string | null }[];
}

export const ROOT: string;
export const RELEASE_DIR: string;
export const REPO: string;
export const SUMS_FILE: string;
export const PRODUCT: string;

export function createRunner(options?: { echo?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }): Runner;
export function must(run: Runner, cmd: string, args: readonly string[], options?: RunOptions): string;
export function parseReleaseTag(tag: string | undefined): { tag: string; version: string; prerelease: boolean };
export function hashFile(file: string, algorithm?: string, encoding?: 'hex' | 'base64'): Promise<string>;
export function sha256File(file: string): Promise<string>;
export function sha512File(file: string): Promise<string>;
export function yaml(): { load(text: string): unknown; dump(value: unknown, options?: object): string };
export function formatSums(entries: Iterable<{ name: string; sha256: string }>): string;
export function parseSums(text: string): Map<string, string>;
export function mergeUpdateInfo(infos: readonly (UpdateInfo | null | undefined)[]): UpdateInfo | null;
export function checkUpdateInfo(info: unknown, dir: string, options: { platform: 'darwin' | 'win32'; version: string; archs?: readonly string[] }): Promise<string[]>;
export function findReleases(options: { tag: string; run: Runner; repo?: string }): GitHubRelease[];
export function findRelease(options: { tag: string; run: Runner; repo?: string }): GitHubRelease | null;
export function ensureDraftRelease(options: { tag: string; title: string; notes: string; prerelease?: boolean; run: Runner; repo?: string; workDir: string; findAttempts?: number; findDelayMs?: number }): GitHubRelease;
export function uploadAssets(options: { tag: string; files: readonly string[]; run: Runner; repo?: string }): void;
export function refreshSha256Sums(options: { tag: string; run: Runner; repo?: string; localHashes?: Map<string, string>; workDir: string }): Promise<{ name: string; sha256: string }[]>;
export function releaseNotes(version: string): string;
