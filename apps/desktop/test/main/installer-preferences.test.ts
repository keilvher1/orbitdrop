import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, defaultSettingsFor, type Settings } from '@orbitdrop/contracts';
import type { LogData, Logger } from '../../src/main/log';
import {
  INSTALLER_PREFERENCES_FILE,
  applyInstallerPreferences,
  parseInstallerPreferences,
  readInstallerPreferences,
  type InstallerPreferencesRead,
} from '../../src/main/settings/installer-preferences';
import { SettingsStore } from '../../src/main/settings/store';

/**
 * The Windows installer records the update-check choice (privacy page box, or /NOUPDATECHECK) in
 * installer-preferences.json next to OrbitDrop.exe (apps/desktop/build/installer.nsh); the app applies it
 * on the first run only and never over settings that exist.
 */
let dir: string;
let installDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-installer-prefs-'));
  installDir = join(dir, 'Programs', 'OrbitDrop');
  await mkdir(installDir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Exactly what installer.nsh writes (FileWrite, CRLF). */
const installerFile = (autoCheck: boolean): string => `{"version":1,"updates":{"autoCheck":${autoCheck}}}\r\n`;

function recordingLogger() {
  const lines: { level: string; message: string; data?: LogData }[] = [];
  const at = (level: string) => (message: string, data?: LogData) => lines.push({ level, message, data });
  const log: Logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  return { log, lines };
}

function storeWith(read: () => InstallerPreferencesRead, platform: NodeJS.Platform = 'win32') {
  const { log, lines } = recordingLogger();
  const userData = join(dir, 'AppData', 'Roaming', 'OrbitDrop');
  const store = new SettingsStore(userData, log, platform, { systemLanguages: () => ['ko-KR'], installerPreferences: read });
  return { store, lines, userData };
}

describe('installer-preferences.json', () => {
  it('parses what the installer writes: on, off, and a file naming no choice', () => {
    expect(parseInstallerPreferences(installerFile(false))).toEqual({ kind: 'found', preferences: { autoCheck: false } });
    expect(parseInstallerPreferences(installerFile(true))).toEqual({ kind: 'found', preferences: { autoCheck: true } });
    expect(parseInstallerPreferences('{"version":1}')).toEqual({ kind: 'found', preferences: {} });
    expect(parseInstallerPreferences('﻿{"version":1,"updates":{"autoCheck":false}}')).toEqual({ kind: 'found', preferences: { autoCheck: false } });
    // A later installer may add keys: they are ignored, the known ones still apply.
    expect(parseInstallerPreferences('{"version":1,"updates":{"autoCheck":false,"channel":"beta"},"other":1}')).toEqual({ kind: 'found', preferences: { autoCheck: false } });
  });

  it('refuses anything else instead of guessing', () => {
    for (const text of ['', 'off', '{"updates":{"autoCheck":false}}', '{"version":2,"updates":{"autoCheck":false}}', '{"version":1,"updates":{"autoCheck":"false"}}', '{"version":1,"updates":false}', '[]', 'null']) {
      expect(parseInstallerPreferences(text).kind, text).toBe('invalid');
    }
  });

  it('reads the file next to OrbitDrop.exe; no file, a folder in its place or an oversized file are told apart', async () => {
    expect(readInstallerPreferences(installDir)).toEqual({ kind: 'none' });
    expect(readInstallerPreferences(join(dir, 'missing-folder'))).toEqual({ kind: 'none' });
    await writeFile(join(installDir, INSTALLER_PREFERENCES_FILE), installerFile(false));
    expect(readInstallerPreferences(installDir)).toEqual({ kind: 'found', preferences: { autoCheck: false } });
    await writeFile(join(installDir, INSTALLER_PREFERENCES_FILE), `{"version":1,"updates":{"autoCheck":false}}${' '.repeat(5000)}`);
    expect(readInstallerPreferences(installDir)).toEqual({ kind: 'invalid', reason: expect.stringMatching(/bytes/) });
    await rm(join(installDir, INSTALLER_PREFERENCES_FILE));
    await mkdir(join(installDir, INSTALLER_PREFERENCES_FILE));
    expect(readInstallerPreferences(installDir).kind).toBe('invalid');
  });

  it('only the update check changes, and only when the installer chose something else', () => {
    const win = defaultSettingsFor('win32');
    expect(applyInstallerPreferences(win, { autoCheck: false })).toEqual({ ...win, updates: { autoCheck: false } });
    expect(applyInstallerPreferences(win, { autoCheck: true })).toBe(win);
    expect(applyInstallerPreferences(win, {})).toBe(win);
  });
});

describe('first run after a Windows install', () => {
  it('box unticked (or /NOUPDATECHECK): the app starts with automatic update checks off, says so in the log, writes nothing yet', async () => {
    await writeFile(join(installDir, INSTALLER_PREFERENCES_FILE), installerFile(false));
    const { store, lines, userData } = storeWith(() => readInstallerPreferences(installDir));
    const settings = await store.load();
    expect(store.firstRun).toBe(true);
    expect(settings.updates.autoCheck).toBe(false);
    // Everything else is the ordinary first run: Windows combos, the OS language, the welcome window to show.
    expect(settings).toEqual({ ...defaultSettingsFor('win32'), locale: 'ko', updates: { autoCheck: false } });
    expect(lines).toEqual([{ level: 'info', message: 'first run: automatic update checks off, as chosen in the installer', data: { autoCheck: false } }]);
    // Nothing is written until the first change; then the choice is part of the user's settings.
    await expect(readdir(userData)).rejects.toThrow();
    await store.update({ onboarding: { welcomeDone: true } });
    const saved = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as Settings;
    expect(saved.updates.autoCheck).toBe(false);
  });

  it('box ticked (the default, also /S): checks stay on, and the log says why', async () => {
    await writeFile(join(installDir, INSTALLER_PREFERENCES_FILE), installerFile(true));
    const { store, lines } = storeWith(() => readInstallerPreferences(installDir));
    expect((await store.load()).updates.autoCheck).toBe(true);
    expect(lines).toEqual([{ level: 'info', message: 'first run: automatic update checks on, as chosen in the installer', data: { autoCheck: true } }]);
  });

  it('no file (a copied folder, macOS, development) or an unusable one: the defaults, logged', async () => {
    const none = storeWith(() => readInstallerPreferences(installDir));
    expect((await none.store.load()).updates.autoCheck).toBe(true);
    expect(none.lines).toEqual([{ level: 'info', message: 'first run: no installer preferences; automatic update checks stay on', data: undefined }]);

    await writeFile(join(installDir, INSTALLER_PREFERENCES_FILE), 'autoCheck=false');
    const invalid = storeWith(() => readInstallerPreferences(installDir));
    expect((await invalid.store.load()).updates.autoCheck).toBe(true);
    expect(invalid.lines).toEqual([{ level: 'warn', message: 'first run: installer preferences ignored; automatic update checks stay on', data: { reason: 'not JSON' } }]);

    const throwing = storeWith(() => {
      throw new Error('EPERM');
    });
    expect((await throwing.store.load()).updates.autoCheck).toBe(true);
    expect(throwing.lines.map((l) => l.level)).toEqual(['warn']);
  });

  it('never overrides settings that exist: the file is not even read', async () => {
    let reads = 0;
    const read = (): InstallerPreferencesRead => {
      reads += 1;
      return { kind: 'found', preferences: { autoCheck: false } };
    };
    const { store, userData } = storeWith(read);
    await mkdir(userData, { recursive: true });
    // The user turned the checks on again in Settings after a first run with them off.
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ ...defaultSettingsFor('win32'), updates: { autoCheck: true }, onboarding: { welcomeDone: true, moveToApplicationsAsked: false } }));
    expect((await store.load()).updates.autoCheck).toBe(true);
    expect(store.firstRun).toBe(false);
    expect(reads).toBe(0);

    // An unusable settings file is kept aside: its owner already used OrbitDrop, so that is no first run either.
    await writeFile(join(userData, 'settings.json'), '{ not json');
    const reset = await store.load();
    expect(reset.updates.autoCheck).toBe(DEFAULT_SETTINGS.updates.autoCheck);
    expect(reads).toBe(0);
  });

  it("Settings › General › Reset goes back to this computer's defaults, update checks included", async () => {
    const { store } = storeWith(() => ({ kind: 'found', preferences: { autoCheck: false } }));
    await store.load();
    await store.update({ onboarding: { welcomeDone: true } });
    expect((await store.reset()).updates.autoCheck).toBe(true);
  });
});
