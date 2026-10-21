import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_LIMITS, OrbitError } from '@orbitdrop/contracts';
import { inspectImage } from '../src/tools';
import {
  BLUE,
  GREEN,
  RED,
  YELLOW,
  bmp24,
  quadrantRaw,
  readBmp,
  exifSegment,
  inputFor,
  insertJpegSegments,
  listDir,
  makeTempDir,
  near,
  preview,
  px,
  quadrantJpeg,
  readRgba,
  removeDir,
  runToolJob,
  sha256,
  writeFixture,
} from './helpers/tools-fixtures';

describe('tool.crop', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('crop');
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('crops in oriented coordinates on an orientation-6 JPEG and lands on the right pixels', async () => {
    // Stored 320×160 with quadrants TL red / TR green / BL blue / BR yellow; orientation 6 rotates
    // it 90° clockwise for display: oriented 160×320 with TL blue, TR red, BL yellow, BR green.
    const stored = await quadrantJpeg(320, 160);
    const path = await writeFixture(dir, 'photo.jpg', insertJpegSegments(stored, [exifSegment({ orientation: 6, make: 'Cam' })]));
    expect((await sharp(path).metadata()).orientation).toBe(6);
    const before = await sha256(path);

    // 32×32 rect centred on the oriented quadrant corner (80, 160).
    const result = await runToolJob('tool.crop', await inputFor(path), { rect: { x: 64, y: 144, width: 32, height: 32 }, aspect: '1:1' });
    expect(result.warnings).toEqual([]);
    expect(result.outputs).toHaveLength(1);
    const out = result.outputs[0]!;
    expect(out.path.endsWith('photo Cropped.jpg')).toBe(true);
    expect(out.format).toBe('jpeg');
    expect([out.width, out.height]).toEqual([32, 32]);

    const meta = await sharp(out.path).metadata();
    expect([meta.width, meta.height]).toEqual([32, 32]);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
    const img = await readRgba(out.path);
    expect(near(px(img, 4, 4), BLUE, 40)).toBe(true);
    expect(near(px(img, 27, 4), RED, 40)).toBe(true);
    expect(near(px(img, 4, 27), YELLOW, 40)).toBe(true);
    expect(near(px(img, 27, 27), GREEN, 40)).toBe(true);

    expect(await sha256(path)).toBe(before);
    expect(await listDir(dir)).toEqual(['photo Cropped.jpg', 'photo.jpg']);
  });

  it('output size equals the rect and the full image can be selected', async () => {
    const path = await writeFixture(dir, 'wide.png', await sharp({ create: { width: 301, height: 199, channels: 3, background: '#336699' } }).png().toBuffer());
    const input = await inputFor(path);
    const full = await runToolJob('tool.crop', input, { rect: { x: 0, y: 0, width: 301, height: 199 } });
    expect([full.outputs[0]!.width, full.outputs[0]!.height]).toEqual([301, 199]);
    const odd = await runToolJob('tool.crop', input, { rect: { x: 17, y: 3, width: 1, height: 196 } });
    const meta = await sharp(odd.outputs[0]!.path).metadata();
    expect([meta.width, meta.height]).toEqual([1, 196]);
    expect(meta.format).toBe('png');
    expect(odd.outputs[0]!.path.endsWith('wide Cropped (2).png')).toBe(true);
  });

  it('rejects rects outside the oriented bounds and invalid values with INVALID_OPTIONS', async () => {
    const stored = await quadrantJpeg(320, 160);
    const path = await writeFixture(dir, 'o6.jpg', insertJpegSegments(stored, [exifSegment({ orientation: 6 })]));
    const input = await inputFor(path);
    // 300 wide fits the stored width but not the oriented width (160).
    for (const rect of [
      { x: 0, y: 0, width: 300, height: 100 },
      { x: 150, y: 0, width: 11, height: 10 },
      { x: 0, y: 311, width: 10, height: 10 },
    ]) {
      await expect(runToolJob('tool.crop', input, { rect })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    }
    await expect(runToolJob('tool.crop', input, { rect: { x: -1, y: 0, width: 10, height: 10 } })).rejects.toBeInstanceOf(OrbitError);
    await expect(runToolJob('tool.crop', input, { rect: { x: 0, y: 0, width: 0, height: 10 } })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(runToolJob('tool.crop', input, { rect: { x: 0, y: 0, width: 10.5, height: 10 } })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(await listDir(dir)).toEqual(['o6.jpg']);
  });

  it('keeps alpha for PNG and flattens onto flattenBackground for JPEG with a warning', async () => {
    // Left half transparent, right half opaque red.
    const raw = Buffer.alloc(100 * 50 * 4);
    for (let y = 0; y < 50; y += 1) for (let x = 50; x < 100; x += 1) raw.set([255, 0, 0, 255], (y * 100 + x) * 4);
    const path = await writeFixture(dir, 'alpha.png', await sharp(raw, { raw: { width: 100, height: 50, channels: 4 } }).png().toBuffer());
    const input = await inputFor(path);

    const png = await runToolJob('tool.crop', input, { rect: { x: 30, y: 10, width: 40, height: 20 } });
    expect(png.warnings).toEqual([]);
    const pngMeta = await sharp(png.outputs[0]!.path).metadata();
    expect(pngMeta.format).toBe('png');
    expect(pngMeta.hasAlpha).toBe(true);
    const pimg = await readRgba(png.outputs[0]!.path);
    expect(px(pimg, 5, 10)[3]).toBe(0);
    expect(px(pimg, 35, 10)).toEqual([255, 0, 0, 255]);

    const jpg = await runToolJob('tool.crop', input, { rect: { x: 30, y: 10, width: 40, height: 20 }, outputFormat: 'jpeg', flattenBackground: '#00FF00' });
    expect(jpg.warnings).toEqual([{ code: 'ALPHA_FLATTENED', params: { background: '#00FF00' } }]);
    expect(jpg.outputs[0]!.path.endsWith('alpha Cropped.jpg')).toBe(true);
    const jmeta = await sharp(jpg.outputs[0]!.path).metadata();
    expect(jmeta.format).toBe('jpeg');
    expect(jmeta.channels).toBe(3);
    const jimg = await readRgba(jpg.outputs[0]!.path);
    expect(near(px(jimg, 5, 10), GREEN, 12)).toBe(true);
    expect(near(px(jimg, 35, 10), RED, 12)).toBe(true);

    // A fully opaque region of an RGBA PNG flattened to JPEG is not reported.
    const opaque = await runToolJob('tool.crop', input, { rect: { x: 60, y: 0, width: 40, height: 50 }, outputFormat: 'jpeg' });
    expect(opaque.warnings).toEqual([]);
  });

  it('keeps WebP/TIFF/AVIF, turns GIF into PNG and honours explicit formats', async () => {
    const base = sharp({ create: { width: 64, height: 48, channels: 3, background: '#808000' } });
    const cases: [string, Buffer, string][] = [
      ['a.webp', await base.clone().webp().toBuffer(), 'webp'],
      ['b.tiff', await base.clone().tiff().toBuffer(), 'tiff'],
      ['c.avif', await base.clone().avif().toBuffer(), 'heif'],
      ['d.gif', await base.clone().gif().toBuffer(), 'png'],
    ];
    for (const [name, data, expected] of cases) {
      const path = await writeFixture(dir, name, data);
      const result = await runToolJob('tool.crop', await inputFor(path), { rect: { x: 8, y: 8, width: 16, height: 16 } });
      const meta = await sharp(result.outputs[0]!.path).metadata();
      expect(meta.format, name).toBe(expected);
      expect([meta.width, meta.height]).toEqual([16, 16]);
    }
    const path = await writeFixture(dir, 'e.png', await base.clone().png().toBuffer());
    const webp = await runToolJob('tool.crop', await inputFor(path), { rect: { x: 0, y: 0, width: 10, height: 10 }, outputFormat: 'webp', quality: 80 });
    expect(webp.outputs[0]!.path.endsWith('e Cropped.webp')).toBe(true);
    expect((await sharp(webp.outputs[0]!.path).metadata()).format).toBe('webp');
  });

  it('crops BMP input through the builtin codec and keeps BMP', async () => {
    const path = await writeFixture(dir, 'scan.bmp', bmp24(quadrantRaw(64, 32), 64, 32));
    const before = await sha256(path);
    const result = await runToolJob('tool.crop', await inputFor(path), { rect: { x: 16, y: 8, width: 32, height: 16 } });
    const out = result.outputs[0]!;
    expect(out.format).toBe('bmp');
    expect(out.path.endsWith('scan Cropped.bmp')).toBe(true);
    const img = readBmp(await readFile(out.path));
    expect([img.width, img.height]).toEqual([32, 16]);
    expect(px(img, 4, 4).slice(0, 3)).toEqual([...RED]);
    expect(px(img, 28, 4).slice(0, 3)).toEqual([...GREEN]);
    expect(px(img, 4, 12).slice(0, 3)).toEqual([...BLUE]);
    expect(px(img, 28, 12).slice(0, 3)).toEqual([...YELLOW]);
    expect(await sha256(path)).toBe(before);
    const info = await inspectImage(await inputFor(path), DEFAULT_PROCESSING_LIMITS);
    expect([info.width, info.height, info.orientedWidth, info.orientedHeight]).toEqual([64, 32, 64, 32]);
    expect(info.format).toBe('bmp');
  });

  it('keeps the input extension spelling when the format is unchanged', async () => {
    const path = await writeFixture(dir, 'IMG_0001.JPEG', await quadrantJpeg(64, 64));
    const result = await runToolJob('tool.crop', await inputFor(path), { rect: { x: 0, y: 0, width: 32, height: 32 } });
    expect(result.outputs[0]!.path.endsWith('IMG_0001 Cropped.JPEG')).toBe(true);
  });

  it('preview shows the cropped region of the oriented image', async () => {
    const stored = await quadrantJpeg(320, 160);
    const path = await writeFixture(dir, 'p.jpg', insertJpegSegments(stored, [exifSegment({ orientation: 6 })]));
    const result = await preview('tool.crop', await inputFor(path), { rect: { x: 80, y: 0, width: 80, height: 160 } }, 40);
    expect([result.sourceWidth, result.sourceHeight]).toEqual([160, 320]);
    expect([result.outputWidth, result.outputHeight]).toEqual([80, 160]);
    expect([result.width, result.height]).toEqual([20, 40]);
    const img = await readRgba(result.data);
    expect(near(px(img, 10, 20), RED, 40)).toBe(true);
  });
});
