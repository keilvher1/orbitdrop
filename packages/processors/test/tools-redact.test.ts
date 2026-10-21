import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mosaicPixels } from '../src/tools/redact';
import {
  XMP_PACKET,
  exifSegment,
  inputFor,
  insertJpegSegments,
  iptcSegment,
  listDir,
  makeTempDir,
  meanAbsDiff,
  near,
  noisyRaw,
  preview,
  px,
  readRgba,
  removeDir,
  runToolJob,
  sha256,
  writeFixture,
  xmpSegment,
} from './helpers/tools-fixtures';

describe('tool.redact', () => {
  let dir: string;
  let noisyPng: string;
  beforeEach(async () => {
    dir = await makeTempDir('redact');
    noisyPng = await writeFixture(dir, 'doc.png', await sharp(noisyRaw(200, 120, 11, 120), { raw: { width: 200, height: 120, channels: 3 } }).png().toBuffer());
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('paints solid boxes with the exact colour and leaves the rest untouched', async () => {
    const before = await sha256(noisyPng);
    const result = await runToolJob('tool.redact', await inputFor(noisyPng), {
      regions: [{ id: 'r1', rect: { x: 20, y: 10, width: 50, height: 30 }, style: 'solid', color: '#112233' }],
    });
    const out = result.outputs[0]!;
    expect(out.path.endsWith('doc Redacted.png')).toBe(true);
    const img = await readRgba(out.path);
    const original = await readRgba(noisyPng);
    for (let y = 10; y < 40; y += 1) for (let x = 20; x < 70; x += 1) expect(px(img, x, y)).toEqual([0x11, 0x22, 0x33, 255]);
    expect(px(img, 19, 20)).toEqual(px(original, 19, 20));
    expect(px(img, 70, 20)).toEqual(px(original, 70, 20));
    expect(px(img, 30, 40)).toEqual(px(original, 30, 40));
    expect(await sha256(noisyPng)).toBe(before);
    expect(await listDir(dir)).toEqual(['doc Redacted.png', 'doc.png']);
  });

  it('pixelates mosaic regions into uniform blocks aligned to the region', async () => {
    const result = await runToolJob('tool.redact', await inputFor(noisyPng), {
      regions: [{ id: 'm', rect: { x: 10, y: 10, width: 70, height: 45 }, style: 'mosaic', blockSize: 16 }],
    });
    const img = await readRgba(result.outputs[0]!.path);
    const original = await readRgba(noisyPng);
    // every block (16×16, partial at the right/bottom: 6 px and 13 px) is one colour, equal to the block mean
    for (let by = 10; by < 55; by += 16) {
      for (let bx = 10; bx < 80; bx += 16) {
        const bw = Math.min(16, 80 - bx);
        const bh = Math.min(16, 55 - by);
        const first = px(img, bx, by);
        const mean: [number, number, number] = [0, 0, 0];
        for (let y = by; y < by + bh; y += 1) {
          for (let x = bx; x < bx + bw; x += 1) {
            expect(px(img, x, y)).toEqual(first);
            const o = px(original, x, y);
            mean[0] += o[0] / (bw * bh);
            mean[1] += o[1] / (bw * bh);
            mean[2] += o[2] / (bw * bh);
          }
        }
        expect(near(first, mean, 0.51)).toBe(true);
      }
    }
    // neighbouring blocks differ (noise), outside the region nothing changed
    expect(px(img, 10, 10)).not.toEqual(px(img, 26, 10));
    expect(px(img, 85, 30)).toEqual(px(original, 85, 30));
  });

  it('never carries EXIF, GPS, the thumbnail, XMP or IPTC; JPEG stays JPEG', async () => {
    const thumb = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#FF00FF' } }).jpeg().toBuffer();
    const base = await sharp(noisyRaw(200, 120, 3, 30), { raw: { width: 200, height: 120, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
    const data = insertJpegSegments(base, [exifSegment({ make: 'SpyCam', gps: { lat: 10, lon: 20 }, thumbnail: thumb }), xmpSegment(), iptcSegment('who')]);
    const path = await writeFixture(dir, 'secret.jpg', data);
    const result = await runToolJob('tool.redact', await inputFor(path), {
      regions: [{ id: 'r', rect: { x: 0, y: 0, width: 64, height: 64 }, style: 'solid', color: '#000000' }],
    });
    const out = await readFile(result.outputs[0]!.path);
    expect(result.outputs[0]!.path.endsWith('secret Redacted.jpg')).toBe(true);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(out.includes(Buffer.from('SpyCam'))).toBe(false);
    expect(out.includes(Buffer.from(XMP_PACKET.slice(0, 20)))).toBe(false);
    expect(out.indexOf(Buffer.from([0xff, 0xd8]), 2)).toBe(-1); // no embedded thumbnail JPEG
    const img = await readRgba(out);
    expect(near(px(img, 30, 30), [0, 0, 0], 3)).toBe(true);
  });

  it('clips regions partly outside the image and rejects regions fully outside', async () => {
    const input = await inputFor(noisyPng);
    const clipped = await runToolJob('tool.redact', input, { regions: [{ id: 'c', rect: { x: 180, y: 100, width: 100, height: 100 }, style: 'solid', color: '#FFFFFF' }] });
    const img = await readRgba(clipped.outputs[0]!.path);
    expect([img.width, img.height]).toEqual([200, 120]);
    expect(px(img, 199, 119)).toEqual([255, 255, 255, 255]);
    await expect(
      runToolJob('tool.redact', input, { regions: [{ id: 'o', rect: { x: 500, y: 0, width: 10, height: 10 }, style: 'solid', color: '#FFFFFF' }] }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(runToolJob('tool.redact', input, { regions: [] })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });

  it('on transparent images the patch replaces the pixels (nothing shows through)', async () => {
    // Semi-transparent noise: a naive "over" composite of a semi-transparent mosaic would blend with the original.
    const raw = noisyRaw(64, 64, 5, 200);
    const rgba = Buffer.alloc(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i += 1) rgba.set([raw[i * 3]!, raw[i * 3 + 1]!, raw[i * 3 + 2]!, 128], i * 4);
    const path = await writeFixture(dir, 'alpha.png', await sharp(rgba, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer());
    const result = await runToolJob('tool.redact', await inputFor(path), { regions: [{ id: 'm', rect: { x: 0, y: 0, width: 32, height: 32 }, style: 'mosaic', blockSize: 32 }] });
    const img = await readRgba(result.outputs[0]!.path);
    const first = px(img, 0, 0);
    expect(first[3]).toBe(128);
    for (let y = 0; y < 32; y += 4) for (let x = 0; x < 32; x += 4) expect(px(img, x, y)).toEqual(first);
  });

  it('works on greyscale JPEGs and P3-tagged photos (profile kept, patches burned in)', async () => {
    const grey = await sharp(noisyRaw(96, 64, 2, 120), { raw: { width: 96, height: 64, channels: 3 } }).toColourspace('b-w').jpeg({ quality: 95 }).toBuffer();
    const gpath = await writeFixture(dir, 'g.jpg', grey);
    const gres = await runToolJob('tool.redact', await inputFor(gpath), {
      regions: [
        { id: 'm', rect: { x: 0, y: 0, width: 48, height: 64 }, style: 'mosaic', blockSize: 16 },
        { id: 's', rect: { x: 60, y: 10, width: 20, height: 20 }, style: 'solid', color: '#FFFFFF' },
      ],
    });
    const gimg = await readRgba(gres.outputs[0]!.path);
    expect(near(px(gimg, 70, 20), [255, 255, 255], 4)).toBe(true);
    expect(near(px(gimg, 3, 3), px(gimg, 12, 12), 6)).toBe(true); // inside one 16 px block (JPEG noise only)

    const p3 = await sharp(noisyRaw(96, 64, 6, 60), { raw: { width: 96, height: 64, channels: 3 } }).withIccProfile('p3').jpeg({ quality: 95 }).toBuffer();
    const ppath = await writeFixture(dir, 'p3.jpg', p3);
    const pres = await runToolJob('tool.redact', await inputFor(ppath), { regions: [{ id: 's', rect: { x: 0, y: 0, width: 32, height: 32 }, style: 'solid', color: '#000000' }] });
    const pm = await sharp(pres.outputs[0]!.path).metadata();
    expect(pm.icc).toBeDefined(); // colour profile kept, metadata not
    expect(pm.exif).toBeUndefined();
    expect(near(px(await readRgba(pres.outputs[0]!.path), 10, 10), [0, 0, 0], 4)).toBe(true);
  });

  it('mosaicPixels averages with alpha weighting', () => {
    const src = { data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 0]), width: 2, height: 1, channels: 4 };
    const out = mosaicPixels(src, 0, 0, { x: 0, y: 0, width: 2, height: 1 }, 2);
    // the fully transparent blue pixel does not tint the result
    expect([...out]).toEqual([255, 0, 0, 128, 255, 0, 0, 128]);
  });

  it('preview matches the final redaction', async () => {
    const big = await writeFixture(dir, 'big.png', await sharp(noisyRaw(800, 480, 8, 60), { raw: { width: 800, height: 480, channels: 3 } }).png().toBuffer());
    const input = await inputFor(big);
    const options = {
      regions: [
        { id: 'a', rect: { x: 40, y: 40, width: 320, height: 160 }, style: 'mosaic', blockSize: 32 },
        { id: 'b', rect: { x: 400, y: 240, width: 300, height: 200 }, style: 'solid', color: '#FF8800' },
      ],
    };
    const p = await preview('tool.redact', input, options, 400);
    expect([p.width, p.height]).toEqual([400, 240]);
    const prev = await readRgba(p.data);
    expect(near(px(prev, 300, 170), [255, 136, 0], 3)).toBe(true);
    const final = await runToolJob('tool.redact', input, options);
    const finalSmall = await readRgba(await sharp(final.outputs[0]!.path).resize(400, 240, { fit: 'fill' }).png().toBuffer());
    // mosaic blocks of 32 px become 16 px blocks in the preview; colours agree closely
    expect(meanAbsDiff(finalSmall, prev)).toBeLessThan(4);
  });
});
