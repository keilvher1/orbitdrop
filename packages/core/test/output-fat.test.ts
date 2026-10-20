import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTempFileName, writeOutput } from '../src/node';

/**
 * Real FAT32 volume (no hard links): macOS only and opt-in, because it creates
 * and mounts a disk image (privately, -nobrowse, under the temp folder).
 *   ORBITDROP_FS_TESTS=1 node_modules/.bin/vitest run --root packages/core test/output-fat.test.ts
 */
const enabled = process.platform === 'darwin' && process.env.ORBITDROP_FS_TESTS === '1';

describe.runIf(enabled)('writeOutput on a real FAT32 volume', () => {
  let work = '';
  let mountPoint = '';

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'orbitdrop-fat-'));
    mountPoint = join(work, 'mnt');
    await mkdir(mountPoint);
    const image = join(work, 'fat.dmg');
    execFileSync('hdiutil', ['create', '-size', '40m', '-fs', 'MS-DOS FAT32', '-volname', 'ODTEST', '-layout', 'NONE', image], { stdio: 'ignore' });
    execFileSync('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, image], { stdio: 'ignore' });
  }, 60_000);

  afterAll(async () => {
    try {
      execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'ignore' });
    } catch {
      execFileSync('hdiutil', ['detach', '-force', mountPoint], { stdio: 'ignore' });
    }
    await rm(work, { recursive: true, force: true });
  }, 60_000);

  it('commits through the exclusive-copy fallback without overwriting', async () => {
    await writeFile(join(mountPoint, 'photo.png'), 'user');
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => writeOutput(mountPoint, 'photo.png', `j${i}`, (tmp) => writeFile(tmp, `w${i}`))));
    expect(new Set(results).size).toBe(20);
    for (let i = 0; i < 20; i += 1) expect(await readFile(results[i]!, 'utf8')).toBe(`w${i}`);
    expect(await readFile(join(mountPoint, 'photo.png'), 'utf8')).toBe('user');
    expect((await readdir(mountPoint)).filter((n) => isTempFileName(n))).toEqual([]);
    // FAT is case-insensitive: a differently cased name is taken too.
    const upper = await writeOutput(mountPoint, 'PHOTO.PNG', 'case', (tmp) => writeFile(tmp, 'upper'));
    expect(upper.endsWith('PHOTO (22).PNG')).toBe(true);
  }, 60_000);
});
