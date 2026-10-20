import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * File systems without hard links (FAT32/exFAT: link() → ENOTSUP on macOS,
 * measured; CreateHardLinkW → ERROR_INVALID_FUNCTION, which libuv reports as
 * EISDIR on Windows). link() is made to fail here; everything else is the real
 * file system. A real FAT32 volume is exercised in output-fat.test.ts (opt-in).
 */
const control = vi.hoisted(() => ({
  linkError: null as string | null,
  linkCalls: 0,
  /** Fail writes into an exclusively created final file whose name contains this text. */
  failCopyInto: null as string | null,
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
    open: async (path: string, flags?: string, mode?: number) => {
      const handle = await actual.open(path, flags, mode);
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

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-fallback-'));
  control.linkError = null;
  control.linkCalls = 0;
  control.failCopyInto = null;
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
      const result = await writeOutput(dir, 'p.png', 'job', (tmp) => writeFile(tmp, 'ours'));
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
    await expect(commitTempFile(tmp, dir, 'x.png')).rejects.toMatchObject({ code: 'OUTPUT_DIR_NOT_WRITABLE' });
  });

  it('keeps names unique for 50 concurrent writers', async () => {
    control.linkError = 'ENOTSUP';
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => writeOutput(dir, 'c.jpg', `j${i}`, (tmp) => writeFile(tmp, `w${i}`))));
    expect(new Set(results).size).toBe(50);
    for (let i = 0; i < 50; i += 1) expect(await readFile(results[i]!, 'utf8')).toBe(`w${i}`);
    expect((await readdir(dir)).length).toBe(50);
  });

  it('removes a partially copied output when the copy fails (disk full)', async () => {
    control.linkError = 'ENOTSUP';
    control.failCopyInto = 'big (2).bin';
    await writeFile(join(dir, 'big.bin'), 'user');
    const payload = Buffer.alloc(3 * 1024 * 1024, 7); // 3 chunks: the second write fails
    await expect(writeOutput(dir, 'big.bin', 'j', (tmp) => writeFile(tmp, payload))).rejects.toMatchObject({ code: 'DISK_FULL' });
    expect(await readdir(dir)).toEqual(['big.bin']);
    expect(await readFile(join(dir, 'big.bin'), 'utf8')).toBe('user');
  });

  it('copies large files completely', async () => {
    control.linkError = 'ENOTSUP';
    const payload = Buffer.alloc(5 * 1024 * 1024 + 123);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31) & 0xff;
    const result = await writeOutput(dir, 'large.tiff', 'j', (tmp) => writeFile(tmp, payload));
    expect(basename(result)).toBe('large.tiff');
    expect((await readFile(result)).equals(payload)).toBe(true);
  });
});
