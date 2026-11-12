import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { UpdateUnsupportedReason } from '@orbitdrop/contracts';
import type { BuildInfo } from './build-info';

/**
 * Whether this run can update itself. Decided once at startup, before anything touches the
 * network: an unsupported build never loads electron-updater and makes no request.
 */
export type UpdateSupport = { readonly supported: true } | { readonly supported: false; readonly reason: UpdateUnsupportedReason };

/** What a folder allows; only a read-only file system (EROFS) rules an update out. */
export type FolderAccess = 'writable' | 'readOnly' | 'denied' | 'missing';

export interface UpdateSupportInput {
  readonly packaged: boolean;
  readonly smokeTest: boolean;
  readonly platform: NodeJS.Platform;
  readonly buildInfo: BuildInfo | null;
  /** process.execPath (macOS: …/OrbitDrop.app/Contents/MacOS/OrbitDrop; Windows: …\OrbitDrop.exe). */
  readonly execPath: string;
  /** process.resourcesPath (holds app-update.yml, written by electron-builder). */
  readonly resourcesPath: string;
  /** Windows uninstaller next to the executable: `Uninstall <productName>.exe`. */
  readonly productName: string;
  /** Injected in tests. */
  readonly exists?: (path: string) => boolean;
  readonly folderAccess?: (dir: string) => FolderAccess;
}

export function folderAccess(dir: string): FolderAccess {
  try {
    accessSync(dir, constants.W_OK);
    return 'writable';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EROFS') return 'readOnly';
    if (code === 'ENOENT') return 'missing';
    return 'denied';
  }
}

/** The .app bundle of a macOS executable (Contents/MacOS/<name> → <name>.app). */
export function macAppBundle(execPath: string): string {
  return resolve(execPath, '..', '..', '..');
}

/**
 * Order matters: the smoke test and development runs come first (no file is looked at), then
 * the platform, the update configuration and the platform's own conditions:
 *  - macOS: Squirrel.Mac installs an update only when it is signed like the running app, so the
 *    build must be Developer ID signed (Resources/build-info.json); it replaces the bundle, so the
 *    bundle must not run from a read-only volume (a mounted DMG) or from App Translocation (a
 *    quarantined app started where it was downloaded). A folder the user cannot write to
 *    (/Applications for a standard user) is fine: macOS asks for an administrator.
 *  - Windows: the NSIS installer updates an installation it made itself (its uninstaller sits
 *    next to OrbitDrop.exe); a copied or unpacked folder would get a second installation instead.
 *    Signing does not matter here: an unsigned installation accepts the update the release
 *    lists (sha512 checked); once builds are signed, app-update.yml names the publisher and
 *    electron-updater refuses installers that are not signed by it.
 */
export function updateSupport(input: UpdateSupportInput): UpdateSupport {
  const exists = input.exists ?? existsSync;
  const access = input.folderAccess ?? folderAccess;
  const unsupported = (reason: UpdateUnsupportedReason): UpdateSupport => ({ supported: false, reason });

  if (input.smokeTest) return unsupported('smokeTest');
  if (!input.packaged) return unsupported('development');
  if (input.platform !== 'darwin' && input.platform !== 'win32') return unsupported('platform');
  if (!exists(join(input.resourcesPath, 'app-update.yml'))) return unsupported('noUpdateConfig');

  if (input.platform === 'darwin') {
    if (input.buildInfo === null) return unsupported('unknownBuild');
    if (input.buildInfo.signing !== 'developer-id') return unsupported('notSigned');
    const bundle = macAppBundle(input.execPath);
    if (bundle.includes('/AppTranslocation/') || access(dirname(bundle)) === 'readOnly') return unsupported('readOnlyLocation');
    return { supported: true };
  }

  const uninstaller = join(dirname(input.execPath), `Uninstall ${input.productName}.exe`);
  if (!exists(uninstaller)) return unsupported('notInstalled');
  return { supported: true };
}
