import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, type Settings } from '@orbitdrop/contracts';
import { HISTORY_LIMIT, HistoryStore, type HistoryEntry } from '../../src/main/history/store';
import { SettingsStore } from '../../src/main/settings/store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-stores-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readJson = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(dir, name), 'utf8')) as unknown;

/** Defaults after an unusable file was kept aside: its owner already used OrbitDrop, so no welcome window. */
const RESET_DEFAULTS: Settings = { ...DEFAULT_SETTINGS, onboarding: { ...DEFAULT_SETTINGS.onboarding, welcomeDone: true } };

describe('SettingsStore', () => {
  it('uses defaults when there is no file (a first run) and does not create one', async () => {
    const store = new SettingsStore(dir, undefined, 'darwin');
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
    expect(store.firstRun).toBe(true);
    expect(store.get().onboarding.welcomeDone).toBe(false); // the welcome window is still to show
    expect(await readdir(dir)).toEqual([]);
  });

  it('migrates old or partly invalid files section by section and writes the repaired file', async () => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ locale: 'en', globalDrag: { wheelDiameter: 999 }, pdf: { dpi: 150 }, bogus: true }));
    const store = new SettingsStore(dir, undefined, 'darwin');
    const settings = await store.load();
    expect(settings.locale).toBe('en');
    expect(settings.pdf.dpi).toBe(150);
    expect(settings.globalDrag).toEqual(DEFAULT_SETTINGS.globalDrag); // invalid section reset
    expect(await readJson('settings.json')).toEqual(settings);
    expect((settings as Settings & { bogus?: unknown }).bogus).toBeUndefined();
  });

  it('keeps a corrupt file aside and starts from defaults', async () => {
    await writeFile(join(dir, 'settings.json'), '{ not json');
    const store = new SettingsStore(dir, undefined, 'darwin');
    expect(await store.load()).toEqual(RESET_DEFAULTS);
    expect(store.firstRun).toBe(false);
    const names = await readdir(dir);
    const backup = names.find((n) => n.startsWith('settings.corrupt-'));
    expect(backup).toBeDefined();
    expect(await readFile(join(dir, backup!), 'utf8')).toBe('{ not json'); // the original bytes, untouched
    expect(await readJson('settings.json')).toEqual(RESET_DEFAULTS);
    expect(store.loadIssue).toEqual({ reason: 'corrupt', backup }); // the app tells the user
  });

  it('an unreadable settings file (a folder in its place) is kept aside too, never overwritten, never a crash', async () => {
    await mkdir(join(dir, 'settings.json'));
    await writeFile(join(dir, 'settings.json', 'inside.txt'), 'keep me');
    const store = new SettingsStore(dir, undefined, 'darwin');
    expect(await store.load()).toEqual(RESET_DEFAULTS);
    const backup = (await readdir(dir)).find((n) => n.startsWith('settings.unreadable-'));
    expect(store.loadIssue).toEqual({ reason: 'unreadable', backup });
    expect(await readFile(join(dir, backup!, 'inside.txt'), 'utf8')).toBe('keep me');
    expect(await readJson('settings.json')).toEqual(RESET_DEFAULTS);
    await expect(store.update({ locale: 'en' })).resolves.toMatchObject({ locale: 'en' });
    expect(await readJson('settings.json')).toMatchObject({ locale: 'en' });
  });

  it('a file that cannot be moved aside is left alone until a real change is saved', async () => {
    await writeFile(join(dir, 'settings.json'), '{ broken');
    await chmod(dir, 0o555); // folder not writable: neither the move nor a save can happen
    try {
      const store = new SettingsStore(dir, undefined, 'darwin');
      expect(await store.load()).toEqual(RESET_DEFAULTS);
      expect(store.loadIssue).toEqual({ reason: 'corrupt', backup: null });
      expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('{ broken');
      // Saving fails quietly (logged); the app keeps running with the in-memory settings.
      await expect(store.update({ locale: 'en' })).resolves.toMatchObject({ locale: 'en' });
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('JSON that is not a settings object (null, an array, a number) is kept aside like a corrupt file', async () => {
    for (const content of ['null', '[]', '42', '"settings"']) {
      await writeFile(join(dir, 'settings.json'), content);
      const store = new SettingsStore(dir, undefined, 'darwin');
      expect(await store.load(), content).toEqual(RESET_DEFAULTS);
      const backup = (await readdir(dir)).find((n) => n.startsWith('settings.corrupt-'));
      expect(store.loadIssue, content).toEqual({ reason: 'corrupt', backup });
      expect(await readFile(join(dir, backup!), 'utf8'), content).toBe(content);
      await rm(join(dir, backup!));
    }
  });

  it('a valid file reports no load issue', async () => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify(DEFAULT_SETTINGS));
    const store = new SettingsStore(dir);
    await store.load();
    expect(store.loadIssue).toBeNull();
  });

  it('applies valid patches atomically, notifies listeners and rejects invalid patches', async () => {
    const store = new SettingsStore(dir);
    await store.load();
    const changes: [Settings, Settings][] = [];
    store.onChange((next, previous) => changes.push([next, previous]));
    const next = await store.update({ locale: 'en', processing: { concurrency: 3 } });
    expect(next.locale).toBe('en');
    expect(next.processing).toEqual({ concurrency: 3, timeoutSec: DEFAULT_SETTINGS.processing.timeoutSec });
    expect(changes).toHaveLength(1);
    expect(changes[0]![1].locale).toBe('ko');
    expect(await readJson('settings.json')).toMatchObject({ version: SETTINGS_VERSION, locale: 'en' });

    await expect(store.update({ processing: { concurrency: 99 } })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(store.update({ globalDrag: { convertModifiers: ['shift', 'shift'] } })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(store.update('nope')).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(store.update({ version: 7, locale: 'ko' })).resolves.toMatchObject({ version: SETTINGS_VERSION, locale: 'ko' });
    expect(store.get().processing.concurrency).toBe(3);
    // unchanged patch → no event, no write
    const before = changes.length;
    await store.update({ locale: 'ko' });
    expect(changes).toHaveLength(before);
  });

  it('serializes concurrent saves and leaves no temp files', async () => {
    const store = new SettingsStore(dir);
    await store.load();
    await Promise.all([store.update({ pdf: { dpi: 150 } }), store.update({ launchAtLogin: true }), store.update({ notifications: false })]);
    await store.flush();
    expect(await readJson('settings.json')).toMatchObject({ pdf: { dpi: 150 }, launchAtLogin: true, notifications: false });
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const reloaded = new SettingsStore(dir);
    expect((await reloaded.load()).notifications).toBe(false);
  });
});

describe('drag modifier rules', () => {
  it('macOS: Control/Command combos are refused (AppKit would turn the drag into Link with no Copy)', async () => {
    const store = new SettingsStore(dir, undefined, 'darwin');
    await store.load();
    await expect(store.update({ globalDrag: { convertModifiers: ['command', 'shift'] } })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(store.update({ globalDrag: { toolsModifiers: ['control'] } })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(store.update({ globalDrag: { toolsModifiers: ['alt'] } })).resolves.toMatchObject({ globalDrag: { toolsModifiers: ['alt'] } });
    // Windows allows Control
    const win = new SettingsStore(await mkdtemp(join(tmpdir(), 'orbitdrop-stores-win-')), undefined, 'win32');
    await win.load();
    await expect(win.update({ globalDrag: { toolsModifiers: ['control', 'shift'] } })).resolves.toMatchObject({ globalDrag: { toolsModifiers: ['control', 'shift'] } });
  });

  it('the convert and tools combos must differ (order ignored)', async () => {
    const store = new SettingsStore(dir, undefined, 'win32');
    await store.load();
    await expect(store.update({ globalDrag: { convertModifiers: ['shift', 'alt'], toolsModifiers: ['alt', 'shift'] } })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(store.get().globalDrag.convertModifiers).toEqual(['shift']);
  });

  it('a stored file with refused combos falls back to the default modifiers and keeps the rest', async () => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, locale: 'en', globalDrag: { enabled: false, convertModifiers: ['command'], toolsModifiers: ['alt', 'shift'], wheelDiameter: 340 } }));
    const settings = await new SettingsStore(dir, undefined, 'darwin').load();
    expect(settings.locale).toBe('en');
    expect(settings.globalDrag).toEqual({ ...DEFAULT_SETTINGS.globalDrag, enabled: false, wheelDiameter: 340 });
    expect(await readJson('settings.json')).toMatchObject({ globalDrag: { convertModifiers: ['shift'] } });
  });
});

function entry(i: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    jobId: `job_${i}`,
    batchId: null,
    sessionId: null,
    actionId: 'convert.jpeg',
    inputName: `in-${i}.png`,
    inputCount: 1,
    state: 'completed',
    createdAt: i,
    startedAt: i,
    finishedAt: i,
    outputs: [{ path: `/out/in-${i}.jpg`, name: `in-${i}.jpg`, format: 'jpeg', bytes: 10, width: 4, height: 4 }],
    warnings: [],
    error: null,
    inputBytes: 20,
    ...overrides,
  };
}

describe('HistoryStore', () => {
  it(`keeps the newest ${HISTORY_LIMIT} jobs and persists them`, async () => {
    const store = new HistoryStore(dir, undefined, 5);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i += 1) store.record(entry(i));
    store.record(entry(HISTORY_LIMIT + 20, { state: 'failed', outputs: [], error: { code: 'DISK_FULL', message: 'full', retryable: true } }));
    await store.flush();
    const reloaded = new HistoryStore(dir);
    const list = await reloaded.load();
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect(list[0]).toMatchObject({ jobId: `job_${HISTORY_LIMIT + 20}`, state: 'failed', error: { code: 'DISK_FULL' } });
    expect(list.at(-1)!.jobId).toBe('job_21');
  });

  it('drops invalid entries and survives a corrupt file', async () => {
    await writeFile(join(dir, 'history.json'), JSON.stringify({ version: 1, jobs: [entry(1), { jobId: '../x', state: 'completed' }, { ...entry(2), actionId: 'convert.exe' }] }));
    const partial = new HistoryStore(dir);
    expect((await partial.load()).map((e) => e.jobId)).toEqual(['job_1']);
    expect(partial.loadIssue).toBeNull(); // single bad entries are dropped, the file itself was usable
    await writeFile(join(dir, 'history.json'), '[[[');
    expect(await new HistoryStore(dir).load()).toEqual([]);
  });

  it('a corrupt history file is kept aside before the next save could destroy it', async () => {
    for (const [content, label] of [
      ['{ not json', 'not JSON'],
      [JSON.stringify({ version: 1, jobs: 'nope' }), 'no jobs list'],
      [JSON.stringify([entry(1)]), 'wrong shape'],
    ] as const) {
      await writeFile(join(dir, 'history.json'), content);
      const store = new HistoryStore(dir, undefined, 5);
      expect(await store.load(), label).toEqual([]);
      const backup = (await readdir(dir)).find((n) => n.startsWith('history.corrupt-'));
      expect(store.loadIssue, label).toEqual({ reason: 'corrupt', backup });
      expect(await readFile(join(dir, backup!), 'utf8'), label).toBe(content);
      store.record(entry(7));
      await store.flush();
      expect(((await readJson('history.json')) as { jobs: unknown[] }).jobs, label).toHaveLength(1);
      expect(await readFile(join(dir, backup!), 'utf8'), label).toBe(content); // still there after the save
      await rm(join(dir, backup!));
    }
  });

  it('an unreadable history file is kept aside and the list starts empty', async () => {
    await mkdir(join(dir, 'history.json'));
    const store = new HistoryStore(dir);
    expect(await store.load()).toEqual([]);
    expect(store.loadIssue).toMatchObject({ reason: 'unreadable', backup: expect.stringMatching(/^history\.unreadable-\d+\.json$/) });
  });

  it('removeWhere drops the selected entries, persists the rest and reports the removed ids', async () => {
    const store = new HistoryStore(dir, undefined, 5);
    for (let i = 1; i <= 4; i += 1) store.record(entry(i, { finishedAt: i * 10 }));
    expect(store.removeWhere((e) => (e.finishedAt ?? 0) <= 20).sort()).toEqual(['job_1', 'job_2']);
    expect(store.removeWhere(() => false)).toEqual([]);
    await store.flush();
    expect((await new HistoryStore(dir).load()).map((e) => e.jobId)).toEqual(['job_4', 'job_3']);
  });

  it('stores output paths and names only (no file contents)', async () => {
    const store = new HistoryStore(dir, undefined, 5);
    store.record(entry(1));
    await store.flush();
    const raw = (await readJson('history.json')) as { jobs: Record<string, unknown>[] };
    expect(Object.keys(raw.jobs[0]!).sort()).toEqual(
      ['actionId', 'batchId', 'createdAt', 'error', 'finishedAt', 'inputBytes', 'inputCount', 'inputName', 'jobId', 'outputs', 'sessionId', 'startedAt', 'state', 'warnings'].sort(),
    );
  });
});
