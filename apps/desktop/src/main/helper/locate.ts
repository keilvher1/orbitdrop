import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where the native drag helper lives (docs/architecture.md "Shared paths"):
 *   1. ORBITDROP_HELPER_PATH (explicit override)
 *   2. packaged: <resources>/helper/OrbitDropHelper[.exe] (or an .app bundle on macOS)
 *   3. dev: apps/desktop/resources/helper/<platform>-<arch>/OrbitDropHelper[.exe]
 */

export type HelperSource = 'env' | 'packaged' | 'dev';

export interface HelperLocation {
  readonly path: string;
  readonly source: HelperSource;
}

export interface LocateOptions {
  readonly envPath?: string | undefined;
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export function helperExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'OrbitDropHelper.exe' : 'OrbitDropHelper';
}

export function helperCandidates(options: LocateOptions): HelperLocation[] {
  const name = helperExecutableName(options.platform);
  const bundle = (dir: string): string[] =>
    options.platform === 'darwin' ? [join(dir, name), join(dir, `${name}.app`, 'Contents', 'MacOS', name)] : [join(dir, name)];
  const candidates: HelperLocation[] = [];
  if (options.envPath) candidates.push({ path: options.envPath, source: 'env' });
  if (options.packaged) {
    for (const path of bundle(join(options.resourcesPath, 'helper'))) candidates.push({ path, source: 'packaged' });
  } else {
    const root = join(options.appPath, 'resources', 'helper');
    for (const dir of [`${options.platform}-${options.arch}`, `${options.platform}-universal`]) {
      for (const path of bundle(join(root, dir))) candidates.push({ path, source: 'dev' });
    }
  }
  return candidates;
}

async function isExecutableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function locateHelper(options: LocateOptions): Promise<HelperLocation | null> {
  for (const candidate of helperCandidates(options)) {
    if (await isExecutableFile(candidate.path, options.platform)) return candidate;
  }
  return null;
}
