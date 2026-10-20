import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrbitError } from '@orbitdrop/contracts';
import {
  TEMP_FILE_PREFIX,
  assertWritableDir,
  cleanupTempFiles,
  commitTempFile,
  discardTempFile,
  isTempFileName,
  makeTempPath,
  mapFsError,
  writeOutput,
} from '../src/node';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const posixPermissions = process.platform !== 'win32' && !isRoot;
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const fsError = (code: string) => Object.assign(new Error(code), { code });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-output-'));
});
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

async function tempLeftovers(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => isTempFileName(name));
}

describe('writeOutput', () => {
  it('never overwrites: picks name (2), (3) and leaves the original byte-identical', async () => {
    await writeFile(join(dir, 'a.txt'), 'original');
    const before = sha(await readFile(join(dir, 'a.txt')));
    const first = await writeOutput(dir, 'a.txt', 'job1', (tmp) => writeFile(tmp, 'one'));
    const second = await writeOutput(dir, 'a.txt', 'job2', (tmp) => writeFile(tmp, 'two'));
    expect(first).toBe(join(dir, 'a (2).txt'));
    expect(second).toBe(join(dir, 'a (3).txt'));
    expect(sha(await readFile(join(dir, 'a.txt')))).toBe(before);
    expect(await readFile(first, 'utf8')).toBe('one');
    expect(await tempLeftovers()).toEqual([]);
  });

  for (const strategy of ['auto', 'copy'] as const) {
    it(`gives 50 concurrent writers 50 distinct names with their own content (${strategy})`, async () => {
      await writeFile(join(dir, 'x.bin'), 'user file');
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          writeOutput(dir, 'x.bin', `job${i}`, async (tmp) => {
            await writeFile(tmp, `content-${i}-${'z'.repeat(i * 1000)}`);
          }, undefined, { strategy }),
        ),
      );
      expect(new Set(results).size).toBe(50);
      const expectedNames = new Set(Array.from({ length: 50 }, (_, i) => `x (${i + 2}).bin`));
      expect(new Set(results.map((p) => basename(p)))).toEqual(expectedNames);
      for (let i = 0; i < 50; i += 1) {
        expect(await readFile(results[i]!, 'utf8')).toBe(`content-${i}-${'z'.repeat(i * 1000)}`);
      }
      expect(await readFile(join(dir, 'x.bin'), 'utf8')).toBe('user file');
      expect(await tempLeftovers()).toEqual([]);
      expect((await readdir(dir)).length).toBe(51);
    });
  }

  for (const strategy of ['auto', 'copy'] as const) {
    it(`never replaces a file that appears between writing and committing (${strategy})`, async () => {
      const result = await writeOutput(dir, 'race.png', 'j', async (tmp) => {
        await writeFile(tmp, 'ours');
        // Another program (or a parallel job) creates the desired name meanwhile.
        await writeFile(join(dir, 'race.png'), 'theirs');
        await writeFile(join(dir, 'race (2).png'), 'theirs too');
      }, undefined, { strategy });
      expect(result).toBe(join(dir, 'race (3).png'));
      expect(await readFile(join(dir, 'race.png'), 'utf8')).toBe('theirs');
      expect(await readFile(join(dir, 'race (2).png'), 'utf8')).toBe('theirs too');
      expect(await readFile(result, 'utf8')).toBe('ours');
    });
  }

  it('treats names case-insensitively where the file system does (no overwrite either way)', async () => {
    await writeFile(join(dir, 'Photo.JPG'), 'user');
    const result = await writeOutput(dir, 'photo.jpg', 'j', (tmp) => writeFile(tmp, 'ours'));
    expect(await readFile(join(dir, 'Photo.JPG'), 'utf8')).toBe('user');
    expect(await readFile(result, 'utf8')).toBe('ours');
  });

  it('handles Korean (NFC and NFD), emoji and spaces in names', async () => {
    for (const name of ['사진 001.jpg', '사진.png', '🍊 orange slice.webp', '  spaced  name .tiff']) {
      const result = await writeOutput(dir, name, 'u', (tmp) => writeFile(tmp, name));
      expect(await readFile(result, 'utf8')).toBe(name);
    }
    expect(await tempLeftovers()).toEqual([]);
  });

  it.runIf(posixPermissions)('reports a read-only folder as OUTPUT_DIR_NOT_WRITABLE and leaves nothing behind', async () => {
    await writeFile(join(dir, 'keep.txt'), 'keep');
    await chmod(dir, 0o555);
    await expect(writeOutput(dir, 'out.png', 'ro', (tmp) => writeFile(tmp, 'x'))).rejects.toMatchObject({ code: 'OUTPUT_DIR_NOT_WRITABLE' });
    await expect(assertWritableDir(dir, 'ro')).rejects.toMatchObject({ code: 'OUTPUT_DIR_NOT_WRITABLE' });
    await chmod(dir, 0o755);
    expect(await readdir(dir)).toEqual(['keep.txt']);
  });

  it('does not call the writer when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await expect(
      writeOutput(dir, 'c.png', 'c', async () => {
        called = true;
      }, controller.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(called).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes the partial temp file when cancelled during the write', async () => {
    const controller = new AbortController();
    let tempSeen = '';
    await expect(
      writeOutput(dir, 'c.png', 'c', async (tmp) => {
        tempSeen = tmp;
        await writeFile(tmp, 'partial data');
        controller.abort();
      }, controller.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(tempSeen).not.toBe('');
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps an OrbitError abort reason (e.g. TIMEOUT from the job queue)', async () => {
    const controller = new AbortController();
    await expect(
      writeOutput(dir, 't.png', 't', async (tmp) => {
        await writeFile(tmp, 'x');
        controller.abort(new OrbitError('TIMEOUT', 'Job timed out'));
      }, controller.signal),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('maps writer failures and removes the temp file', async () => {
    await expect(writeOutput(dir, 'e.png', 'e', async (tmp) => {
      await writeFile(tmp, 'x');
      throw new OrbitError('IMAGE_CORRUPT', 'bad');
    })).rejects.toMatchObject({ code: 'IMAGE_CORRUPT' });
    await expect(writeOutput(dir, 'e.png', 'e', async (tmp) => {
      await writeFile(tmp, 'x');
      throw fsError('ENOSPC');
    })).rejects.toMatchObject({ code: 'DISK_FULL' });
    await expect(writeOutput(dir, 'e.png', 'e', async () => undefined)).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('commitTempFile', () => {
  it('claims the next free name and removes the temp name', async () => {
    await writeFile(join(dir, 'd.txt'), 'user');
    const tmp = makeTempPath(dir, 'd.txt', 'j');
    await writeFile(tmp, 'new');
    expect(await commitTempFile(tmp, dir, 'd.txt')).toBe(join(dir, 'd (2).txt'));
    expect(await tempLeftovers()).toEqual([]);
  });

  it('gives up after 999 taken names without touching any of them', async () => {
    await writeFile(join(dir, 'n.txt'), 'u1');
    for (let i = 2; i <= 999; i += 1) await writeFile(join(dir, `n (${i}).txt`), `u${i}`);
    const tmp = makeTempPath(dir, 'n.txt', 'full');
    await writeFile(tmp, 'new');
    await expect(commitTempFile(tmp, dir, 'n.txt')).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED', message: 'Could not find a free output name' });
    expect(await readFile(join(dir, 'n (500).txt'), 'utf8')).toBe('u500');
    await discardTempFile(tmp);
    expect((await readdir(dir)).length).toBe(999);
  });
});

describe('temp files', () => {
  it('are hidden, tagged, keep the extension last and stay short', () => {
    const p = makeTempPath(dir, 'photo Cropped.jpg', 'job-42');
    const name = basename(p);
    expect(name.startsWith(TEMP_FILE_PREFIX)).toBe(true);
    expect(name).toMatch(/^\.orbitdrop\.job-42\.[0-9a-f]{8}\.photo Cropped\.jpg$/);
    expect(isTempFileName(name, 'job-42')).toBe(true);
    expect(isTempFileName(name, 'job')).toBe(false);
    expect(isTempFileName(name)).toBe(true);
    const long = basename(makeTempPath(dir, `${'🍊'.repeat(60)}.png`, 'x'.repeat(64)));
    expect(new TextEncoder().encode(long).length).toBeLessThan(200);
    expect(long.endsWith('.png')).toBe(true);
    const odd = basename(makeTempPath(dir, 'a:b*c?. .png', 'j'));
    expect(odd).not.toMatch(/[:*?]/);
    expect(basename(makeTempPath(dir, '', 'j'))).toMatch(/^\.orbitdrop\.j\.[0-9a-f]{8}$/);
  });

  it('cleanupTempFiles removes only regular temp files of that exact tag', async () => {
    const mine = makeTempPath(dir, 'a.png', 'job');
    const other = makeTempPath(dir, 'a.png', 'job-1');
    const similar = makeTempPath(dir, 'a.png', 'job_1');
    await writeFile(mine, '1');
    await writeFile(other, '2');
    await writeFile(similar, '3');
    // Look-alike user files and a directory that must survive.
    await writeFile(join(dir, '.orbitdrop.job.zzzzzzzz.png'), 'user');
    await writeFile(join(dir, 'photo.orbitdrop.job.12345678.jpg'), 'user');
    await writeFile(join(dir, '.orbitdrop-job-12345678.png'), 'user');
    await mkdir(join(dir, '.orbitdrop.job.abcdef01.dir'));
    await writeFile(join(dir, 'photo.png'), 'user');
    expect(await cleanupTempFiles(dir, 'job')).toBe(1);
    const left = await readdir(dir);
    expect(left).not.toContain(basename(mine));
    expect(left).toContain(basename(other));
    expect(left).toContain(basename(similar));
    expect(left).toContain('.orbitdrop.job.abcdef01.dir');
    expect(left.length).toBe(7);
    expect(await cleanupTempFiles(join(dir, 'missing'), 'job')).toBe(0);
  });

  it('discardTempFile refuses to delete anything that is not a temp file', async () => {
    await writeFile(join(dir, 'keep.jpg'), 'user');
    await discardTempFile(join(dir, 'keep.jpg'));
    expect(await readFile(join(dir, 'keep.jpg'), 'utf8')).toBe('user');
  });
});

describe('assertWritableDir', () => {
  it('passes on a writable folder and leaves nothing behind', async () => {
    await assertWritableDir(dir, 'probe');
    expect(await readdir(dir)).toEqual([]);
  });

  it('asks for another folder when the location is missing or a file', async () => {
    await writeFile(join(dir, 'file'), 'x');
    await expect(assertWritableDir(join(dir, 'file'), 'p')).rejects.toMatchObject({ code: 'OUTPUT_DIR_NOT_WRITABLE' });
    await expect(assertWritableDir(join(dir, 'gone'), 'p')).rejects.toMatchObject({ code: 'OUTPUT_DIR_NOT_WRITABLE' });
    expect((await stat(join(dir, 'file'))).isFile()).toBe(true);
  });
});

describe('mapFsError', () => {
  it('maps errno codes for writes and reads', () => {
    const write = (code: string) => mapFsError(fsError(code)).code;
    const read = (code: string) => mapFsError(fsError(code), 'READ_PERMISSION_DENIED').code;
    expect(write('EACCES')).toBe('OUTPUT_DIR_NOT_WRITABLE');
    expect(write('EROFS')).toBe('OUTPUT_DIR_NOT_WRITABLE');
    expect(read('EACCES')).toBe('READ_PERMISSION_DENIED');
    expect(read('EBUSY')).toBe('READ_PERMISSION_DENIED');
    expect(write('EBUSY')).toBe('OUTPUT_WRITE_FAILED');
    expect(write('ENOSPC')).toBe('DISK_FULL');
    expect(write('EDQUOT')).toBe('DISK_FULL');
    expect(write('ENAMETOOLONG')).toBe('PATH_TOO_LONG');
    expect(read('ENOENT')).toBe('FILE_NOT_FOUND');
    expect(read('ENOTDIR')).toBe('FILE_NOT_FOUND');
    expect(write('ENOENT')).toBe('OUTPUT_WRITE_FAILED');
    expect(read('EISDIR')).toBe('NOT_A_FILE');
    expect(read('ELOOP')).toBe('SYMLINK_LOOP');
    for (const code of ['ETIMEDOUT', 'EHOSTDOWN', 'ENETUNREACH', 'ECONNRESET', 'ESTALE', 'ENOTCONN']) expect(read(code)).toBe('NETWORK_PATH_FAILED');
    expect(write('EIO')).toBe('OUTPUT_WRITE_FAILED');
    expect(read('EIO')).toBe('READ_PERMISSION_DENIED');
    expect(mapFsError('weird').detail).toBe('weird');
    expect(mapFsError(fsError('EPERM')).toInfo().retryable).toBe(true);
  });
});
