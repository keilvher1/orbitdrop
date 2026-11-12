import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildSummary } from '@orbitdrop/contracts';
import { z } from 'zod';
import { describeError, silentLogger, type Logger } from '../log';

/**
 * Resources/build-info.json: what a package was built from. scripts/package.mjs hands it to the
 * after-pack hook (scripts/after-pack.cjs), which writes it into every package before signing.
 * Development runs (and packages built without package.mjs) have none.
 */
export const BUILD_INFO_FILE = 'build-info.json';

const BuildInfoSchema = z.object({
  version: z.string().min(1).max(64),
  /** Full or short commit, null when the build did not come from a git checkout. */
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .nullable(),
  dirty: z.boolean(),
  signing: z.enum(['developer-id', 'adhoc', 'authenticode', 'none']),
  builtAt: z.string().max(64),
});

export type BuildInfo = z.infer<typeof BuildInfoSchema>;

/** Parse a build-info.json text; null when it is not valid build information. */
export function parseBuildInfo(text: string): BuildInfo | null {
  try {
    const parsed = BuildInfoSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The packaged app's build information, or null: in development runs (never read there — the
 * Resources folder is Electron's own), and when the file is missing or unreadable (logged).
 */
export function readBuildInfo(options: { readonly packaged: boolean; readonly resourcesPath: string; readonly log?: Logger }): BuildInfo | null {
  if (!options.packaged) return null;
  const log = options.log ?? silentLogger;
  let text: string;
  try {
    text = readFileSync(join(options.resourcesPath, BUILD_INFO_FILE), 'utf8');
  } catch (error) {
    log.warn('no build information in this package', { error: describeError(error) });
    return null;
  }
  const info = parseBuildInfo(text);
  if (!info) log.warn('build information is not valid; ignored');
  return info;
}

/** What AppInfo carries: the short commit and how the package was signed. */
export function buildSummary(info: BuildInfo): BuildSummary {
  return { commit: info.commit === null ? null : info.commit.slice(0, 7), dirty: info.dirty, signing: info.signing };
}
