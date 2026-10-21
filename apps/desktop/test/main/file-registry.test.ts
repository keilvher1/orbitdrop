import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrbitError } from '@orbitdrop/contracts';
import { FileRegistry, isHungReadError, isUsable, toProcessorInput } from '../../src/main/files/registry';
import { encodePng, testPattern } from '../../src/main/util/png';
import { fakeValidator, snapshotWith, validated } from './helpers';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-files-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, ...new Array(64).fill(0)]);

describe('FileRegistry with real files', () => {
  it('validates every path, explains problems and builds the menu key from usable files', async () => {
    const png = join(dir, 'Page 001.png');
    const jpg = join(dir, '사진 🙂.jpg');
    const renamed = join(dir, 'actually-png.jpg');
    const empty = join(dir, 'empty.png');
    const text = join(dir, 'notes.txt');
    const folder = join(dir, 'folder');
    await writeFile(png, encodePng(8, 8, testPattern(8, 8)));
    await writeFile(jpg, JPEG_HEADER);
    await writeFile(renamed, encodePng(2, 2, testPattern(2, 2)));
    await writeFile(empty, '');
    await writeFile(text, 'hello world, this is not an image');
    await mkdir(folder);

    const registry = new FileRegistry({ snapshot: () => snapshotWith() });
    const selection = await registry.registerPaths([png, jpg, renamed, empty, text, folder, join(dir, 'missing.png')], 'dropZone');
    expect(selection.source).toBe('dropZone');
    expect(selection.files.map((f) => [f.name, f.format, f.problem?.code ?? null])).toEqual([
      ['Page 001.png', 'png', null],
      ['사진 🙂.jpg', 'jpeg', null],
      ['actually-png.jpg', 'png', null],
      // empty files: the code is core's decision (by extension today; a FILE_EMPTY code may come)
      ['empty.png', null, expect.any(String)],
      ['notes.txt', null, 'UNSUPPORTED_FORMAT'],
      ['folder', null, 'NOT_A_FILE'],
      ['missing.png', null, 'FILE_NOT_FOUND'],
    ]);
    expect(selection.files[2]!.extensionMismatch).toBe(true);
    expect(selection.menuKey).toBe('images');
    // the renderer-facing selection never contains paths
    expect(JSON.stringify(selection)).not.toContain(dir);

    const usable = registry.usableFiles(selection.selectionId);
    expect(usable.map((f) => f.selected.name)).toEqual(['Page 001.png', '사진 🙂.jpg', 'actually-png.jpg']);
    const input = toProcessorInput(usable[0]!);
    expect(input).toMatchObject({ displayName: 'Page 001.png', sourceDir: dir, format: 'png' });
    expect(registry.getFile(usable[0]!.fileId)?.input?.realPath).toBe(input.path);
  });

  it('lists the same file only once (direct path and symlink)', async () => {
    const png = join(dir, 'a.png');
    const link = join(dir, 'link.png');
    await writeFile(png, encodePng(2, 2, testPattern(2, 2)));
    await symlink(png, link);
    const registry = new FileRegistry();
    const selection = await registry.registerPaths([png, link, png], 'openDialog');
    expect(selection.files).toHaveLength(1);
    expect(selection.menuKey).toBe('image/png');
  });

  it('registerFile accepts readable images and refuses the rest', async () => {
    const png = join(dir, 'bg.png');
    await writeFile(png, encodePng(4, 4, testPattern(4, 4)));
    const registry = new FileRegistry({ snapshot: () => snapshotWith() });
    const file = await registry.registerFile(png);
    expect(isUsable(file)).toBe(true);
    expect(file.selected.name).toBe('bg.png');
    await writeFile(join(dir, 'x.txt'), 'text file content here');
    await expect(registry.registerFile(join(dir, 'x.txt'))).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });
});

describe('FileRegistry bookkeeping', () => {
  it('forgets the least recently used selections beyond the limit', async () => {
    const registry = new FileRegistry({ validate: fakeValidator({ '/a.png': 'png', '/b.png': 'png', '/c.png': 'png' }), maxSelections: 2 });
    const a = await registry.registerPaths(['/a.png'], 'test');
    const b = await registry.registerPaths(['/b.png'], 'test');
    registry.getSelection(a.selectionId); // a is now more recent than b
    const c = await registry.registerPaths(['/c.png'], 'test');
    expect(registry.getSelection(b.selectionId)).toBeUndefined();
    expect(registry.getSelection(a.selectionId)).toBeDefined();
    expect(registry.getSelection(c.selectionId)).toBeDefined();
    expect(registry.getFile(b.files[0]!.fileId)).toBeUndefined();
    expect(registry.fileCount).toBe(2);
  });

  it('validates at most two files at a time (each holds a libuv pool thread while reading)', async () => {
    let active = 0;
    let peak = 0;
    const registry = new FileRegistry({
      validate: async (path) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return validated(path, 'png');
      },
    });
    const selection = await registry.registerPaths(Array.from({ length: 12 }, (_, i) => `/in/${i}.png`), 'test');
    expect(selection.files).toHaveLength(12);
    expect(peak).toBe(2);
  });

  it('fails fast once too many header reads timed out (their threads may still be blocked), and recovers later', async () => {
    let calls = 0;
    const registry = new FileRegistry({
      validate: async (path) => {
        calls += 1;
        if (path.includes('placeholder')) {
          throw new OrbitError('CLOUD_PLACEHOLDER', 'File is not downloaded yet', { cause: new OrbitError('TIMEOUT', 'Reading the file header timed out') });
        }
        if (path.includes('eio')) throw new OrbitError('CLOUD_PLACEHOLDER', 'File is not downloaded yet', { detail: 'EIO' }); // failed, not hung
        return validated(path, 'png');
      },
      maxHungReads: 2,
      hungReadMs: 50,
    });
    const first = await registry.registerPaths(['/drive/placeholder-1.png', '/drive/eio.png', '/drive/placeholder-2.png'], 'test');
    expect(first.files.map((f) => f.problem?.code)).toEqual(['CLOUD_PLACEHOLDER', 'CLOUD_PLACEHOLDER', 'CLOUD_PLACEHOLDER']);
    expect(registry.outstandingHungReads).toBe(2);
    const blocked = await registry.registerPaths(['/local/ok.png'], 'test');
    expect(blocked.files[0]!.problem?.code).toBe('TIMEOUT');
    expect(calls).toBe(3); // the fs was not touched while the budget was exhausted
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.outstandingHungReads).toBe(0);
    const recovered = await registry.registerPaths(['/local/ok.png'], 'test');
    expect(recovered.files[0]!.problem).toBeUndefined();
  });

  it('limits a whole validation (stat on a dead mount) and counts it as a hung read', async () => {
    const registry = new FileRegistry({
      validate: (path) => (path.includes('dead') ? new Promise(() => undefined) : Promise.resolve(validated(path, 'png'))),
      validationTimeoutMs: 30,
    });
    const selection = await registry.registerPaths(['/Volumes/dead-share/a.png', '/Users/me/dead-local.png', '/Users/me/ok.png'], 'test');
    expect(selection.files.map((f) => f.problem?.code ?? null)).toEqual(process.platform === 'win32' ? ['TIMEOUT', 'TIMEOUT', null] : ['NETWORK_PATH_FAILED', 'TIMEOUT', null]);
    expect(registry.outstandingHungReads).toBe(2);
    expect(JSON.stringify(selection)).not.toContain('/Volumes');
  });

  it('recognizes timed-out reads among validation errors', () => {
    expect(isHungReadError(new OrbitError('TIMEOUT', 'x'))).toBe(true);
    expect(isHungReadError(new OrbitError('NETWORK_PATH_FAILED', 'x', { cause: new OrbitError('TIMEOUT', 'y') }))).toBe(true);
    expect(isHungReadError(new OrbitError('NETWORK_PATH_FAILED', 'x', { detail: 'ETIMEDOUT' }))).toBe(false);
    expect(isHungReadError(new OrbitError('IMAGE_CORRUPT', 'x'))).toBe(false);
    expect(isHungReadError(new Error('TIMEOUT'))).toBe(false);
  });

  it('refuses empty and oversized path lists', async () => {
    const registry = new FileRegistry({ validate: fakeValidator({}) });
    await expect(registry.registerPaths([], 'test')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(registry.registerPaths(Array.from({ length: 501 }, (_, i) => `/f${i}.png`), 'test')).rejects.toMatchObject({ code: 'TOO_MANY_FILES' });
  });
});
