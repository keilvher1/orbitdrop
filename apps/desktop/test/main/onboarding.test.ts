import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, WINDOWS_TOOLS_MODIFIERS, defaultSettingsFor, type Settings } from '@orbitdrop/contracts';
import { runOnboarding, type MoveToApplications, type OnboardingDeps } from '../../src/main/onboarding';
import { existingFileDefaults, firstRunSettings, localeFromSystemLanguages } from '../../src/main/settings/defaults';
import { SettingsStore } from '../../src/main/settings/store';
import { validateModifierCombos, comboWarnings } from '../../src/renderer/src/views/settings/settingsValidation';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-onboarding-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readSettingsFile = async (): Promise<Settings> => JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as Settings;

describe('first-run language', () => {
  it('Korean → ko, any other language → en; an unknown list keeps Korean', () => {
    expect(localeFromSystemLanguages(['ko-KR', 'en-US'])).toBe('ko');
    expect(localeFromSystemLanguages(['ko'])).toBe('ko');
    expect(localeFromSystemLanguages(['ko_KR'])).toBe('ko');
    expect(localeFromSystemLanguages(['KO-kr'])).toBe('ko');
    expect(localeFromSystemLanguages(['en-US', 'ko-KR'])).toBe('en'); // the most preferred language decides
    expect(localeFromSystemLanguages(['ja-JP'])).toBe('en');
    expect(localeFromSystemLanguages(['kok-IN'])).toBe('en'); // Konkani, not Korean
    expect(localeFromSystemLanguages([])).toBe('ko');
    expect(localeFromSystemLanguages(['', '  '])).toBe('ko');
  });
});

describe('platform defaults', () => {
  it('Windows: Ctrl+Shift opens the tools wheel; macOS keeps Option+Shift', () => {
    expect(defaultSettingsFor('win32').globalDrag.toolsModifiers).toEqual(['control', 'shift']);
    expect(defaultSettingsFor('win32').globalDrag.convertModifiers).toEqual(['shift']);
    expect(defaultSettingsFor('darwin')).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.globalDrag.toolsModifiers).toEqual(['alt', 'shift']);
  });

  it("the Windows default passes Settings' own validation without a warning (Alt+Shift would warn)", () => {
    const win = defaultSettingsFor('win32').globalDrag;
    expect(validateModifierCombos(win.convertModifiers, win.toolsModifiers, 'win32')).toEqual({ convert: null, tools: null, valid: true });
    expect(comboWarnings(win.toolsModifiers, 'win32')).toEqual([]);
    expect(comboWarnings(win.convertModifiers, 'win32')).toEqual([]);
    expect(comboWarnings(['alt', 'shift'], 'win32')).toEqual(['altShift']);
    expect([...WINDOWS_TOOLS_MODIFIERS]).toEqual(['control', 'shift']);
  });

  it('first run: platform defaults in the OS language, the welcome still to show', () => {
    expect(firstRunSettings('win32', ['en-US'])).toEqual({ ...defaultSettingsFor('win32'), locale: 'en' });
    expect(firstRunSettings('darwin', ['ko-KR']).onboarding).toEqual({ welcomeDone: false, moveToApplicationsAsked: false });
    expect(existingFileDefaults('darwin').onboarding.welcomeDone).toBe(true);
  });
});

describe('SettingsStore first run', () => {
  it('no file: the OS language and the Windows combo, nothing written until the first change', async () => {
    const store = new SettingsStore(dir, undefined, 'win32', { systemLanguages: () => ['en-GB', 'ko-KR'] });
    const settings = await store.load();
    expect(store.firstRun).toBe(true);
    expect(settings.locale).toBe('en');
    expect(settings.globalDrag.toolsModifiers).toEqual(['control', 'shift']);
    expect(settings.onboarding.welcomeDone).toBe(false);
    expect(await readdir(dir)).toEqual([]);
    // The first change (closing the welcome window) writes the whole file, language included.
    await store.update({ onboarding: { welcomeDone: true } });
    expect(await readSettingsFile()).toMatchObject({ locale: 'en', globalDrag: { toolsModifiers: ['control', 'shift'] }, onboarding: { welcomeDone: true } });
    // A later run keeps that language even if the OS language changed.
    const later = new SettingsStore(dir, undefined, 'win32', { systemLanguages: () => ['ko-KR'] });
    expect((await later.load()).locale).toBe('en');
    expect(later.firstRun).toBe(false);
  });

  it('a system-language lookup that throws keeps Korean', async () => {
    const store = new SettingsStore(dir, undefined, 'darwin', {
      systemLanguages: () => {
        throw new Error('not ready');
      },
    });
    expect((await store.load()).locale).toBe('ko');
  });

  it('a file from before the welcome existed belongs to an existing user: no welcome, its locale and combos kept', async () => {
    const { onboarding: _new, ...old } = { ...DEFAULT_SETTINGS, locale: 'en' as const, globalDrag: { ...DEFAULT_SETTINGS.globalDrag, toolsModifiers: ['alt', 'shift'] as Settings['globalDrag']['toolsModifiers'] } };
    await writeFile(join(dir, 'settings.json'), JSON.stringify(old));
    const store = new SettingsStore(dir, undefined, 'win32', { systemLanguages: () => ['ko-KR'] });
    const settings = await store.load();
    expect(store.firstRun).toBe(false);
    expect(settings.locale).toBe('en'); // existing files keep their locale
    expect(settings.globalDrag.toolsModifiers).toEqual(['alt', 'shift']); // a stored combo is the user's
    expect(settings.onboarding).toEqual({ welcomeDone: true, moveToApplicationsAsked: false });
    expect((await readSettingsFile()).onboarding).toEqual({ welcomeDone: true, moveToApplicationsAsked: false }); // migrated once
  });

  it('a file written on a first run before the welcome was closed still shows it next time', async () => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, launchAtLogin: true }));
    const settings = await new SettingsStore(dir, undefined, 'darwin').load();
    expect(settings.onboarding.welcomeDone).toBe(false);
    expect(settings.launchAtLogin).toBe(true);
  });

  it('a stored Windows file without combos gets the Windows defaults, an invalid drag section too', async () => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, locale: 'ko', globalDrag: { enabled: false } }));
    const partial = await new SettingsStore(dir, undefined, 'win32').load();
    expect(partial.globalDrag).toEqual({ ...defaultSettingsFor('win32').globalDrag, enabled: false });
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, globalDrag: { wheelDiameter: 1 } }));
    expect((await new SettingsStore(dir, undefined, 'win32').load()).globalDrag).toEqual(defaultSettingsFor('win32').globalDrag);
  });
});

describe('SettingsStore reset (Settings › General)', () => {
  it("back to this computer's defaults; language and first-run state stay; listeners hear it", async () => {
    const store = new SettingsStore(dir, undefined, 'win32', { systemLanguages: () => ['ko-KR'] });
    await store.load();
    await store.update({ locale: 'en', launchAtLogin: true, pdf: { dpi: 150 }, globalDrag: { toolsModifiers: ['alt'] }, onboarding: { welcomeDone: true } });
    const seen: Settings[] = [];
    store.onChange((next) => seen.push(next));
    const reset = await store.reset();
    expect(reset).toEqual({ ...defaultSettingsFor('win32'), locale: 'en', onboarding: { welcomeDone: true, moveToApplicationsAsked: false } });
    expect(reset.launchAtLogin).toBe(false); // the login item goes away (app.ts follows the change)
    expect(seen).toHaveLength(1);
    expect(await readSettingsFile()).toEqual(reset);
    // Nothing to reset: no event, no write.
    await store.reset();
    expect(seen).toHaveLength(1);
  });
});

function deps(overrides: Partial<OnboardingDeps> & { initial?: Partial<Settings['onboarding']> } = {}) {
  let settings: Settings = { ...DEFAULT_SETTINGS, onboarding: { ...DEFAULT_SETTINGS.onboarding, ...overrides.initial } };
  const order: string[] = [];
  const update = vi.fn(async (patch: { onboarding?: Partial<Settings['onboarding']> }) => {
    order.push(`update:${JSON.stringify(patch)}`);
    settings = { ...settings, onboarding: { ...settings.onboarding, ...patch.onboarding } };
    return settings;
  });
  const openWelcome = vi.fn(() => {
    order.push('welcome');
  });
  const { initial: _initial, ...rest } = overrides;
  const value: OnboardingDeps = {
    settings: { get: () => settings, update },
    automated: false,
    moveToApplications: null,
    openWelcome,
    ...rest,
  };
  return { value, update, openWelcome, order, settings: () => settings };
}

function mover(answer: boolean, result: boolean | Error = true, needed = true): MoveToApplications & { ask: ReturnType<typeof vi.fn>; move: ReturnType<typeof vi.fn> } {
  return {
    needed: () => needed,
    ask: vi.fn(async () => answer),
    move: vi.fn(() => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

describe('first-run flow', () => {
  it('shows the welcome window until it was closed once', async () => {
    const first = deps();
    expect(await runOnboarding(first.value)).toBe('welcome');
    expect(first.openWelcome).toHaveBeenCalledTimes(1);
    const seen = deps({ initial: { welcomeDone: true } });
    expect(await runOnboarding(seen.value)).toBe('none');
    expect(seen.openWelcome).not.toHaveBeenCalled();
  });

  it('automation (E2E, smoke test) never shows first-run UI', async () => {
    const offer = mover(true);
    const run = deps({ automated: true, moveToApplications: offer });
    expect(await runOnboarding(run.value)).toBe('none');
    expect(run.openWelcome).not.toHaveBeenCalled();
    expect(offer.ask).not.toHaveBeenCalled();
  });

  it('macOS outside Applications: asks once (stored before asking); 나중에 → the welcome window', async () => {
    const offer = mover(false);
    const run = deps({ moveToApplications: offer });
    expect(await runOnboarding(run.value)).toBe('welcome');
    expect(run.order).toEqual(['update:{"onboarding":{"moveToApplicationsAsked":true}}', 'welcome']);
    expect(offer.move).not.toHaveBeenCalled();
    // Next launch: not asked again.
    const again = deps({ moveToApplications: offer, initial: run.settings().onboarding });
    await runOnboarding(again.value);
    expect(offer.ask).toHaveBeenCalledTimes(1);
  });

  it('이동: the app moves and relaunches from Applications (the welcome comes from there)', async () => {
    const offer = mover(true, true);
    const run = deps({ moveToApplications: offer });
    expect(await runOnboarding(run.value)).toBe('moved');
    expect(offer.move).toHaveBeenCalledTimes(1);
    expect(run.openWelcome).not.toHaveBeenCalled();
  });

  it('a move that is cancelled or fails continues with the welcome window', async () => {
    for (const result of [false, new Error('copy failed')]) {
      const run = deps({ moveToApplications: mover(true, result) });
      expect(await runOnboarding(run.value)).toBe('welcome');
    }
  });

  it('already in Applications: nothing to ask', async () => {
    const offer = mover(true, true, false);
    const run = deps({ moveToApplications: offer });
    expect(await runOnboarding(run.value)).toBe('welcome');
    expect(offer.ask).not.toHaveBeenCalled();
    expect(run.update).not.toHaveBeenCalled();
  });
});
