import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppUpdater } from 'electron-updater';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NIL_INSTALLATION_ID, STAGING_ID_HEADER, withoutInstallationId } from '../../src/main/update/privacy';

/**
 * Runs the real electron-updater (the pinned 6.8.12) with a fake app and a fake provider: a check
 * must not create <userData>/.updaterId and must not send `x-user-staging-id`. Fails when an
 * electron-updater upgrade changes the internals privacy.ts relies on.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeApp(userData: string) {
  return {
    version: '0.1.0',
    name: 'OrbitDrop',
    isPackaged: true,
    appUpdateConfigPath: join(userData, 'app-update.yml'),
    userDataPath: userData,
    baseCachePath: userData,
    whenReady: () => Promise.resolve(),
    quit: () => undefined,
    relaunch: () => undefined,
    onQuit: () => undefined,
  };
}

/** A provider that answers the update info without any network. */
function fakeProvider(latest: string) {
  return {
    setRequestHeaders: vi.fn(),
    getLatestVersion: vi.fn(async () => ({ version: latest, files: [{ url: `OrbitDrop-${latest}-mac-arm64.zip`, sha512: 'x' }], path: 'x', sha512: 'x', releaseDate: '2026-11-12T00:00:00.000Z' })),
  };
}

function updaterWith(latest: string, harden: boolean) {
  const userData = mkdtempSync(join(tmpdir(), 'orbitdrop-updater-'));
  dirs.push(userData);
  // AppUpdater's constructor is protected (platform updaters subclass it); the base class is all this needs.
  const Updater = AppUpdater as unknown as new (options: null, app: unknown) => AppUpdater;
  const updater = new Updater(null, fakeApp(userData));
  updater.logger = null;
  updater.autoDownload = false;
  if (harden) withoutInstallationId(updater);
  const provider = fakeProvider(latest);
  (updater as unknown as { clientPromise: Promise<unknown> }).clientPromise = Promise.resolve(provider);
  return { updater, provider, userData };
}

describe('update requests carry no installation id', () => {
  it('electron-updater on its own creates and sends one (the behaviour privacy.ts removes)', async () => {
    const { updater, provider, userData } = updaterWith('0.1.0', false);
    await updater.checkForUpdates();
    expect(existsSync(join(userData, '.updaterId'))).toBe(true);
    expect(provider.setRequestHeaders.mock.calls[0]?.[0]).toHaveProperty(STAGING_ID_HEADER);
  });

  it('with withoutInstallationId: no header, no .updaterId file, and the check still works', async () => {
    const { updater, provider, userData } = updaterWith('0.2.0', true);
    const notAvailable = vi.fn();
    const available = vi.fn();
    updater.on('update-not-available', notAvailable);
    updater.on('update-available', available);
    const result = await updater.checkForUpdates();
    expect(result?.isUpdateAvailable).toBe(true);
    expect(available).toHaveBeenCalledTimes(1);
    expect(provider.setRequestHeaders).toHaveBeenCalledTimes(1);
    expect(provider.setRequestHeaders.mock.calls[0]?.[0]).toEqual({});
    expect(readdirSync(userData)).toEqual([]);
    // Download requests get only electron-updater's own headers too.
    const internals = updater as unknown as { computeRequestHeaders(provider: unknown): Record<string, string>; stagingUserIdPromise: { value: Promise<string> } };
    expect(internals.computeRequestHeaders({ fileExtraDownloadHeaders: null })).toEqual({ accept: '*/*' });
    await expect(internals.stagingUserIdPromise.value).resolves.toBe(NIL_INSTALLATION_ID);
  });

  it('request headers the app sets itself still apply, but can never reintroduce the id', () => {
    const { updater } = updaterWith('0.1.0', true);
    updater.requestHeaders = { 'x-test': '1', [STAGING_ID_HEADER]: 'smuggled' };
    const internals = updater as unknown as { computeFinalHeaders(headers: Record<string, string>): Record<string, string> };
    expect(internals.computeFinalHeaders({ [STAGING_ID_HEADER]: 'abc', accept: '*/*' })).toEqual({ accept: '*/*', 'x-test': '1' });
  });

  it('refuses an updater without the expected internals', () => {
    expect(() => withoutInstallationId({})).toThrow(/internals changed/);
  });
});
