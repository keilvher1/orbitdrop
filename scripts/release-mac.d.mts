// Types for scripts/release-mac.mjs (used by the TypeScript tests in tests/integration).
import type { GitHubRelease, Runner } from './release-lib.mjs';

export const MAC_ARCHS: readonly string[];
export function expandHome(path: string | undefined): string | undefined;
export function preflight(options: {
  tag: string | undefined;
  env: Record<string, string | undefined>;
  run: Runner;
  root?: string;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
}): { tag: string; version: string; prerelease: boolean; commit: string };
export function macReleaseFiles(version: string): string[];
export function verifyMacRelease(options: { dir?: string; version: string; commit?: string | null; run: Runner; appChecks?: boolean }): Promise<string[]>;
export function uploadMacRelease(options: { tag: string; version: string; prerelease: boolean; dir?: string; run: Runner; workDir: string }): Promise<{ release: GitHubRelease; uploaded: string[]; sums: number }>;
