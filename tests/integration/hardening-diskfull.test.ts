/**
 * Disk full on a real volume (hardening pass): macOS only and opt-in, because it creates and
 * mounts a tiny disk image (privately, -nobrowse, under the temp folder) — like core's FAT32 test.
 *   ORBITDROP_FS_TESTS=1 node_modules/.bin/vitest run --root tests/integration hardening-diskfull.test.ts
 * Every job must fail with DISK_FULL, leave no temp file and no partial result (a multi-page
 * PDF removes the pages it had already committed).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_LIMITS, type ActionId, type FileFormat, type ProcessorInput } from '@orbitdrop/contracts';
import { runJob } from '@orbitdrop/processors';

const enabled = process.platform === 'darwin' && process.env.ORBITDROP_FS_TESTS === '1';
const settings = { pdfDpi: 300, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 } as const;

describe.runIf(enabled)('disk full on a 4 MB HFS+ volume', () => {
  let work = '';
  let mountPoint = '';
  let photo: ProcessorInput;
  let pdf: ProcessorInput;

  const inputOf = (path: string, format: FileFormat): ProcessorInput => ({ fileId: `d${randomUUID().slice(0, 8)}`, path, displayName: basename(path), sourceDir: dirname(path), format, bytes: 1 });
  const run = async (actionId: ActionId, input: ProcessorInput, options: unknown, committed: string[] = []) => {
    try {
      await runJob(
        { jobId: `df-${randomUUID().slice(0, 8)}`, actionId, inputs: [input], options, outputDir: mountPoint, settings, limits: DEFAULT_PROCESSING_LIMITS },
        { signal: new AbortController().signal, onProgress: () => undefined, onCommitted: (o) => committed.push(o.path) },
      );
      return 'ok';
    } catch (error) {
      return (error as { code?: string }).code ?? 'THROW';
    }
  };
  const userFiles = async () => (await readdir(mountPoint)).filter((n) => !n.startsWith('.Trashes') && !n.startsWith('.fseventsd') && !n.startsWith('.Spotlight') && !n.startsWith('fill-'));
  const leftovers = async () => (await readdir(mountPoint)).filter((n) => n.startsWith('.orbitdrop'));

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'orbitdrop-diskfull-'));
    mountPoint = join(work, 'mnt');
    await mkdir(mountPoint);
    const image = join(work, 'tiny.dmg');
    execFileSync('hdiutil', ['create', '-size', '4m', '-fs', 'HFS+', '-volname', 'ODFULL', image], { stdio: 'ignore' });
    execFileSync('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, image], { stdio: 'ignore' });
    // Inputs live outside the tiny volume.
    const w = 3000;
    const h = 2000;
    const noise = Buffer.alloc(w * h * 3);
    let s = 11;
    for (let i = 0; i < noise.length; i += 1) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = (s >> 16) & 255;
    }
    await sharp(noise, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toFile(join(work, 'photo.jpg'));
    photo = inputOf(join(work, 'photo.jpg'), 'jpeg');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 12; n += 1) {
      const page = doc.addPage([612, 792]);
      for (let line = 0; line < 50; line += 1) page.drawText(`Page ${n} line ${line}: the quick brown fox jumps over the lazy dog`, { x: 36, y: 760 - line * 14, size: 11, font });
    }
    await writeFile(join(work, 'doc.pdf'), await doc.save());
    pdf = inputOf(join(work, 'doc.pdf'), 'pdf');
  }, 120_000);

  afterAll(async () => {
    try {
      execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'ignore' });
    } catch {
      execFileSync('hdiutil', ['detach', '-force', mountPoint], { stdio: 'ignore' });
    }
    await rm(work, { recursive: true, force: true });
  }, 60_000);

  it('large outputs fail with DISK_FULL and leave nothing behind', async () => {
    expect(await run('convert.png', photo, {})).toBe('DISK_FULL');
    expect(await run('convert.tiff', photo, {})).toBe('DISK_FULL');
    expect(await run('tool.crop', photo, { rect: { x: 0, y: 0, width: 2500, height: 1800 }, outputFormat: 'png' })).toBe('DISK_FULL');
    expect(await userFiles()).toEqual([]);
    expect(await leftovers()).toEqual([]);
  }, 120_000);

  it('a multi-page PDF that runs out of space removes the pages it had committed', async () => {
    const committed: string[] = [];
    expect(await run('convert.png', pdf, { dpi: 300 }, committed)).toBe('DISK_FULL');
    expect(committed.length).toBeGreaterThan(0);
    expect(await userFiles()).toEqual([]);
    expect(await leftovers()).toEqual([]);
  }, 120_000);

  it('a full volume fails small jobs with DISK_FULL too', async () => {
    let n = 0;
    for (const size of [1 << 20, 1 << 16, 1 << 12, 512]) {
      const chunk = Buffer.alloc(size, 1);
      try {
        for (;;) await writeFile(join(mountPoint, `fill-${size}-${(n += 1)}.bin`), chunk);
      } catch {
        // next, smaller size
      }
    }
    const small = join(work, 'small.jpg');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).jpeg().toFile(small);
    expect(await run('convert.png', inputOf(small, 'jpeg'), {})).toBe('DISK_FULL');
    expect(await run('tool.compress', inputOf(small, 'jpeg'), {})).toBe('DISK_FULL');
    expect(await run('convert.txt', pdf, {})).toBe('DISK_FULL');
    expect(await userFiles()).toEqual([]);
    expect(await leftovers()).toEqual([]);
  }, 120_000);
});
