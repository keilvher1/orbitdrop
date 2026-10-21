import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditOptions } from '@orbitdrop/contracts';
import { saturationMatrix } from '../src/tools/edit';
import {
  BLUE,
  GREEN,
  RED,
  YELLOW,
  exifSegment,
  inputFor,
  insertJpegSegments,
  listDir,
  luminance,
  makeTempDir,
  meanAbsDiff,
  near,
  noisyRaw,
  preview,
  px,
  quadrantJpeg,
  quadrantRaw,
  readRgba,
  removeDir,
  runToolJob,
  sha256,
  writeFixture,
  type Rgba,
} from './helpers/tools-fixtures';

type Corner = readonly [number, number, number];

/** Colours at the four quadrant centres: [TL, TR, BL, BR]. */
function quadrants(img: Rgba): [number, number, number, number][] {
  const w = img.width;
  const h = img.height;
  return [px(img, w / 4, h / 4), px(img, (3 * w) / 4, h / 4), px(img, w / 4, (3 * h) / 4), px(img, (3 * w) / 4, (3 * h) / 4)];
}

function expectQuadrants(img: Rgba, expected: readonly Corner[], tolerance = 0): void {
  quadrants(img).forEach((actual, i) => expect(near(actual, expected[i]!, tolerance), `quadrant ${i}: ${actual.join(',')}`).toBe(true));
}

describe('tool.edit', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await makeTempDir('edit');
    // PNG 80×40: TL red, TR green, BL blue, BR yellow (lossless, so colours are exact)
    path = await writeFixture(dir, 'q.png', await sharp(quadrantRaw(80, 40), { raw: { width: 80, height: 40, channels: 3 } }).png().toBuffer());
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  const edit = async (options: Partial<EditOptions>): Promise<Rgba> => {
    const result = await runToolJob('tool.edit', await inputFor(path), options);
    return readRgba(result.outputs[0]!.path);
  };

  it('rotates clockwise and swaps the dimensions for 90/270', async () => {
    const r90 = await edit({ rotate: 90 });
    expect([r90.width, r90.height]).toEqual([40, 80]);
    expectQuadrants(r90, [BLUE, RED, YELLOW, GREEN]);
    const r180 = await edit({ rotate: 180 });
    expect([r180.width, r180.height]).toEqual([80, 40]);
    expectQuadrants(r180, [YELLOW, BLUE, GREEN, RED]);
    const r270 = await edit({ rotate: 270 });
    expect([r270.width, r270.height]).toEqual([40, 80]);
    expectQuadrants(r270, [GREEN, YELLOW, RED, BLUE]);
  });

  it('flips mirror what is shown (after the rotation)', async () => {
    expectQuadrants(await edit({ flipH: true }), [GREEN, RED, YELLOW, BLUE]);
    expectQuadrants(await edit({ flipV: true }), [BLUE, YELLOW, RED, GREEN]);
    expectQuadrants(await edit({ flipH: true, flipV: true }), [YELLOW, BLUE, GREEN, RED]);
    // rotate 90 shows [BLUE, RED, YELLOW, GREEN]; a horizontal mirror of that view:
    const rh = await edit({ rotate: 90, flipH: true });
    expect([rh.width, rh.height]).toEqual([40, 80]);
    expectQuadrants(rh, [RED, BLUE, GREEN, YELLOW]);
    // …and a vertical mirror of it:
    expectQuadrants(await edit({ rotate: 90, flipV: true }), [YELLOW, GREEN, BLUE, RED]);
    expectQuadrants(await edit({ rotate: 270, flipH: true }), [YELLOW, GREEN, BLUE, RED]);
    expectQuadrants(await edit({ rotate: 180, flipH: true }), [BLUE, YELLOW, RED, GREEN]);
  });

  it('applies on top of the EXIF orientation', async () => {
    // Stored quadrants with orientation 6 display as [BLUE, RED, YELLOW, GREEN] (160×320).
    const jpg = await writeFixture(dir, 'o.jpg', insertJpegSegments(await quadrantJpeg(320, 160), [exifSegment({ orientation: 6 })]));
    const result = await runToolJob('tool.edit', await inputFor(jpg), { rotate: 90, flipH: true });
    const img = await readRgba(result.outputs[0]!.path);
    // displayed view rotated 90° → 320×160 [YELLOW, BLUE, GREEN, RED], then mirrored left-right
    expect([img.width, img.height]).toEqual([320, 160]);
    expectQuadrants(img, [BLUE, YELLOW, RED, GREEN], 40);
    expect((await sharp(result.outputs[0]!.path).metadata()).orientation).toBeUndefined();
    expect(result.outputs[0]!.path.endsWith('o Edited.jpg')).toBe(true);
  });

  it('identity edit keeps every pixel; brightness/contrast/saturation move in the right direction', async () => {
    const noisy = await writeFixture(dir, 'n.png', await sharp(noisyRaw(64, 48, 9, 40), { raw: { width: 64, height: 48, channels: 3 } }).png().toBuffer());
    const original = await readRgba(noisy);
    const run = async (options: Partial<EditOptions>): Promise<Rgba> => readRgba((await runToolJob('tool.edit', await inputFor(noisy), options)).outputs[0]!.path);
    expect(meanAbsDiff(await run({}), original)).toBe(0);

    const meanLum = (img: Rgba): number => {
      let s = 0;
      for (let i = 0; i < img.data.length; i += 4) s += luminance([img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]);
      return s / (img.data.length / 4);
    };
    const stdLum = (img: Rgba): number => {
      const m = meanLum(img);
      let s = 0;
      for (let i = 0; i < img.data.length; i += 4) s += (luminance([img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]) - m) ** 2;
      return Math.sqrt(s / (img.data.length / 4));
    };
    const brighter = await run({ brightness: 40 });
    const darker = await run({ brightness: -40 });
    expect(meanLum(brighter)).toBeGreaterThan(meanLum(original) + 20);
    expect(meanLum(darker)).toBeLessThan(meanLum(original) - 20);
    // brightness −100 → black (CSS brightness(0))
    expect(meanLum(await run({ brightness: -100 }))).toBeLessThan(1);
    // brightness is multiplicative: a pixel value v becomes ≈ v·1.4
    const p0 = px(original, 10, 10);
    const p1 = px(brighter, 10, 10);
    expect(near(p1, p0.map((v) => Math.min(255, v * 1.4)), 1.5)).toBe(true);

    expect(stdLum(await run({ contrast: 50 }))).toBeGreaterThan(stdLum(original) * 1.3);
    expect(stdLum(await run({ contrast: -50 }))).toBeLessThan(stdLum(original) * 0.7);
    const flat = await run({ contrast: -100 });
    expect(near(px(flat, 5, 5), [128, 128, 128], 1)).toBe(true);

    const grey = await run({ saturation: -100 });
    for (const [x, y] of [
      [3, 3],
      [30, 20],
      [60, 40],
    ] as const) {
      const p = px(grey, x, y);
      expect(Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2])).toBeLessThanOrEqual(1);
    }
    const vivid = await run({ saturation: 80 });
    const spread = (img: Rgba): number => {
      let s = 0;
      for (let i = 0; i < img.data.length; i += 4) s += Math.max(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!) - Math.min(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
      return s / (img.data.length / 4);
    };
    expect(spread(vivid)).toBeGreaterThan(spread(original) * 1.3);
  });

  it('uses the CSS saturate() matrix (rows sum to 1)', () => {
    for (const s of [0, 0.5, 1, 2]) {
      for (const row of saturationMatrix(s)) expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    }
    expect(saturationMatrix(1)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ].map((row) => row.map((v) => expect.closeTo(v, 10))));
  });

  it('keeps alpha, honours outputFormat and leaves the original untouched', async () => {
    const rgba = Buffer.alloc(40 * 20 * 4);
    for (let i = 0; i < 40 * 20; i += 1) rgba.set([200, 100, 50, i % 40 < 20 ? 255 : 0], i * 4);
    const a = await writeFixture(dir, 'a.png', await sharp(rgba, { raw: { width: 40, height: 20, channels: 4 } }).png().toBuffer());
    const before = await sha256(a);
    const result = await runToolJob('tool.edit', await inputFor(a), { brightness: 20, rotate: 180 });
    const img = await readRgba(result.outputs[0]!.path);
    expect(px(img, 5, 10)[3]).toBe(0); // the transparent half moved to the left
    expect(px(img, 35, 10)[3]).toBe(255);
    const webp = await runToolJob('tool.edit', await inputFor(a), { outputFormat: 'webp' });
    expect(webp.outputs[0]!.path.endsWith('a Edited.webp')).toBe(true);
    expect(await sha256(a)).toBe(before);
    expect((await listDir(dir)).filter((n) => n.includes('.orbitdrop-'))).toEqual([]);
  });

  it('preview renders the same edit as the final export', async () => {
    const noisy = await writeFixture(dir, 'pv.png', await sharp(noisyRaw(400, 300, 4, 10), { raw: { width: 400, height: 300, channels: 3 } }).png().toBuffer());
    const input = await inputFor(noisy);
    const options = { rotate: 90 as const, flipH: true, brightness: 25, contrast: -20, saturation: 35 };
    const p = await preview('tool.edit', input, options, 150);
    expect([p.outputWidth, p.outputHeight]).toEqual([300, 400]);
    expect([p.width, p.height]).toEqual([113, 150]);
    const final = await runToolJob('tool.edit', input, options);
    const finalSmall = await readRgba(await sharp(final.outputs[0]!.path).resize(p.width, p.height, { fit: 'fill' }).png().toBuffer());
    expect(meanAbsDiff(finalSmall, await readRgba(p.data))).toBeLessThan(3);
  });
});
