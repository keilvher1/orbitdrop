import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * File systems without hard links (FAT32/exFAT: link() → ENOTSUP on macOS,
 * measured; CreateHardLinkW → ERROR_INVALID_FUNCTION, which libuv reports as
 * EISDIR on Windows), and the macOS reserve-then-rename commit. link() and
 * rename() are made to fail here; everything else is the real file system. A
 * real FAT32 volume is exercised in output-fat.test.ts (opt-in).
 */
const control = vi.hoisted(() => ({
  linkError: null as string | null,
  linkCalls: 0,
  renameError: null as string | null,
  renameCalls: 0,
  /** Fail writes into an exclusively created final file whose name contains this text. */
  failCopyInto: null as string | null,
  /** Right after the placeholder with this name is created, another program replaces it. */
  replacePlaceholder: null as string | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: async (existingPath: string, newPath: string) => {
      control.linkCalls += 1;
      if (control.linkError !== null) throw Object.assign(new Error(`${control.linkError}: link`), { code: control.linkError });
      return actual.link(existingPath, newPath);
    },
    rename: async (oldPath: string, newPath: string) => {
      control.renameCalls += 1;
      if (control.renameError !== null) throw Object.assign(new Error(`${control.renameError}: rename`), { code: control.renameError });
      return actual.rename(oldPath, newPath);
    },
    open: async (path: string, flags?: string, mode?: number) => {
      const handle = await actual.open(path, flags, mode);
      if (flags === 'wx' && control.replacePlaceholder !== null && basename(String(path)) === control.replacePlaceholder) {
        control.replacePlaceholder = null;
        await handle.close();
        await actual.unlink(path);
        await actual.writeFile(path, 'theirs');
        return actual.open(path, 'r');
      }
      if (flags === 'wx' && control.failCopyInto !== null && String(path).includes(control.failCopyInto)) {
        let writes = 0;
        return new Proxy(handle, {
          get(target, prop) {
            if (prop === 'write') {
              return async (...args: unknown[]) => {
                writes += 1;
                if (writes > 1) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
                return (target.write as (...a: unknown[]) => Promise<unknown>)(...args);
              };
            }
            const value = Reflect.get(target, prop) as unknown;
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
      }
      return handle;
    },
  };
});

const { commitTempFile, isTempFileName, makeTempPath, writeOutput } = await import('../src/node');
const LINK = { strategy: 'link' } as const;
const RENAME = { strategy: 'rename' } as const;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-fallback-'));
  control.linkError = null;
  control.linkCalls = 0;
  control.renameError = null;
  control.renameCalls = 0;
  control.failCopyInto = null;
  control.replacePlaceholder = null;
});
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

describe('commit without hard links', () => {
  for (const code of ['ENOTSUP', 'EPERM', 'EXDEV', 'EISDIR', 'EINVAL']) {
    it(`falls back to an exclusive copy when link() fails with ${code}`, async () => {
      control.linkError = code;
      await writeFile(join(dir, 'p.png'), 'user');
      const result = await writeOutput(dir, 'p.png', 'job', (tmp) => writeFile(tmp, 'ours'), undefined, LINK);
      expect(result).toBe(join(dir, 'p (2).png'));
      expect(await readFile(result, 'utf8')).toBe('ours');
      expect(await readFile(join(dir, 'p.png'), 'utf8')).toBe('user');
      expect((await readdir(dir)).filter((n) => isTempFileName(n))).toEqual([]);
      // Link is tried once; after "unsupported" the remaining names use the copy path.
      expect(control.linkCalls).toBe(1);
    });
  }

  it('does not treat a permission error as "unsupported"', async () => {
    control.linkError = 'EACCES';
    const tmp = makeTempPath(dir, 'x.png', 'j');
    await writeFile(tmp, 'x');
    await expect(commitTempFile(tmp, dir, 'x.png', LINK)).rejects.toMatchObject({ code: 'OUTPUT_DIR_NOT_WRITABLE' });
  });

  it('keeps names unique for 50 concurrent writers', async () => {
    control.linkError = 'ENOTSUP';
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => writeOutput(dir, 'c.jpg', `j${i}`, (tmp) => writeFile(tmp, `w${i}`), undefined, LINK)));
    expect(new Set(results).size).toBe(50);
    for (let i = 0; i < 50; i += 1) expect(await readFile(results[i]!, 'utf8')).toBe(`w${i}`);
    expect((await readdir(dir)).length).toBe(50);
  });

  it('removes a partially copied output when the copy fails (disk full)', async () => {
    control.linkError = 'ENOTSUP';
    control.failCopyInto = 'big (2).bin';
    await writeFile(join(dir, 'big.bin'), 'user');
    const payload = Buffer.alloc(3 * 1024 * 1024, 7); // 3 chunks: the second write fails
    await expect(writeOutput(dir, 'big.bin', 'j', (tmp) => writeFile(tmp, payload), undefined, LINK)).rejects.toMatchObject({ code: 'DISK_FULL' });
    expect(await readdir(dir)).toEqual(['big.bin']);
    expect(await readFile(join(dir, 'big.bin'), 'utf8')).toBe('user');
  });

  it('copies large files completely', async () => {
    control.linkError = 'ENOTSUP';
    const payload = Buffer.alloc(5 * 1024 * 1024 + 123);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31) & 0xff;
    const result = await writeOutput(dir, 'large.tiff', 'j', (tmp) => writeFile(tmp, payload), undefined, LINK);
    expect(basename(result)).toBe('large.tiff');
    expect((await readFile(result)).equals(payload)).toBe(true);
  });
});

describe('reserve-then-rename commit (macOS default)', () => {
  it('is what "auto" uses on macOS, and a hard link elsewhere', async () => {
    const result = await writeOutput(dir, 'd.png', 'j', (tmp) => writeFile(tmp, 'ours'));
    expect(await readFile(result, 'utf8')).toBe('ours');
    if (process.platform === 'darwin') {
      expect([control.renameCalls, control.linkCalls]).toEqual([1, 0]);
    } else {
      expect([control.renameCalls, control.linkCalls]).toEqual([0, 1]);
    }
  });

  it('reserves the next free name and moves the temp file there (no temp file left)', async () => {
    await writeFile(join(dir, 'r.png'), 'user');
    const result = await writeOutput(dir, 'r.png', 'job', (tmp) => writeFile(tmp, 'ours'), undefined, RENAME);
    expect(result).toBe(join(dir, 'r (2).png'));
    expect(await readFile(result, 'utf8')).toBe('ours');
    expect(await readFile(join(dir, 'r.png'), 'utf8')).toBe('user');
    expect((await readdir(dir)).sort()).toEqual(['r (2).png', 'r.png']);
    expect(control.linkCalls).toBe(0);
  });

  it('leaves a file that replaced the placeholder alone and takes the next name', async () => {
    control.replacePlaceholder = 'q.png';
    const result = await writeOutput(dir, 'q.png', 'job', (tmp) => writeFile(tmp, 'ours'), undefined, RENAME);
    expect(result).toBe(join(dir, 'q (2).png'));
    expect(await readFile(join(dir, 'q.png'), 'utf8')).toBe('theirs');
    expect(await readFile(result, 'utf8')).toBe('ours');
    expect((await readdir(dir)).filter((n) => isTempFileName(n))).toEqual([]);
  });

  for (const code of ['ENOTSUP', 'EPERM', 'EINVAL']) {
    it(`removes its placeholder and copies exclusively when rename() fails with ${code}`, async () => {
      control.renameError = code;
      const result = await writeOutput(dir, 'f.png', 'job', (tmp) => writeFile(tmp, 'ours'), undefined, RENAME);
      expect(result).toBe(join(dir, 'f.png'));
      expect(await readFile(result, 'utf8')).toBe('ours');
      expect((await readdir(dir)).sort()).toEqual(['f.png']);
      expect(control.renameCalls).toBe(1);
    });
  }

  it('removes its placeholder when rename() fails with a real error, and reports it', async () => {
    control.renameError = 'EACCES';
    await expect(writeOutput(dir, 'e.png', 'job', (tmp) => writeFile(tmp, 'ours'), undefined, RENAME)).rejects.toMatchObject({
      code: 'OUTPUT_DIR_NOT_WRITABLE',
    });
    expect(await readdir(dir)).toEqual([]);
  });
});
