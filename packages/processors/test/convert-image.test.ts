import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrbitError, type ActionId } from '@orbitdrop/contracts';
import { decodeBmp } from '../src/codecs/bmp';
import { runConvert } from '../src/convert';
import { inputFor, listFiles, makeCtx, makeFixtureDir, makeJob, sha256, staticFixture, tempFilesIn, type FixtureDir } from './helpers/convert-fixtures';

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<OrbitError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OrbitError);
  expect((error as OrbitError).code).toBe(code);
  return error as OrbitError;
}

async function rgbaAt(path: string, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * 4;
  return [data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!];
}

describe('image → image conversions (P0-B, P1 TIFF/AVIF, P2 BMP)', () => {
  let fx: FixtureDir;

  beforeAll(async () => {
    fx = await makeFixtureDir();
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it.each([
    ['photo.jpg', 'convert.png', 'png', 'photo.png', [320, 240]],
    ['photo.jpg', 'convert.webp', 'webp', 'photo.webp', [320, 240]],
    ['photo.jpg', 'convert.avif', 'heif', 'photo.avif', [320, 240]],
    ['photo.jpg', 'convert.tiff', 'tiff', 'photo.tiff', [320, 240]],
    ['sample.webp', 'convert.jpeg', 'jpeg', 'sample.jpg', [64, 48]],
    ['sample.webp', 'convert.png', 'png', 'sample.png', [64, 48]],
    ['landscape.png', 'convert.jpeg', 'jpeg', 'landscape.jpg', [300, 200]],
    ['landscape.png', 'convert.webp', 'webp', 'landscape.webp', [300, 200]],
    ['sample.tiff', 'convert.jpeg', 'jpeg', 'sample (2).jpg', [50, 40]],
    ['sample.avif', 'convert.png', 'png', 'sample (2).png', [48, 32]],
    ['sample.gif', 'convert.png', 'png', 'sample (3).png', [30, 20]],
  ] as const)('%s → %s gives a real %s file', async (name, action, sharpFormat, outName, size) => {
    const input = await fx.input(name);
    const before = await sha256(input.path);
    const { ctx, progress } = makeCtx();
    const result = await runConvert(makeJob(action as ActionId, [input]), ctx);
    expect(result.outputs).toHaveLength(1);
    const out = result.outputs[0]!;
    expect(out.path).toBe(join(fx.dir, outName));
    const meta = await sharp(out.path).metadata();
    expect(meta.format).toBe(sharpFormat);
    expect([meta.width, meta.height]).toEqual(size);
    expect([out.width, out.height]).toEqual(size);
    expect(await sha256(input.path)).toBe(before);
    expect(progress.map((p) => (p.kind === 'indeterminate' ? p.stage : 'x'))).toEqual(['reading', 'decoding', 'encoding', 'writing']);
    expect(await tempFilesIn(fx.dir)).toEqual([]);
  });

  it('JPG → BMP writes a 24-bit BMP that our decoder and macOS ImageIO (sips) both read', async () => {
    const result = await runConvert(makeJob('convert.bmp', [await fx.input('photo.jpg')]), makeCtx().ctx);
    const out = result.outputs[0]!;
    expect(out.path).toBe(join(fx.dir, 'photo.bmp'));
    const bytes = await readFile(out.path);
    expect(bytes.readUInt16LE(28)).toBe(24);
    const decoded = decodeBmp(bytes, 1e8);
    expect([decoded.width, decoded.height]).toEqual([320, 240]);
    const reference = await sharp(await readFile(fx.path('photo.jpg'))).ensureAlpha().raw().toBuffer();
    expect(decoded.data.equals(reference)).toBe(true);
    if (process.platform === 'darwin') {
      const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', out.path], { encoding: 'utf8' });
      expect(info).toMatch(/pixelWidth: 320/);
      expect(info).toMatch(/pixelHeight: 240/);
      expect(info).toMatch(/format: bmp/);
    }
  });

  it('transparent PNG → JPEG flattens onto white and warns ALPHA_FLATTENED', async () => {
    const result = await runConvert(makeJob('convert.jpeg', [await fx.input('transparent.png')]), makeCtx().ctx);
    const out = result.outputs[0]!;
    expect(result.warnings).toContainEqual({ code: 'ALPHA_FLATTENED', params: { background: '#FFFFFF' } });
    const meta = await sharp(out.path).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', channels: 3, hasAlpha: false });
    const left = await rgbaAt(out.path, 8, 24);
    const right = await rgbaAt(out.path, 56, 24);
    expect(Math.min(...left.slice(0, 3))).toBeGreaterThan(245);
    expect(right[1]).toBeGreaterThan(170);
    expect(right[0]).toBeLessThan(40);
  });

  it('flattens onto a custom background colour', async () => {
    const sub = await makeFixtureDir(['transparent.png']);
    try {
      const result = await runConvert(makeJob('convert.jpeg', [await sub.input('transparent.png')], { flattenBackground: '#0000FF' }), makeCtx().ctx);
      const left = await rgbaAt(result.outputs[0]!.path, 8, 24);
      expect(left[2]).toBeGreaterThan(230);
      expect(left[0]).toBeLessThan(30);
    } finally {
      await sub.cleanup();
    }
  });

  it('transparent PNG → WebP/BMP keeps the alpha channel (no warning)', async () => {
    const webp = await runConvert(makeJob('convert.webp', [await fx.input('transparent.png')]), makeCtx().ctx);
    expect(webp.warnings.find((w) => w.code === 'ALPHA_FLATTENED')).toBeUndefined();
    expect((await rgbaAt(webp.outputs[0]!.path, 8, 24))[3]).toBe(0);
    expect((await rgbaAt(webp.outputs[0]!.path, 56, 24))[3]).toBe(255);

    const bmp = await runConvert(makeJob('convert.bmp', [await fx.input('transparent.png')]), makeCtx().ctx);
    const bytes = await readFile(bmp.outputs[0]!.path);
    expect(bytes.readUInt16LE(28)).toBe(32);
    const decoded = decodeBmp(bytes, 1e6);
    expect(decoded.data[(24 * 64 + 8) * 4 + 3]).toBe(0);
    expect([...decoded.data.subarray((24 * 64 + 56) * 4, (24 * 64 + 56) * 4 + 4)]).toEqual([0, 200, 0, 255]);
  });

  it('applies EXIF orientation 6 to the pixels (30×60, red on top) and leaves no orientation tag', async () => {
    const result = await runConvert(makeJob('convert.png', [await fx.input('exif-orientation-6.jpg')]), makeCtx().ctx);
    const out = result.outputs[0]!;
    expect([out.width, out.height]).toEqual([30, 60]);
    const meta = await sharp(out.path).metadata();
    expect([meta.width, meta.height]).toEqual([30, 60]);
    expect(meta.orientation ?? 1).toBe(1);
    const top = await rgbaAt(out.path, 15, 5);
    const bottom = await rgbaAt(out.path, 15, 55);
    expect(top[0]).toBeGreaterThan(200);
    expect(top[2]).toBeLessThan(60);
    expect(bottom[2]).toBeGreaterThan(200);
    expect(bottom[0]).toBeLessThan(60);
  });

  it('drops EXIF by default (METADATA_REMOVED) and keeps it with keepMetadata', async () => {
    const sub = await makeFixtureDir(['photo.jpg']);
    try {
      const stripped = await runConvert(makeJob('convert.webp', [await sub.input('photo.jpg')]), makeCtx().ctx);
      expect(stripped.warnings).toContainEqual({ code: 'METADATA_REMOVED', params: { kinds: 'exif' } });
      expect((await sharp(stripped.outputs[0]!.path).metadata()).exif).toBeUndefined();

      const kept = await runConvert(makeJob('convert.webp', [await sub.input('photo.jpg')], { keepMetadata: true }), makeCtx().ctx);
      expect(kept.warnings.find((w) => w.code === 'METADATA_REMOVED')).toBeUndefined();
      const exif = (await sharp(kept.outputs[0]!.path).metadata()).exif;
      expect(exif?.includes('OrbitDrop')).toBe(true);
      expect(kept.outputs[0]!.path).toBe(join(sub.dir, 'photo (2).webp'));
    } finally {
      await sub.cleanup();
    }
  });

  it('quality changes the JPEG encoding', async () => {
    const sub = await makeFixtureDir(['photo.jpg']);
    try {
      const input = await sub.input('photo.jpg');
      const low = await runConvert(makeJob('convert.webp', [input], { quality: 20 }), makeCtx().ctx);
      const high = await runConvert(makeJob('convert.webp', [input], { quality: 98 }), makeCtx().ctx);
      expect(low.outputs[0]!.bytes).toBeLessThan(high.outputs[0]!.bytes);
    } finally {
      await sub.cleanup();
    }
  });

  it('a PNG named .jpg converts by its real format, never overwrites itself and warns EXTENSION_MISMATCH', async () => {
    const input = await fx.input('png-named.jpg');
    expect(input.format).toBe('png');
    const before = await sha256(input.path);
    const result = await runConvert(makeJob('convert.jpeg', [input]), makeCtx().ctx);
    expect(result.outputs[0]!.path).toBe(join(fx.dir, 'png-named (2).jpg'));
    expect((await sharp(result.outputs[0]!.path).metadata()).format).toBe('jpeg');
    expect(await sha256(input.path)).toBe(before);
    expect(result.warnings).toContainEqual({ code: 'EXTENSION_MISMATCH', params: { detected: 'PNG', extension: '.jpg' } });
  });

  it('keeps Korean, spaces and emoji in the output name', async () => {
    const result = await runConvert(makeJob('convert.png', [await fx.input('사진 테스트 😀.jpg')]), makeCtx().ctx);
    expect(result.outputs[0]!.path).toBe(join(fx.dir, '사진 테스트 😀.png'));
    expect((await sharp(result.outputs[0]!.path).metadata()).format).toBe('png');
  });

  it('writes into job.outputDir when one is chosen', async () => {
    const other = await mkdtemp(join(tmpdir(), 'orbitdrop-convert-out-'));
    try {
      const result = await runConvert(makeJob('convert.png', [await fx.input('sample.webp')], {}, { outputDir: other }), makeCtx().ctx);
      expect(result.outputs[0]!.path).toBe(join(other, 'sample.png'));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a read-only output folder fails with OUTPUT_DIR_NOT_WRITABLE and leaves nothing', async () => {
    const locked = await mkdtemp(join(tmpdir(), 'orbitdrop-convert-ro-'));
    try {
      await chmod(locked, 0o555);
      await rejectsWith(runConvert(makeJob('convert.png', [await fx.input('sample.webp')], {}, { outputDir: locked }), makeCtx().ctx), 'OUTPUT_DIR_NOT_WRITABLE');
      expect(await listFiles(locked)).toEqual([]);
    } finally {
      await chmod(locked, 0o755);
      await rm(locked, { recursive: true, force: true });
    }
  });

  it('rejects a same-format conversion of a correctly named file (it should never be offered) with INVALID_OPTIONS', async () => {
    await rejectsWith(runConvert(makeJob('convert.jpeg', [await fx.input('photo.jpg')]), makeCtx().ctx), 'INVALID_OPTIONS');
  });

  it('a PNG named .jpg dropped on PNG is re-encoded into a correctly named PNG (EXTENSION_MISMATCH), original untouched', async () => {
    const input = await fx.input('png-named.jpg');
    const before = await sha256(input.path);
    const result = await runConvert(makeJob('convert.png', [input]), makeCtx().ctx);
    expect(result.outputs[0]!.path).toBe(join(fx.dir, 'png-named.png'));
    const [src, out] = await Promise.all([
      sharp(input.path).raw().toBuffer({ resolveWithObject: true }),
      sharp(result.outputs[0]!.path).raw().toBuffer({ resolveWithObject: true }),
    ]);
    expect((await sharp(result.outputs[0]!.path).metadata()).format).toBe('png');
    expect([out.info.width, out.info.height, out.info.channels]).toEqual([src.info.width, src.info.height, src.info.channels]);
    expect(out.data.equals(src.data)).toBe(true); // PNG → PNG is lossless
    expect(await sha256(input.path)).toBe(before);
    expect(result.warnings).toContainEqual({ code: 'EXTENSION_MISMATCH', params: { detected: 'PNG', extension: '.jpg' } });
  });

  it('rejects invalid options with INVALID_OPTIONS', async () => {
    await rejectsWith(runConvert(makeJob('convert.png', [await fx.input('photo.jpg')], { quality: 500 }), makeCtx().ctx), 'INVALID_OPTIONS');
    await rejectsWith(runConvert(makeJob('convert.png', [await fx.input('photo.jpg')], { unknown: true }), makeCtx().ctx), 'INVALID_OPTIONS');
  });

  it('reports a truncated JPEG as IMAGE_CORRUPT and writes nothing', async () => {
    const before = await listFiles(fx.dir);
    await rejectsWith(runConvert(makeJob('convert.png', [await fx.input('corrupt.jpg')]), makeCtx().ctx), 'IMAGE_CORRUPT');
    expect(await listFiles(fx.dir)).toEqual(before);
  });

  it('enforces limits.maxInputPixels with IMAGE_TOO_LARGE', async () => {
    await rejectsWith(runConvert(makeJob('convert.png', [await fx.input('photo.jpg')], {}, { limits: { maxInputPixels: 10_000 } }), makeCtx().ctx), 'IMAGE_TOO_LARGE');
  });

  it('honours cancellation before writing', async () => {
    const sub = await makeFixtureDir(['photo.jpg']);
    try {
      const { ctx } = makeCtx((p, controller) => {
        if (p.kind === 'indeterminate' && p.stage === 'encoding') controller.abort();
      });
      await rejectsWith(runConvert(makeJob('convert.png', [await sub.input('photo.jpg')]), ctx), 'CANCELLED');
      expect(await listFiles(sub.dir)).toEqual(['photo.jpg']);
    } finally {
      await sub.cleanup();
    }
  });

  it.skipIf(Boolean(process.env.ORBITDROP_IMAGEIO_HELPER))('HEIC output without the ImageIO helper fails with ENGINE_UNAVAILABLE (and writes nothing)', async () => {
    const sub = await makeFixtureDir(['photo.jpg']);
    try {
      await rejectsWith(runConvert(makeJob('convert.heic', [await sub.input('photo.jpg')]), makeCtx().ctx), 'ENGINE_UNAVAILABLE');
      expect(await listFiles(sub.dir)).toEqual(['photo.jpg']);
    } finally {
      await sub.cleanup();
    }
  });

  it('BMP written by macOS ImageIO (static fixture) converts to PNG with identical pixels', async () => {
    const bmpPath = staticFixture('sips-rgba32.bmp');
    const pngPath = staticFixture('sips-source-rgba.png');
    expect(bmpPath && pngPath).toBeTruthy();
    const sub = await makeFixtureDir([]);
    try {
      const copy = join(sub.dir, 'from-sips.bmp');
      await (await import('node:fs/promises')).copyFile(bmpPath!, copy);
      const result = await runConvert(makeJob('convert.png', [await inputFor(copy)]), makeCtx().ctx);
      const got = await sharp(result.outputs[0]!.path).ensureAlpha().raw().toBuffer();
      const want = await sharp(pngPath!).ensureAlpha().raw().toBuffer();
      expect(got.length).toBe(want.length);
      // Fully transparent pixels have no visible colour (the PNG encoder may normalise it).
      const visible = (px: Buffer) => [...px].map((v, i, all) => (all[i - (i % 4) + 3] === 0 ? 0 : v));
      expect(visible(got)).toEqual(visible(want));
      expect(want.filter((_, i) => i % 4 === 3 && want[i] === 0).length).toBeGreaterThan(0);
    } finally {
      await sub.cleanup();
    }
  });
});
