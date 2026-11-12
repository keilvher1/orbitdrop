import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A hanging cloud placeholder or network share cannot be produced on demand, so
 * open()/read() are made to hang (or fail) for chosen paths; stat() can report
 * 0 allocated blocks like an iCloud "dataless" file. Everything else is real.
 */
const control = vi.hoisted(() => ({
  hangOpen: new Set<string>(),
  hangRead: new Set<string>(),
  readError: new Map<string, string>(),
  zeroBlocks: new Set<string>(),
  fakeRealpath: new Map<string, string>(),
  fakeStat: new Map<string, string>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const never = () => new Promise<never>(() => undefined);
  return {
    ...actual,
    realpath: async (path: string) => control.fakeRealpath.get(path) ?? actual.realpath(path),
    lstat: async (path: string) => (control.fakeRealpath.has(path) ? actual.lstat(control.fakeStat.get(control.fakeRealpath.get(path)!)!) : actual.lstat(path)),
    stat: async (path: string) => {
      const info = await actual.stat(control.fakeStat.get(path) ?? path);
      if (!control.zeroBlocks.has(path)) return info;
      return Object.assign(Object.create(Object.getPrototypeOf(info) as object) as object, info, { blocks: 0 });
    },
    open: async (path: string, flags?: string) => {
      if (control.hangOpen.has(path)) return never();
      const handle = await actual.open(path, flags);
      if (control.hangRead.has(path) || control.readError.has(path)) {
        let readPending = false;
        return new Proxy(handle, {
          get(target, prop) {
            if (prop === 'read') {
              return async () => {
                const code = control.readError.get(path);
                if (code !== undefined) throw Object.assign(new Error(code), { code });
                readPending = true;
                return never();
              };
            }
            // Like Node's FileHandle.close(): waits for pending operations (here: forever).
            if (prop === 'close') return async () => (readPending ? never() : target.close());
            const value = Reflect.get(target, prop) as unknown;
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
      }
      return handle;
    },
  };
});

const { validateInputFile } = await import('../src/node');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
let dir: string;
let real: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-timeout-'));
  real = await realpath(dir);
  for (const set of [control.hangOpen, control.hangRead, control.zeroBlocks]) set.clear();
  control.readError.clear();
  control.fakeRealpath.clear();
  control.fakeStat.clear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function timed<T>(promise: Promise<T>): Promise<{ error: unknown; ms: number }> {
  const start = performance.now();
  try {
    await promise;
    return { error: null, ms: performance.now() - start };
  } catch (error) {
    return { error, ms: performance.now() - start };
  }
}

describe('header read timeout', () => {
  it('returns TIMEOUT on time when open() hangs on a plain local path', async () => {
    await writeFile(join(dir, 'a.png'), PNG);
    control.hangOpen.add(join(real, 'a.png'));
    const { error, ms } = await timed(validateInputFile(join(dir, 'a.png'), { headerTimeoutMs: 60, cloudRoots: [] }));
    expect(error).toMatchObject({ code: 'TIMEOUT' });
    expect(ms).toBeLessThan(1000);
  });

  it('returns on time when read() hangs (the pending read does not block the close)', async () => {
    await writeFile(join(dir, 'b.png'), PNG);
    control.hangRead.add(join(real, 'b.png'));
    const { error, ms } = await timed(validateInputFile(join(dir, 'b.png'), { headerTimeoutMs: 60, cloudRoots: [] }));
    expect(error).toMatchObject({ code: 'TIMEOUT' });
    expect(ms).toBeLessThan(1000);
  });

  it('explains the timeout as CLOUD_PLACEHOLDER for a dataless file (0 blocks) on macOS', async () => {
    await writeFile(join(dir, 'icloud.png'), PNG);
    const p = join(real, 'icloud.png');
    control.hangRead.add(p);
    control.zeroBlocks.add(p);
    await expect(validateInputFile(join(dir, 'icloud.png'), { headerTimeoutMs: 60, cloudRoots: [], platform: 'darwin' })).rejects.toMatchObject({
      code: 'CLOUD_PLACEHOLDER',
    });
    // Windows has no reliable block count in Node: the 0-blocks rule does not apply there.
    await expect(validateInputFile(join(dir, 'icloud.png'), { headerTimeoutMs: 60, cloudRoots: [], platform: 'win32' })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('explains the timeout as CLOUD_PLACEHOLDER for files under a cloud-synced folder', async () => {
    await writeFile(join(dir, 'onedrive.png'), PNG);
    control.hangOpen.add(join(real, 'onedrive.png'));
    await expect(validateInputFile(join(dir, 'onedrive.png'), { headerTimeoutMs: 60, cloudRoots: [dir] })).rejects.toMatchObject({ code: 'CLOUD_PLACEHOLDER' });
  });

  it('maps a generic I/O error on a placeholder to CLOUD_PLACEHOLDER, elsewhere to READ_PERMISSION_DENIED', async () => {
    await writeFile(join(dir, 'c.png'), PNG);
    control.readError.set(join(real, 'c.png'), 'EIO');
    await expect(validateInputFile(join(dir, 'c.png'), { cloudRoots: [real] })).rejects.toMatchObject({ code: 'CLOUD_PLACEHOLDER' });
    await expect(validateInputFile(join(dir, 'c.png'), { cloudRoots: [] })).rejects.toMatchObject({ code: 'READ_PERMISSION_DENIED' });
  });

  it('explains a hanging network share as NETWORK_PATH_FAILED', async () => {
    // The stand-in's real stat() is reported for the share path while macOS is simulated, so it
    // must have allocated blocks: NTFS keeps a file of a few bytes inside its MFT record (0
    // blocks), which the macOS rule would read as a dataless iCloud file (CLOUD_PLACEHOLDER).
    await writeFile(join(dir, 'stand-in.png'), Buffer.concat([PNG, Buffer.alloc(64 * 1024, 1)]));
    const input = '/Volumes/NAS/photos/net.png';
    control.fakeRealpath.set(input, input);
    control.fakeStat.set(input, join(dir, 'stand-in.png'));
    control.hangOpen.add(input);
    const { error, ms } = await timed(validateInputFile(input, { headerTimeoutMs: 60, cloudRoots: [], platform: 'darwin' }));
    expect(error).toMatchObject({ code: 'NETWORK_PATH_FAILED' });
    expect(ms).toBeLessThan(1000);
  });

  // Windows paths are only absolute for Windows' own path rules, so this one runs there.
  it.runIf(process.platform === 'win32')('explains a hanging Windows share (UNC path, also a mapped drive resolved to one) as NETWORK_PATH_FAILED', async () => {
    await writeFile(join(dir, 'stand-in.png'), Buffer.concat([PNG, Buffer.alloc(64 * 1024, 1)]));
    for (const [input, real] of [
      ['\\\\nas\\photos\\net.png', '\\\\nas\\photos\\net.png'],
      ['Z:\\photos\\mapped.png', '\\\\nas\\photos\\mapped.png'], // realpath of a mapped drive is the UNC path
    ] as const) {
      control.fakeRealpath.set(input, real);
      control.fakeStat.set(real, join(dir, 'stand-in.png'));
      control.hangOpen.add(real);
      const { error, ms } = await timed(validateInputFile(input, { headerTimeoutMs: 60, cloudRoots: [], platform: 'win32' }));
      expect(error, input).toMatchObject({ code: 'NETWORK_PATH_FAILED' });
      expect(ms).toBeLessThan(1000);
    }
  });

  it('still validates a slow-but-working file within the timeout', async () => {
    await writeFile(join(dir, 'ok.png'), PNG);
    const v = await validateInputFile(join(dir, 'ok.png'), { headerTimeoutMs: 5000, cloudRoots: [real] });
    expect(v.format).toBe('png');
  });
});
