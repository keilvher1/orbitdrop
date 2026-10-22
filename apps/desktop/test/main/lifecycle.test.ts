import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appMenuTemplate } from '../../src/main/app-menu';
import { OUTPUT_EXTENSIONS, isOpenableOutput } from '../../src/main/files/outputs';
import {
  OpenFileQueue,
  dataDirWritable,
  filePathsFromArgv,
  installInstanceHandlers,
  installOpenFileHandler,
  installPowerHandlers,
  installQuitHandler,
  type EmitterLike,
  type QuitAppLike,
} from '../../src/main/lifecycle';
import { applyLoginItem, loginItemToAdopt, type LoginItems } from '../../src/main/login-item';
import { MAX_EDITOR_WINDOWS, editorsToEvict } from '../../src/main/windows/specs';
import { waitFor } from './helpers';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-lifecycle-'));
});
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

class FakeApp extends EventEmitter {
  readonly exit = vi.fn();
  /** Typed like Electron's App for the quit handler. */
  get quitApp(): QuitAppLike {
    return this as unknown as QuitAppLike;
  }
}

const preventable = () => ({ preventDefault: vi.fn() });

describe('quit', () => {
  it('every quit request waits for the first cleanup, then exits once', async () => {
    const app = new FakeApp();
    let finish!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    installQuitHandler(app.quitApp, shutdown, 10_000);
    const first = preventable();
    const second = preventable();
    app.emit('before-quit', first);
    app.emit('before-quit', second); // a second ⌘Q / tray Quit
    expect(first.preventDefault).toHaveBeenCalled();
    expect(second.preventDefault).toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();
    finish();
    await waitFor(() => app.exit.mock.calls.length === 1);
    expect(app.exit).toHaveBeenCalledWith(0);
  });

  it('a hanging or failing cleanup still ends in an exit', async () => {
    vi.useFakeTimers();
    try {
      const hanging = new FakeApp();
      installQuitHandler(hanging.quitApp, () => new Promise<void>(() => undefined), 50);
      hanging.emit('before-quit', preventable());
      await vi.advanceTimersByTimeAsync(60);
      expect(hanging.exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
    const failing = new FakeApp();
    installQuitHandler(failing.quitApp, () => Promise.reject(new Error('boom')), 10_000);
    failing.emit('before-quit', preventable());
    await waitFor(() => failing.exit.mock.calls.length === 1);
  });
});

describe('files on a command line', () => {
  const options = { appPath: '/app', platform: 'darwin' as const };

  it('keeps file arguments, resolved against the launch folder, without switches, the app folder or duplicates', () => {
    expect(
      filePathsFromArgv(
        ['/Applications/OrbitDrop', '--allow-file-access-from-files', '-psn_0_12345', '/Users/me/a.jpg', 'rel/b.pdf', '', '/Users/me/a.jpg', '.', '/app', 7],
        '/app',
        options,
      ),
    ).toEqual(['/Users/me/a.jpg', resolve('/app', 'rel/b.pdf')]);
    // A development run: `electron [--inspect=0 --remote-debugging-port=0] <app folder>` names no file.
    expect(filePathsFromArgv(['/x/Electron', '--inspect=0', '--remote-debugging-port=0', '/app'], '/somewhere', options)).toEqual([]);
    expect(filePathsFromArgv(['/x/Electron'], '/', options)).toEqual([]);
  });

  it('development runs (`electron <entry script>`, skip 2) do not take the entry for a file', () => {
    expect(filePathsFromArgv(['/x/Electron', 'out/main/index.js', 'photo.jpg'], '/repo/apps/desktop', { appPath: '/repo/apps/desktop/out/main', platform: 'darwin', skip: 2 })).toEqual([
      '/repo/apps/desktop/photo.jpg',
    ]);
    // Without the skip the entry script would have been a candidate.
    expect(filePathsFromArgv(['/x/Electron', 'out/main/index.js'], '/repo/apps/desktop', { appPath: '/repo/apps/desktop/out/main', platform: 'darwin' })).toEqual([
      '/repo/apps/desktop/out/main/index.js',
    ]);
  });

  it('compares paths case-insensitively on Windows and caps the number of files', () => {
    expect(filePathsFromArgv(['OrbitDrop.exe', '/APP', '/Photos/A.jpg', '/photos/a.JPG'], '/', { appPath: '/app', platform: 'win32' })).toEqual(['/Photos/A.jpg']);
    const many = ['exe', ...Array.from({ length: 600 }, (_, i) => `/p/${i}.png`)];
    expect(filePathsFromArgv(many, '/', options)).toHaveLength(500);
    expect(filePathsFromArgv(many, '/', { ...options, max: 3 })).toEqual(['/p/0.png', '/p/1.png', '/p/2.png']);
  });

  it('a second launch with files opens them (validated by the target); without files it shows the Drop Zone', () => {
    const app = new FakeApp();
    const target = { showDropZone: vi.fn(), openPaths: vi.fn() };
    installInstanceHandlers(app as unknown as EmitterLike, target, { platform: 'win32', appPath: 'C:\\app', cwd: () => '/fallback' });
    app.emit('second-instance', {}, ['OrbitDrop.exe', '--flag', 'photo.png'], '/Users/me/Desktop');
    expect(target.openPaths).toHaveBeenCalledWith([resolve('/Users/me/Desktop', 'photo.png')]);
    app.emit('second-instance', {}, ['OrbitDrop.exe', '--original-process-start-time=1'], '/Users/me');
    app.emit('second-instance', {}, 'not an array', 42);
    expect(target.showDropZone).toHaveBeenCalledTimes(2);
    app.emit('second-instance', {}, ['OrbitDrop.exe', 'x.png'], undefined); // no working folder: the app's own
    expect(target.openPaths).toHaveBeenLastCalledWith([resolve('/fallback', 'x.png')]);
    app.emit('activate', {}, false);
    expect(target.showDropZone).toHaveBeenCalledTimes(2); // 'activate' is a macOS reopen only
  });

  it('macOS: re-opening the running app (activate) shows the Drop Zone', () => {
    const app = new FakeApp();
    const target = { showDropZone: vi.fn(), openPaths: vi.fn() };
    installInstanceHandlers(app as unknown as EmitterLike, target, { platform: 'darwin', appPath: '/app', cwd: () => '/' });
    app.emit('activate', {}, false);
    expect(target.showDropZone).toHaveBeenCalledTimes(1);
  });
});

describe('macOS open-file', () => {
  it('collects files from before ready and delivers each hand-over once, together', async () => {
    const app = new FakeApp();
    const queue = new OpenFileQueue(20);
    installOpenFileHandler(app as unknown as EmitterLike, queue);
    const early = preventable();
    app.emit('open-file', early, '/Users/me/a.jpg');
    app.emit('open-file', preventable(), '/Users/me/b.pdf');
    app.emit('open-file', preventable(), '/Users/me/a.jpg'); // duplicate
    app.emit('open-file', preventable(), 42); // not a path
    expect(early.preventDefault).toHaveBeenCalled(); // handled by OrbitDrop
    expect(queue.pending).toBe(2);
    const batches: string[][] = [];
    queue.attach((paths) => batches.push(paths));
    await waitFor(() => batches.length === 1);
    expect(batches[0]).toEqual(['/Users/me/a.jpg', '/Users/me/b.pdf']);
    app.emit('open-file', preventable(), '/Users/me/c.png');
    app.emit('open-file', preventable(), '/Users/me/d.png');
    await waitFor(() => batches.length === 2);
    expect(batches[1]).toEqual(['/Users/me/c.png', '/Users/me/d.png']);
    expect(queue.pending).toBe(0);
  });
});

describe('sleep, screen lock and user switches', () => {
  it('suspend / lock-screen drop the drag session, resume / unlock re-check the helper (user switch on macOS only)', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const power = new EventEmitter();
      const target = { systemSuspended: vi.fn(), systemResumed: vi.fn() };
      installPowerHandlers(power as unknown as EmitterLike, target, platform);
      for (const event of ['suspend', 'lock-screen', 'user-did-resign-active', 'resume', 'unlock-screen', 'user-did-become-active']) power.emit(event);
      const mac = platform === 'darwin';
      expect(target.systemSuspended.mock.calls.map((c) => c[0])).toEqual(mac ? ['suspend', 'lock-screen', 'user-did-resign-active'] : ['suspend', 'lock-screen']);
      expect(target.systemResumed.mock.calls.map((c) => c[0])).toEqual(mac ? ['resume', 'unlock-screen', 'user-did-become-active'] : ['resume', 'unlock-screen']);
    }
  });
});

describe('app data folder', () => {
  it('is writable when it can be created and written; probes leave nothing behind', async () => {
    expect(dataDirWritable(join(dir, 'new', 'nested'))).toBe(true);
    expect(await readdir(join(dir, 'new', 'nested'))).toEqual([]);
  });

  it('a read-only folder (or one that cannot be created) is reported', async () => {
    const readOnly = join(dir, 'ro');
    await mkdir(readOnly);
    await chmod(readOnly, 0o555);
    try {
      expect(dataDirWritable(readOnly)).toBe(false);
      expect(dataDirWritable(join(readOnly, 'child'))).toBe(false);
    } finally {
      await chmod(readOnly, 0o755);
    }
    await writeFile(join(dir, 'file'), 'x');
    expect(dataDirWritable(join(dir, 'file'))).toBe(false); // a file where the folder should be
  });
});

describe('launch at login', () => {
  function fakeItems(initial: boolean, options: { readonly refuse?: boolean; readonly broken?: boolean } = {}): LoginItems & { state: boolean; sets: boolean[] } {
    const items = {
      state: initial,
      sets: [] as boolean[],
      openAtLogin: () => {
        if (options.broken) throw new Error('no login items here');
        return items.state;
      },
      setOpenAtLogin: (enabled: boolean) => {
        items.sets.push(enabled);
        if (!options.refuse) items.state = enabled;
      },
    };
    return items;
  }

  it('startup follows a change made in the OS settings instead of undoing it', () => {
    expect(loginItemToAdopt(fakeItems(false), false)).toBeNull(); // default: off on both sides
    expect(loginItemToAdopt(fakeItems(true), true)).toBeNull();
    expect(loginItemToAdopt(fakeItems(false), true)).toBe(false); // removed in System Settings → settings follow
    expect(loginItemToAdopt(fakeItems(true), false)).toBe(true); // added in System Settings → settings follow
    const warn = vi.fn();
    expect(loginItemToAdopt(fakeItems(true, { broken: true }), false, { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('a settings change is applied to the OS only when it differs, and a refusal is logged', () => {
    const items = fakeItems(false);
    applyLoginItem(items, true);
    applyLoginItem(items, true);
    applyLoginItem(items, false);
    expect(items.sets).toEqual([true, false]);
    const warn = vi.fn();
    const refusing = fakeItems(false, { refuse: true });
    applyLoginItem(refusing, true, { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    expect(warn).toHaveBeenCalledWith('the system did not take the login item change', { requested: true, actual: false });
    expect(() => applyLoginItem(fakeItems(false, { broken: true }), true)).not.toThrow();
  });
});

describe('opening outputs', () => {
  it('opens only regular files with the extension of a format OrbitDrop writes', async () => {
    const jpg = join(dir, 'Page 001.jpg');
    const upper = join(dir, 'SCAN.PDF');
    await writeFile(jpg, 'x');
    await writeFile(upper, 'x');
    expect(await isOpenableOutput(jpg)).toBe(true);
    expect(await isOpenableOutput(upper)).toBe(true);
    for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tiff', '.tif', '.avif', '.bmp', '.gif', '.pdf', '.docx', '.txt']) expect(OUTPUT_EXTENSIONS.has(ext), ext).toBe(true);

    // What a damaged or planted history.json could point at:
    const app = join(dir, 'Calculator.app');
    await mkdir(app);
    const script = join(dir, 'run.command');
    await writeFile(script, '#!/bin/sh\n');
    const exe = join(dir, 'setup.exe');
    await writeFile(exe, 'MZ');
    const folderLikeImage = join(dir, 'folder.png');
    await mkdir(folderLikeImage);
    const link = join(dir, 'link.png');
    await symlink(script, link);
    for (const path of [app, script, exe, folderLikeImage, link, join(dir, 'missing.png'), join(dir, 'noext')]) expect(await isOpenableOutput(path), path).toBe(false);
  });
});

describe('editor window limit', () => {
  const editor = (createdAt: number, unsaved = false) => ({ createdAt, guard: { unsaved } });

  it('closes the oldest editors beyond the limit, never one with unsaved work', () => {
    expect(editorsToEvict([editor(1), editor(2)])).toEqual([]);
    const full = Array.from({ length: MAX_EDITOR_WINDOWS }, (_, i) => editor(i + 1));
    expect(editorsToEvict(full)).toEqual([full[0]]);
    const oldestUnsaved = [editor(1, true), ...full.slice(1)];
    expect(editorsToEvict(oldestUnsaved)).toEqual([full[1]]);
    const allUnsaved = full.map((e) => editor(e.createdAt, true));
    expect(editorsToEvict(allUnsaved)).toEqual([]); // the limit is exceeded instead of losing work
    expect(editorsToEvict([...full].reverse(), MAX_EDITOR_WINDOWS)).toEqual([full[0]]); // by age, not list order
  });
});

describe('application menu', () => {
  it('macOS has File › Close Window (⌘W) besides the app, Edit and Window menus; other platforms have none', () => {
    expect(appMenuTemplate('darwin')!.map((item) => item.role)).toEqual(['appMenu', 'fileMenu', 'editMenu', 'windowMenu']);
    expect(appMenuTemplate('win32')).toBeNull();
  });
});
