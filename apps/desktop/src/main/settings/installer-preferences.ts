import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '@orbitdrop/contracts';
import { z } from 'zod';

/**
 * What the Windows installer recorded for the app's first run (apps/desktop/build/installer.nsh):
 * `installer-preferences.json` next to OrbitDrop.exe, written by every install —
 *
 *   {"version":1,"updates":{"autoCheck":true}}    (default, also for `/S`)
 *   {"version":1,"updates":{"autoCheck":false}}   (box unticked on the privacy page, or `/NOUPDATECHECK`)
 *
 * The settings store applies it on the first run only (no settings.json yet, settings/store.ts) and
 * never lets it override settings that exist. The file is per installation and removed with it;
 * kept free of Electron imports (tests).
 */
export const INSTALLER_PREFERENCES_FILE = 'installer-preferences.json';

/** Larger files are not something the installer wrote. */
const MAX_BYTES = 4096;

const InstallerPreferencesSchema = z.object({
  version: z.literal(1),
  updates: z.object({ autoCheck: z.boolean() }).partial().optional(),
});

export interface InstallerPreferences {
  /** The automatic update check (settings.updates.autoCheck); undefined = the installer said nothing. */
  readonly autoCheck?: boolean;
}

export type InstallerPreferencesRead =
  /** No file: not installed by the Windows installer (macOS, development, a copied folder). */
  | { readonly kind: 'none' }
  /** A file that is not what the installer writes; ignored. */
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'found'; readonly preferences: InstallerPreferences };

/** Parse the file's text. */
export function parseInstallerPreferences(text: string): InstallerPreferencesRead {
  let raw: unknown;
  try {
    // The installer writes plain ASCII; a byte order mark from a hand edit is tolerated.
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  const parsed = InstallerPreferencesSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid', reason: 'unexpected content' };
  const autoCheck = parsed.data.updates?.autoCheck;
  return { kind: 'found', preferences: autoCheck === undefined ? {} : { autoCheck } };
}

/** Read `installer-preferences.json` in `dir` (the folder of OrbitDrop.exe). Never throws. */
export function readInstallerPreferences(dir: string): InstallerPreferencesRead {
  let fd: number;
  try {
    fd = openSync(join(dir, INSTALLER_PREFERENCES_FILE), 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'none' } : { kind: 'invalid', reason: `unreadable (${code ?? 'error'})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: 'invalid', reason: 'not a file' };
    if (stat.size > MAX_BYTES) return { kind: 'invalid', reason: `${stat.size} bytes` };
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return parseInstallerPreferences(buffer.subarray(0, read).toString('utf8'));
  } catch (error) {
    return { kind: 'invalid', reason: `unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing to do
    }
  }
}

/** First-run settings with the installer's choices applied. */
export function applyInstallerPreferences(settings: Settings, preferences: InstallerPreferences): Settings {
  if (preferences.autoCheck === undefined || preferences.autoCheck === settings.updates.autoCheck) return settings;
  return { ...settings, updates: { ...settings.updates, autoCheck: preferences.autoCheck } };
}
