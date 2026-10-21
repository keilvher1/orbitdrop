import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMAGEIO_HELPER_ENV } from '../src/codecs/imageio';
import { cachedSourceCount, clearPreviewCaches } from '../src/tools/source-cache';
import {
  BLUE,
  GREEN,
  RED,
  YELLOW,
  bmp24,
  exifSegment,
  fakeHeic,
  inputFor,
  insertJpegSegments,
  makeTempDir,
  near,
  noisyRaw,
  preview,
  px,
  quadrantJpeg,
  quadrantRaw,
  readRgba,
  removeDir,
  writeFakeImageIOHelper,
  writeFixture,
} from './helpers/tools-fixtures';

/**
 * 'thumbnail' previews (the images → PDF order list): small, oriented, never
 * upscaled, decoded without touching the editors' source cache.
 */
describe("renderToolPreview 'thumbnail'", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('thumb');
    clearPreviewCaches();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('is oriented (EXIF), fits maxEdge and reports the oriented full size', async () => {
    const path = await writeFixture(dir, 'o.jpg', insertJpegSegments(await quadrantJpeg(320, 160), [exifSegment({ orientation: 6 })]));
    const t = await preview('thumbnail', await inputFor(path), {}, 64);
    expect(t.mime).toBe('image/jpeg');
    expect([t.width, t.height]).toEqual([32, 64]);
    expect([t.sourceWidth, t.sourceHeight]).toEqual([160, 320]);
    const img = await readRgba(t.data);
    expect([img.width, img.height]).toEqual([32, 64]);
    // Orientation 6 turns the stored quadrants clockwise: TL blue, TR red, BL yellow, BR green.
    expect(near(px(img, 8, 16), BLUE, 40)).toBe(true);
    expect(near(px(img, 24, 16), RED, 40)).toBe(true);
    expect(near(px(img, 8, 48), YELLOW, 40)).toBe(true);
    expect(near(px(img, 24, 48), GREEN, 40)).toBe(true);
  });

  it('never upscales and keeps the aspect ratio of large images', async () => {
    const small = await writeFixture(dir, 's.png', await sharp(quadrantRaw(40, 30), { raw: { width: 40, height: 30, channels: 3 } }).png().toBuffer());
    const t = await preview('thumbnail', await inputFor(small), {}, 160);
    expect([t.width, t.height]).toEqual([40, 30]);
    const big = await writeFixture(dir, 'b.png', await sharp(noisyRaw(1600, 1200, 2, 20), { raw: { width: 1600, height: 1200, channels: 3 } }).png().toBuffer());
    const b = await preview('thumbnail', await inputFor(big), {}, 96);
    expect([b.width, b.height]).toEqual([96, 72]);
    expect([b.sourceWidth, b.sourceHeight]).toEqual([1600, 1200]);
  });

  it('is PNG when the image has transparent pixels, JPEG otherwise', async () => {
    const rgba = Buffer.alloc(60 * 40 * 4);
    for (let i = 0; i < 60 * 40; i += 1) rgba.set([0, 0, 255, i % 60 < 30 ? 255 : 0], i * 4);
    const transparent = await writeFixture(dir, 't.png', await sharp(rgba, { raw: { width: 60, height: 40, channels: 4 } }).png().toBuffer());
    const t = await preview('thumbnail', await inputFor(transparent), {}, 30);
    expect(t.mime).toBe('image/png');
    const img = await readRgba(t.data);
    expect(px(img, 25, 10)[3]).toBe(0);
    expect(px(img, 4, 10)).toEqual([0, 0, 255, 255]);
    const opaque = await writeFixture(dir, 'o.png', await sharp({ create: { width: 30, height: 30, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } } }).png().toBuffer());
    expect((await preview('thumbnail', await inputFor(opaque), {}, 20)).mime).toBe('image/jpeg');
  });

  it('does not fill the editors’ decoded-source cache (a long list cannot evict an open editor’s decodes)', async () => {
    const path = await writeFixture(dir, 'n.png', await sharp(noisyRaw(800, 600, 4, 20), { raw: { width: 800, height: 600, channels: 3 } }).png().toBuffer());
    const input = await inputFor(path);
    expect(cachedSourceCount()).toBe(0);
    for (const edge of [48, 96, 160]) await preview('thumbnail', input, {}, edge);
    expect(cachedSourceCount()).toBe(0);
    await preview('source', input, {}, 200);
    expect(cachedSourceCount()).toBe(1);
    // …and a thumbnail does not drop what is cached either.
    await preview('thumbnail', input, {}, 64);
    expect(cachedSourceCount()).toBe(1);
  });

  it('honours cancellation (before and while reading) with CANCELLED', async () => {
    const path = await writeFixture(dir, 'c.png', await sharp(noisyRaw(400, 300, 5, 20), { raw: { width: 400, height: 300, channels: 3 } }).png().toBuffer());
    const input = await inputFor(path);
    const before = new AbortController();
    before.abort();
    await expect(preview('thumbnail', input, {}, 96, { signal: before.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    const during = new AbortController();
    const pending = preview('thumbnail', input, {}, 96, { signal: during.signal });
    during.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('ignores options and reads BMP and 16-bit inputs through the same loader as the tools', async () => {
    const bmp = await writeFixture(dir, 'q.bmp', bmp24(quadrantRaw(64, 32), 64, 32));
    const tb = await preview('thumbnail', await inputFor(bmp), { anything: true }, 32);
    expect([tb.width, tb.height]).toEqual([32, 16]);
    const bimg = await readRgba(tb.data);
    expect(near(px(bimg, 4, 4), RED, 30)).toBe(true);
    expect(near(px(bimg, 28, 12), YELLOW, 30)).toBe(true);

    const red = Buffer.alloc(40 * 20 * 3);
    for (let i = 0; i < 40 * 20; i += 1) red.set(RED, i * 3);
    const png16 = await sharp(red, { raw: { width: 40, height: 20, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
    const deep = await writeFixture(dir, 'deep.png', png16);
    expect((await sharp(deep).metadata()).depth).toBe('ushort');
    const t16 = await preview('thumbnail', await inputFor(deep), {}, 20);
    expect([t16.width, t16.height]).toEqual([20, 10]);
    expect(near(px(await readRgba(t16.data), 10, 5), RED, 4)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('decodes HEIC through the ImageIO codec helper', async () => {
    const saved = process.env[IMAGEIO_HELPER_ENV];
    process.env[IMAGEIO_HELPER_ENV] = await writeFakeImageIOHelper(dir);
    try {
      const png = await sharp(quadrantRaw(120, 60), { raw: { width: 120, height: 60, channels: 3 } }).png().toBuffer();
      const path = await writeFixture(dir, 'photo.heic', fakeHeic(png));
      const t = await preview('thumbnail', await inputFor(path, 'heic'), {}, 60);
      expect([t.width, t.height]).toEqual([60, 30]);
      const img = await readRgba(t.data);
      expect(near(px(img, 10, 7), RED, 30)).toBe(true);
      expect(near(px(img, 50, 22), YELLOW, 30)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[IMAGEIO_HELPER_ENV];
      else process.env[IMAGEIO_HELPER_ENV] = saved;
    }
  });
});
