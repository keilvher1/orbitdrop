import { mkdtemp, readdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WHEEL_GEOMETRY } from '@orbitdrop/contracts';
import { convertedName, hitTestWheel, numberedName, placeWheel, sanitizeBaseName, toolResultName, detectFormatFromHeader } from '../src';
import { cleanupTempFiles, commitTempFile, makeTempPath, validateInputFile, writeOutput } from '../src/node';

describe('wheel hit-test', () => {
  const d = 360;
  it('center is a dead zone and beyond the radius is outside', () => {
    expect(hitTestWheel(0, 0, 4, d)).toEqual({ zone: 'center' });
    expect(hitTestWheel(0, -60, 4, d)).toEqual({ zone: 'center' });
    expect(hitTestWheel(0, -181, 4, d)).toEqual({ zone: 'outside' });
  });
  it('sector 0 is at the top and indices go clockwise', () => {
    expect(hitTestWheel(0, -120, 4, d)).toEqual({ zone: 'sector', index: 0 });
    expect(hitTestWheel(120, 0, 4, d)).toEqual({ zone: 'sector', index: 1 });
    expect(hitTestWheel(0, 120, 4, d)).toEqual({ zone: 'sector', index: 2 });
    expect(hitTestWheel(-120, 0, 4, d)).toEqual({ zone: 'sector', index: 3 });
  });
});

describe('wheel placement', () => {
  it('keeps the wheel inside the work area, including negative coordinates', () => {
    const work = { x: -1920, y: 0, width: 1920, height: 1080 };
    const p = placeWheel({ x: -1915, y: 5 }, work);
    const r = p.diameter / 2 + DEFAULT_WHEEL_GEOMETRY.edgePadding;
    expect(p.center.x).toBeCloseTo(-1920 + r);
    expect(p.center.y).toBeCloseTo(r);
    expect(p.shifted).toBe(true);
  });
});

describe('naming', () => {
  it('follows the product examples', () => {
    expect(convertedName('Page 001.pdf', '.jpg')).toBe('Page 001.jpg');
    expect(convertedName('report.pdf', '.jpg', { index: 1, count: 12 })).toBe('report-p002.jpg');
    expect(toolResultName('photo.jpg', ' Cropped', '.jpg')).toBe('photo Cropped.jpg');
    expect(toolResultName('photo Cropped.jpg', ' With Background', '.png')).toBe('photo Cropped With Background.png');
    expect(numberedName('photo.jpg', 3)).toBe('photo (3).jpg');
    expect(sanitizeBaseName('a:b*c?')).toBe('a_b_c_');
    expect(sanitizeBaseName('CON')).toBe('CON_');
  });
});

describe('safe output', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-core-'));
  });
  afterEach(async () => {
    await chmod(dir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('never overwrites and picks (2), (3)', async () => {
    await writeFile(join(dir, 'a.txt'), 'original');
    const first = await writeOutput(dir, 'a.txt', 'job1', (tmp) => writeFile(tmp, 'one'));
    const second = await writeOutput(dir, 'a.txt', 'job2', (tmp) => writeFile(tmp, 'two'));
    expect(first).toBe(join(dir, 'a (2).txt'));
    expect(second).toBe(join(dir, 'a (3).txt'));
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('original');
    expect((await readdir(dir)).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('concurrent commits get distinct names', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => writeOutput(dir, 'x.bin', `j${i}`, (tmp) => writeFile(tmp, String(i)))),
    );
    expect(new Set(results).size).toBe(8);
  });

  it('removes the temp file when the writer fails and cleans crash leftovers by tag only', async () => {
    await expect(writeOutput(dir, 'b.txt', 'job3', async (tmp) => {
      await writeFile(tmp, 'partial');
      throw new Error('boom');
    })).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
    const leftover = makeTempPath(dir, 'c.txt', 'crashed');
    await writeFile(leftover, 'x');
    await writeFile(join(dir, '.keep-me'), 'user file');
    expect(await cleanupTempFiles(dir, 'crashed')).toBe(1);
    expect(await readdir(dir)).toEqual(['.keep-me']);
  });

  it('commitTempFile claims the next free name', async () => {
    await writeFile(join(dir, 'd.txt'), 'user');
    const tmp = makeTempPath(dir, 'd.txt', 'j');
    await writeFile(tmp, 'new');
    expect(await commitTempFile(tmp, dir, 'd.txt')).toBe(join(dir, 'd (2).txt'));
  });
});

describe('input validation', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-val-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sniffs the real format and flags extension mismatches', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await writeFile(join(dir, 'fake.jpg'), png);
    const v = await validateInputFile(join(dir, 'fake.jpg'));
    expect(v.format).toBe('png');
    expect(v.extensionMismatch).toBe(true);
    await expect(validateInputFile(dir)).rejects.toMatchObject({ code: 'NOT_A_FILE' });
    await writeFile(join(dir, 'x.txt'), 'hello');
    await expect(validateInputFile(join(dir, 'x.txt'))).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    expect(detectFormatFromHeader(Buffer.from('%PDF-1.7\n'))).toBe('pdf');
  });
});
