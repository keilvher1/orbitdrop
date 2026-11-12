// Types for scripts/release-assets.mjs (used by the TypeScript tests in tests/integration).
import type { GitHubRelease, Runner } from './release-lib.mjs';

export function collectAssets(dir: string): Map<string, string>;
export function checkAssets(found: Map<string, string>, version: string): Promise<string[]>;
export function publishDraftAssets(options: { tag: string; dir: string; run: Runner; workDir: string }): Promise<{ release: GitHubRelease; uploaded: string[]; sums: number }>;
