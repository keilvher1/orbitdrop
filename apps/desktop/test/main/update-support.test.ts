import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpError } from 'builder-util-runtime';
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider';
import { describe, expect, it } from 'vitest';
import { buildSummary, parseBuildInfo, readBuildInfo, type BuildInfo } from '../../src/main/update/build-info';
import { classifyUpdateError } from '../../src/main/update/errors';
import { updateSupport, type FolderAccess, type UpdateSupportInput } from '../../src/main/update/support';

const DEVELOPER_ID: BuildInfo = { version: '0.2.0', commit: '0123456789abcdef0123456789abcdef01234567', dirty: false, signing: 'developer-id', builtAt: '2026-11-12T09:00:00.000Z' };
const MAC_APP = '/Applications/OrbitDrop.app/Contents/MacOS/OrbitDrop';
const MAC_RESOURCES = '/Applications/OrbitDrop.app/Contents/Resources';
const WIN_EXE = 'C:\\Users\\kim\\AppData\\Local\\Programs\\OrbitDrop\\OrbitDrop.exe';
const WIN_RESOURCES = 'C:\\Users\\kim\\AppData\\Local\\Programs\\OrbitDrop\\resources';

function mac(overrides: Partial<UpdateSupportInput> = {}, access: FolderAccess = 'writable'): UpdateSupportInput {
  return {
    packaged: true,
    smokeTest: false,
    platform: 'darwin',
    buildInfo: DEVELOPER_ID,
    execPath: MAC_APP,
    resourcesPath: MAC_RESOURCES,
    productName: 'OrbitDrop',
    exists: () => true,
    folderAccess: () => access,
    ...overrides,
  };
}

function win(files: readonly string[], overrides: Partial<UpdateSupportInput> = {}): UpdateSupportInput {
  return {
    packaged: true,
    smokeTest: false,
    platform: 'win32',
    buildInfo: { ...DEVELOPER_ID, signing: 'none' },
    execPath: WIN_EXE,
    resourcesPath: WIN_RESOURCES,
    productName: 'OrbitDrop',
    exists: (path) => files.some((name) => path === `${WIN_RESOURCES}\\${name}` || path === `C:\\Users\\kim\\AppData\\Local\\Programs\\OrbitDrop\\${name}`),
    folderAccess: () => 'writable',
    ...overrides,
  };
}

describe('update support', () => {
  it('development runs, the smoke test and Linux never update', () => {
    expect(updateSupport(mac({ packaged: false }))).toEqual({ supported: false, reason: 'development' });
    expect(updateSupport(mac({ smokeTest: true }))).toEqual({ supported: false, reason: 'smokeTest' });
    expect(updateSupport(mac({ packaged: false, smokeTest: true }))).toEqual({ supported: false, reason: 'smokeTest' });
    expect(updateSupport(mac({ platform: 'linux' }))).toEqual({ supported: false, reason: 'platform' });
  });

  it('a package without app-update.yml has no update configuration', () => {
    expect(updateSupport(mac({ exists: (path) => !path.endsWith('app-update.yml') }))).toEqual({ supported: false, reason: 'noUpdateConfig' });
  });

  it('macOS: only a Developer ID signed build that does not run from a read-only place', () => {
    expect(updateSupport(mac())).toEqual({ supported: true });
    expect(updateSupport(mac({ buildInfo: { ...DEVELOPER_ID, signing: 'adhoc' } }))).toEqual({ supported: false, reason: 'notSigned' });
    expect(updateSupport(mac({ buildInfo: null }))).toEqual({ supported: false, reason: 'unknownBuild' });
    // Started from the mounted DMG.
    expect(updateSupport(mac({ execPath: '/Volumes/OrbitDrop 0.2.0/OrbitDrop.app/Contents/MacOS/OrbitDrop' }, 'readOnly'))).toEqual({ supported: false, reason: 'readOnlyLocation' });
    // A quarantined app started where it was downloaded (App Translocation).
    const translocated = '/private/var/folders/xy/T/AppTranslocation/0A1B2C3D/d/OrbitDrop.app/Contents/MacOS/OrbitDrop';
    expect(updateSupport(mac({ execPath: translocated }))).toEqual({ supported: false, reason: 'readOnlyLocation' });
    // /Applications that a standard user cannot write to: macOS asks an administrator, so it stays supported.
    expect(updateSupport(mac({}, 'denied'))).toEqual({ supported: true });
  });

  it('macOS: the folder checked is the one that holds the .app bundle', () => {
    const seen: string[] = [];
    updateSupport(mac({ folderAccess: (dir) => (seen.push(dir), 'writable') }));
    expect(seen).toEqual(['/Applications']);
  });

  it('Windows: an installation made by the installer, signed or not', () => {
    const installed = ['app-update.yml', 'Uninstall OrbitDrop.exe'];
    expect(updateSupport(win(installed))).toEqual({ supported: true });
    expect(updateSupport(win(installed, { buildInfo: { ...DEVELOPER_ID, signing: 'authenticode' } }))).toEqual({ supported: true });
    expect(updateSupport(win(installed, { buildInfo: null }))).toEqual({ supported: true });
    expect(updateSupport(win(['app-update.yml']))).toEqual({ supported: false, reason: 'notInstalled' }); // e.g. win-unpacked
  });
});

describe('build information', () => {
  it('parses what package.mjs writes and refuses anything else', () => {
    expect(parseBuildInfo(JSON.stringify(DEVELOPER_ID))).toEqual(DEVELOPER_ID);
    expect(parseBuildInfo(JSON.stringify({ ...DEVELOPER_ID, commit: null, extra: 1 }))).toMatchObject({ commit: null });
    for (const bad of ['', 'not json', '[]', JSON.stringify({ ...DEVELOPER_ID, signing: 'apple' }), JSON.stringify({ ...DEVELOPER_ID, commit: 'xyz' }), JSON.stringify({ ...DEVELOPER_ID, dirty: 'no' })]) {
      expect(parseBuildInfo(bad), bad).toBeNull();
    }
  });

  it('AppInfo gets the short commit and the signing mode', () => {
    expect(buildSummary(DEVELOPER_ID)).toEqual({ commit: '0123456', dirty: false, signing: 'developer-id' });
    expect(buildSummary({ ...DEVELOPER_ID, commit: null, dirty: true })).toEqual({ commit: null, dirty: true, signing: 'developer-id' });
  });

  it('is read from Resources/build-info.json of a package only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbitdrop-build-info-'));
    try {
      expect(readBuildInfo({ packaged: true, resourcesPath: dir })).toBeNull(); // missing
      writeFileSync(join(dir, 'build-info.json'), JSON.stringify(DEVELOPER_ID));
      expect(readBuildInfo({ packaged: true, resourcesPath: dir })).toEqual(DEVELOPER_ID);
      expect(readBuildInfo({ packaged: false, resourcesPath: dir })).toBeNull(); // development: Electron's own Resources folder
      writeFileSync(join(dir, 'build-info.json'), '{"signing":');
      expect(readBuildInfo({ packaged: true, resourcesPath: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('update error classification', () => {
  const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

  it('tells offline from network trouble and from other failures', () => {
    expect(classifyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('offline');
    expect(classifyUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toBe('offline');
    expect(classifyUpdateError(coded('Unable to find latest version on GitHub (https://github.com/keilvher1/orbitdrop/releases/latest): net::ERR_NAME_NOT_RESOLVED', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'))).toBe('offline');
    expect(classifyUpdateError(new Error('net::ERR_CONNECTION_RESET'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_TIMED_OUT'))).toBe('network');
    expect(classifyUpdateError(Object.assign(new Error('HttpError: 503'), { statusCode: 503 }))).toBe('network');
    expect(classifyUpdateError(Object.assign(new Error('HttpError: 403 rate limit'), { statusCode: 403 }))).toBe('network');
    expect(classifyUpdateError(Object.assign(new Error('HttpError: 404 Not Found'), { statusCode: 404 }))).toBe('failed');
    expect(classifyUpdateError(coded('sha512 checksum mismatch', 'ERR_CHECKSUM_MISMATCH'))).toBe('failed');
    expect(classifyUpdateError('weird')).toBe('failed');
  });

  /** The real GitHub provider of electron-updater, with `releases/latest` answering 404 (only prereleases/drafts exist). */
  async function providerFailure(releaseNotes: string, latest: () => never): Promise<unknown> {
    const feed = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:github.com,2008:Repository/1/v0.2.0-beta.1</id><link rel="alternate" type="text/html" href="https://github.com/keilvher1/orbitdrop/releases/tag/v0.2.0-beta.1"/><title>OrbitDrop 0.2.0-beta.1</title><content type="html">${releaseNotes}</content></entry></feed>`;
    const executor = {
      request: async (options: { path?: string }) => {
        if (options.path?.endsWith('.atom')) return feed;
        if (options.path?.endsWith('/releases/latest')) latest();
        throw new Error(`unexpected request ${options.path}`);
      },
    };
    const updater = { allowPrerelease: false, channel: null, fullChangelog: false, currentVersion: { raw: '0.1.0' } };
    const provider = new GitHubProvider({ provider: 'github', owner: 'keilvher1', repo: 'orbitdrop' }, updater as never, { executor: executor as never, platform: 'darwin', isUseMultipleRangeRequest: false });
    return provider.getLatestVersion().then(
      () => {
        throw new Error('expected the provider to fail');
      },
      (error: unknown) => error,
    );
  }

  it('only prereleases on GitHub (releases/latest 404, as the real provider wraps it): "up to date", whatever the release notes say', async () => {
    const notFound = (): never => {
      throw createHttpError({ statusCode: 404, statusMessage: 'Not Found', headers: {} } as never);
    };
    for (const notes of ['Bug fixes', 'Fixed a timeout when the network changed', 'net::ERR_INTERNET_DISCONNECTED in the notes']) {
      const error = await providerFailure(notes, notFound);
      expect((error as { code?: string }).code).toBe('ERR_UPDATER_INVALID_RELEASE_FEED');
      expect(classifyUpdateError(error), notes).toBe('noRelease');
    }
    // The same request failing for lack of a connection is "offline", not "up to date".
    const offline = await providerFailure('Bug fixes', () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    });
    expect(classifyUpdateError(offline)).toBe('offline');
    const server = await providerFailure('Bug fixes', () => {
      throw createHttpError({ statusCode: 502, statusMessage: 'Bad Gateway', headers: {} } as never);
    });
    expect(classifyUpdateError(server)).not.toBe('noRelease');
  });

  it('nothing published for this OS yet is not an error', () => {
    expect(classifyUpdateError(coded('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'))).toBe('noRelease');
    expect(classifyUpdateError(new Error('No published versions on GitHub'))).toBe('noRelease');
    expect(classifyUpdateError(coded('Cannot find latest-mac.yml in the latest release artifacts', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'))).toBe('noRelease');
    expect(classifyUpdateError(coded('Unable to find latest version on GitHub (…/releases/latest), please ensure a production release exists: HttpError: 404', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'))).toBe('noRelease');
  });
});
