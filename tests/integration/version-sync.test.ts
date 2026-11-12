import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSION_FILES, checkVersions, readVersions, setVersion } from '../../scripts/set-version.mjs';

/**
 * The app and both native helpers must report the same version: diagnostics show the helper's,
 * Windows file properties and code-signing metadata checks read the helper's VERSIONINFO, and the
 * release scripts read apps/desktop/package.json (scripts/set-version.mjs keeps them together).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const temps: string[] = [];

function copyOfVersionFiles(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbitdrop-version-'));
  temps.push(dir);
  for (const rel of Object.values(VERSION_FILES) as string[]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('version sync (scripts/set-version.mjs)', () => {
  it('the repository agrees with apps/desktop/package.json', () => {
    expect(checkVersions(ROOT)).toEqual([]);
  });

  it('sets a release version everywhere and keeps package.json formatting', () => {
    const dir = copyOfVersionFiles();
    const before = readFileSync(join(dir, VERSION_FILES.packageJson), 'utf8');
    expect(setVersion('2.3.4', dir)).toEqual({ packageJson: '2.3.4', swift: '2.3.4', plist: '2.3.4', cmake: '2.3.4', cmakeString: '2.3.4' });
    expect(checkVersions(dir)).toEqual([]);
    const after = readFileSync(join(dir, VERSION_FILES.packageJson), 'utf8');
    expect(after.split('\n').length).toBe(before.split('\n').length);
  });

  it('a prerelease keeps its suffix where it can (package.json, Swift, the helper version string) and numbers elsewhere', () => {
    const dir = copyOfVersionFiles();
    expect(setVersion('1.1.0-beta.2', dir)).toEqual({ packageJson: '1.1.0-beta.2', swift: '1.1.0-beta.2', plist: '1.1.0', cmake: '1.1.0', cmakeString: '1.1.0-beta.2' });
    expect(checkVersions(dir)).toEqual([]);
    // The Windows helper's VERSIONINFO strings come from that variable: ProductVersion = the app's version.
    expect(readFileSync(join(ROOT, 'native', 'windows', 'res', 'OrbitDropHelper.rc.in'), 'utf8')).toMatch(/VALUE "ProductVersion", "@ORBITDROP_VERSION_STRING@"/);
  });

  it('refuses versions the update channels cannot follow and reports drift', () => {
    const dir = copyOfVersionFiles();
    for (const bad of ['1.0', 'v1.0.0', '1.0.0-rc.1', '1.0.0-beta', '']) expect(() => setVersion(bad, dir), bad).toThrow();
    setVersion('3.0.0', dir);
    const pkg = join(dir, VERSION_FILES.packageJson);
    writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"version": "3.0.0"', '"version": "3.0.1"')); // only package.json bumped
    expect(readVersions(dir).packageJson).toBe('3.0.1');
    expect(checkVersions(dir)).toEqual([
      expect.stringContaining('HelperInfo.version "3.0.0", expected "3.0.1"'),
      expect.stringContaining('CFBundleShortVersionString "3.0.0", expected "3.0.1"'),
      expect.stringContaining('project VERSION "3.0.0", expected "3.0.1"'),
      expect.stringContaining('ORBITDROP_VERSION_STRING "3.0.0", expected "3.0.1"'),
    ]);
  });
});
