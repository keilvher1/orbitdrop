/**
 * Hardening pass over the processing pipeline through the public processor API: output names
 * on a real file system (long, NFD, emoji, device names, 20 jobs racing for one name), paths
 * (symlinks at the output name, symlinked folders, inputs that vanish or change type after
 * validation), preview/estimate caches after the file is replaced, and Add Background preview ↔
 * final parity at several output sizes. Results are re-read from disk.
 */
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_LIMITS, type ActionId, type FileFormat, type PreviewKind, type PreviewResult, type ProcessorInput, type ProcessorResult } from '@orbitdrop/contracts';
import { MAX_NAME_BYTES } from '@orbitdrop/core';
import { commitTempFile, isTempFileName, makeTempPath } from '@orbitdrop/core/node';
import { clearPreviewCaches, renderPreview, runJob } from '@orbitdrop/processors';

const settings = { pdfDpi: 300, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 } as const;

async function inputOf(path: string, format: FileFormat = 'jpeg', displayName = basename(path)): Promise<ProcessorInput> {
  return { fileId: `p${randomUUID().slice(0, 8)}`, path, displayName, sourceDir: dirname(path), format, bytes: (await stat(path).catch(() => ({ size: 1 }))).size };
}

function run(actionId: ActionId, input: ProcessorInput, options: unknown, outputDir: string | null = null): Promise<ProcessorResult> {
  return runJob(
    { jobId: `hp-${randomUUID().slice(0, 8)}`, actionId, inputs: [input], options, outputDir, settings, limits: DEFAULT_PROCESSING_LIMITS },
    { signal: new AbortController().signal, onProgress: () => undefined },
  );
}

function preview(kind: PreviewKind, input: ProcessorInput, options: unknown, maxEdge: number, assets?: Record<string, ProcessorInput>): Promise<PreviewResult> {
  return renderPreview(
    { previewId: randomUUID(), kind, input, options, maxEdge, settings, limits: DEFAULT_PROCESSING_LIMITS, ...(assets ? { assets } : {}) },
    { signal: new AbortController().signal },
  );
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'THROW';
  }
}

const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');
const temps = async (dir: string) => (await readdir(dir)).filter((n) => isTempFileName(n));
const CROP = { rect: { x: 0, y: 0, width: 8, height: 8 } };
const BG = { background: { kind: 'solid', color: '#FFFFFF' }, padding: 4, cornerRadius: 0, shadow: 0, ratio: 'auto', maxEdge: 2400, format: 'png', quality: 90 };

describe('pipeline hardening: names, paths, caches, parity', () => {
  let dir: string;
  let jpeg: Buffer;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-hard-pipeline-'));
    jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#808080' } }).jpeg().toBuffer();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('long, NFD, emoji and reserved names: ≤ 255 bytes, NFC, whole graphemes, extension kept', async () => {
    const sub = join(dir, 'names');
    await mkdir(sub);
    const family = '👨‍👩‍👧‍👦';
    const names = [
      `${'é'.repeat(125)}.jpeg`, // exactly 255 bytes (NFC)
      `${'a'.repeat(215)}${family}b.jpg`, // the cut falls inside the ZWJ sequence
      `${family.repeat(9)}.jpg`,
      `${'사진'.normalize('NFD')} 테스트.jpg`,
      'CON.jpg',
      'nul .jpg',
    ];
    for (const name of names) {
      expect(utf8(name), name.slice(0, 10)).toBeLessThanOrEqual(MAX_NAME_BYTES);
      const path = join(sub, name);
      await writeFile(path, jpeg);
      const input = await inputOf(path);
      for (const [actionId, options] of [
        ['tool.addBackground', BG],
        ['tool.crop', CROP],
        ['convert.png', {}],
        ['convert.png', {}],
      ] as const) {
        const out = basename((await run(actionId, input, options)).outputs[0]!.path);
        const label = `${name.slice(0, 12)} ${actionId}`;
        expect(utf8(out), label).toBeLessThanOrEqual(MAX_NAME_BYTES);
        expect(out, label).toBe(out.normalize('NFC'));
        expect(/\p{Cs}/u.test(out), label).toBe(false); // no lone surrogate (half a code point)
        expect(out.endsWith(actionId === 'convert.png' || actionId === 'tool.addBackground' ? '.png' : name.slice(name.lastIndexOf('.'))), label).toBe(true);
        // Never half an emoji sequence: every family emoji in the name is complete.
        expect(out.replaceAll(family, '').includes('‍'), label).toBe(false);
        expect(/^(con|nul)[ .]/i.test(out), label).toBe(false);
      }
    }
    expect(await temps(sub)).toEqual([]);
  });

  it('20 jobs racing for the same long name get 20 distinct files, no temp files left', async () => {
    const sub = join(dir, 'race');
    await mkdir(sub);
    const path = join(sub, `${'x'.repeat(250)}.jpg`);
    await writeFile(path, jpeg);
    const input = await inputOf(path);
    const results = await Promise.all(Array.from({ length: 20 }, () => run('tool.crop', input, CROP)));
    const outputs = results.map((r) => r.outputs[0]!.path);
    expect(new Set(outputs).size).toBe(20);
    for (const out of outputs) {
      expect(utf8(basename(out))).toBeLessThanOrEqual(MAX_NAME_BYTES);
      expect((await sharp(out).metadata()).width).toBe(8);
    }
    expect(await temps(sub)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('an output name taken by a symlink (dangling or not) is never followed or replaced', async () => {
    const sub = join(dir, 'links');
    await mkdir(join(sub, 'elsewhere'), { recursive: true });
    await writeFile(join(sub, 'photo.jpg'), jpeg);
    await writeFile(join(sub, 'elsewhere', 'victim.jpg'), 'VICTIM');
    await symlink(join(sub, 'nowhere', 'target.png'), join(sub, 'photo.png'));
    await symlink(join(sub, 'elsewhere', 'victim.jpg'), join(sub, 'photo Cropped.jpg'));
    const input = await inputOf(join(sub, 'photo.jpg'));
    expect(basename((await run('convert.png', input, {})).outputs[0]!.path)).toBe('photo (2).png');
    expect(basename((await run('tool.crop', input, CROP)).outputs[0]!.path)).toBe('photo Cropped (2).jpg');
    expect(await readlink(join(sub, 'photo.png'))).toBe(join(sub, 'nowhere', 'target.png'));
    expect(await readFile(join(sub, 'elsewhere', 'victim.jpg'), 'utf8')).toBe('VICTIM');
    await expect(stat(join(sub, 'nowhere'))).rejects.toThrow();
    // The copy fallback (file systems without hard links) refuses the dangling link as well.
    const temp = makeTempPath(sub, 'x.bin', 'job1');
    await writeFile(temp, 'DATA');
    await symlink(join(sub, 'nowhere2', 'y'), join(sub, 'x.bin'));
    const committed = await commitTempFile(temp, sub, 'x.bin', { strategy: 'copy' });
    expect(basename(committed)).toBe('x (2).bin');
    expect((await lstat(join(sub, 'x.bin'))).isSymbolicLink()).toBe(true);
    // A symlinked output folder receives the file in the folder it points to.
    await mkdir(join(sub, 'real-out'));
    await symlink(join(sub, 'real-out'), join(sub, 'link-out'));
    await run('convert.webp', input, {}, join(sub, 'link-out'));
    expect(await readdir(join(sub, 'real-out'))).toEqual(['photo.webp']);
    expect(await temps(sub)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('inputs that vanish, turn into a folder, lose permission or loop after validation get clear codes', async () => {
    const sub = join(dir, 'vanish');
    await mkdir(sub);
    const path = join(sub, 'photo.jpg');
    await writeFile(path, jpeg);
    const input = await inputOf(path);
    await rename(path, join(sub, 'moved.jpg'));
    const jobs = [['convert.png', {}], ['tool.crop', CROP]] as const;
    for (const [actionId, options] of jobs) expect(await codeOf(run(actionId, input, options)), actionId).toBe('FILE_NOT_FOUND');
    await mkdir(path);
    for (const [actionId, options] of jobs) expect(await codeOf(run(actionId, input, options)), actionId).toBe('NOT_A_FILE');
    const locked = join(sub, 'locked.jpg');
    await writeFile(locked, jpeg);
    await chmod(locked, 0o000);
    for (const [actionId, options] of jobs) expect(await codeOf(run(actionId, await inputOf(locked), options)), actionId).toBe('READ_PERMISSION_DENIED');
    await chmod(locked, 0o644);
    await symlink(join(sub, 'loop-b'), join(sub, 'loop-a'));
    await symlink(join(sub, 'loop-a'), join(sub, 'loop-b'));
    expect(await codeOf(run('convert.png', await inputOf(join(sub, 'loop-a'), 'jpeg', 'loop-a.jpg'), {}))).toBe('SYMLINK_LOOP');
    expect(await temps(sub)).toEqual([]);
  });

  it('previews and Compress estimates follow a file replaced by one of the same size and mtime', async () => {
    const sub = join(dir, 'stale');
    await mkdir(sub);
    clearPreviewCaches();
    const make = (colour: string) => sharp({ create: { width: 64, height: 48, channels: 3, background: colour } }).png().toBuffer();
    const red = await make('#ff0000');
    const blue = await make('#0000ff');
    expect(red.length).toBe(blue.length);
    const path = join(sub, 'img.png');
    const when = new Date('2026-01-02T03:04:05.000Z');
    await writeFile(path, blue);
    await utimes(path, when, when);
    const before = await stat(path);
    const input = await inputOf(path, 'png');
    const centre = async (p: PreviewResult) => [...(await sharp(p.data).raw().toBuffer()).subarray(0, 3)];
    const options = { format: 'jpeg', quality: 80 };
    expect(await centre(await preview('source', input, {}, 64))).toEqual([0, 0, 254]);
    expect(await centre(await preview('tool.compress', input, options, 64))).toEqual([0, 0, 254]);
    // Replace it the way a "safe save" or a Finder copy does: another file of the same size,
    // renamed over it, carrying the same mtime (Finder and `cp -p` keep the source's mtime).
    const other = join(sub, 'other.png');
    await writeFile(other, red);
    await utimes(other, when, when);
    await rename(other, path);
    const after = await stat(path);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    const [r, , b] = await centre(await preview('source', input, {}, 64));
    expect(r! > 200 && b! < 50).toBe(true);
    const [cr, , cb] = await centre(await preview('tool.compress', input, options, 64));
    expect(cr! > 200 && cb! < 50).toBe(true);
    const estimate = await renderPreview(
      { previewId: randomUUID(), kind: 'tool.compress', input, options, maxEdge: 64, settings, limits: DEFAULT_PROCESSING_LIMITS, estimateOnly: true },
      { signal: new AbortController().signal },
    );
    const real = await run('tool.compress', input, options, sub);
    expect(estimate.estimatedBytes).toBe(real.outputs[0]!.bytes);
  });

  it('Add Background: preview reports the final size and matches the downscaled final at every output size', async () => {
    const sub = join(dir, 'parity');
    await mkdir(sub);
    const w = 900;
    const h = 600;
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) raw.set([(x * 255) / w, (y * 255) / h, ((x >> 6) + (y >> 6)) % 2 ? 200 : 60], (y * w + x) * 3);
    const photo = join(sub, 'photo.jpg');
    await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toFile(photo);
    const backdrop = join(sub, 'backdrop.png');
    await sharp({ create: { width: 120, height: 360, channels: 3, background: '#22aa55' } }).png().toFile(backdrop);
    const input = await inputOf(photo);
    const bgInput = await inputOf(backdrop, 'png');
    for (const maxEdge of [256, 700, 2400]) {
      for (const ratio of ['auto', '1:1', '16:9', '4:5'] as const) {
        for (const background of [{ kind: 'preset', presetId: 'aurora' }, { kind: 'image', fileId: bgInput.fileId }]) {
          const options = { background, padding: 60, cornerRadius: 40, shadow: 80, ratio, maxEdge, format: 'png', quality: 90 };
          const final = await runJob(
            { jobId: `parity-${randomUUID().slice(0, 6)}`, actionId: 'tool.addBackground', inputs: [input], options, outputDir: sub, settings, limits: DEFAULT_PROCESSING_LIMITS, assets: { [bgInput.fileId]: bgInput } },
            { signal: new AbortController().signal, onProgress: () => undefined },
          );
          const out = final.outputs[0]!;
          const p = await preview('tool.addBackground', input, options, 320, { [bgInput.fileId]: bgInput });
          const label = `${maxEdge} ${ratio} ${background.kind}`;
          expect([p.outputWidth, p.outputHeight], label).toEqual([out.width, out.height]);
          const shown = await sharp(p.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          const scaled = await sharp(out.path).resize(shown.info.width, shown.info.height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
          let sum = 0;
          for (let i = 0; i < scaled.length; i += 1) sum += Math.abs(scaled[i]! - shown.data[i]!);
          expect(sum / scaled.length, label).toBeLessThan(4);
        }
      }
    }
  });
});
