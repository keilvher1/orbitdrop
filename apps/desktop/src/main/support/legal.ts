import { dirname, join } from 'node:path';
import type { LicenseFile } from '@orbitdrop/contracts';

/**
 * About › 오픈 소스 라이선스: where the licence files shipped with the app
 * are. Packaged (electron-builder.yml): THIRD_PARTY_LICENSES.md in the
 * resources folder; Electron's LICENSE (as LICENSE.electron.txt) and
 * LICENSES.chromium.html in the resources folder on macOS
 * (OrbitDrop.app/Contents/Resources) and next to OrbitDrop.exe on Windows.
 * Development: the repository's THIRD_PARTY_LICENSES.md and Electron's own
 * files in node_modules/electron/dist. The first candidate that exists is opened.
 */
export interface LicenseLocation {
  readonly packaged: boolean;
  /** process.resourcesPath. */
  readonly resourcesPath: string;
  /** app.getAppPath(): apps/desktop in development. */
  readonly appPath: string;
}

export function licenseCandidates(which: LicenseFile, at: LicenseLocation): string[] {
  const repoRoot = join(at.appPath, '..', '..');
  const electronDist = join(repoRoot, 'node_modules', 'electron', 'dist');
  const installDir = dirname(at.resourcesPath);
  switch (which) {
    case 'thirdParty':
      return at.packaged ? [join(at.resourcesPath, 'THIRD_PARTY_LICENSES.md')] : [join(repoRoot, 'THIRD_PARTY_LICENSES.md')];
    case 'electron':
      return at.packaged ? [join(at.resourcesPath, 'LICENSE.electron.txt'), join(installDir, 'LICENSE.electron.txt')] : [join(electronDist, 'LICENSE')];
    case 'chromium':
      return at.packaged ? [join(at.resourcesPath, 'LICENSES.chromium.html'), join(installDir, 'LICENSES.chromium.html')] : [join(electronDist, 'LICENSES.chromium.html')];
  }
}
