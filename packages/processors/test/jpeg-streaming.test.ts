import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STREAMING_JPEG_PIXELS, jpegOptions } from '../src/common/io';
import { inputOf, run } from './helpers/hardening';

/**
 * Huge JPEG outputs are written in one streaming pass (baseline, standard Huffman tables)
 * instead of mozjpeg, whose progressive/trellis mode keeps every DCT coefficient in memory.
 * The decision uses the pixels actually written (a small crop of a huge photo stays mozjpeg).
 */

/** The first SOFn marker: 0xC0 baseline, 0xC2 progressive. */
function sofMarker(jpeg: Buffer): number {
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff) {
    const marker = jpeg[pos + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return marker;
    pos += 2 + jpeg.readUInt16BE(pos + 2);
  }
  return -1;
}

/** Code-length counts of the luminance DC table (class 0, id 0) in the first DHT segment. */
function lumaDcBits(jpeg: Buffer): number[] {
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff) {
    const marker = jpeg[pos + 1]!;
    const length = jpeg.readUInt16BE(pos + 2);
    if (marker === 0xc4) {
      let t = pos + 4;
      while (t < pos + 2 + length) {
        const bits = [...jpeg.subarray(t + 1, t + 17)];
        if (jpeg[t] === 0x00) return bits;
        t += 17 + bits.reduce((a, b) => a + b, 0);
      }
    }
    pos += 2 + length;
  }
  return [];
}

/** ITU T.81 Annex K.3 table K.3 (what libjpeg writes without optimised coding). */
const STANDARD_LUMA_DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];

let dir: string;
let huge: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-jpeg-stream-'));
  huge = join(dir, 'huge.png');
  // 8000 × 7600 = 60.8 Mpx, just above the threshold; flat halves keep the PNG small.
  const half = await sharp({ create: { width: 4000, height: 7600, channels: 3, background: '#2a6df4' } }).png().toBuffer();
  await sharp({ create: { width: 8000, height: 7600, channels: 3, background: '#f2a24a' } })
    .composite([{ input: half, left: 0, top: 0 }])
    .png({ compressionLevel: 1 })
    .toFile(huge);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('jpegOptions', () => {
  it('uses mozjpeg up to the threshold and a streaming baseline above it', () => {
    expect(jpegOptions(90, STREAMING_JPEG_PIXELS)).toEqual({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true });
    expect(jpegOptions(80, STREAMING_JPEG_PIXELS + 1)).toEqual({
      quality: 80,
      chromaSubsampling: '4:2:0',
      mozjpeg: false,
      progressive: false,
      optimiseCoding: false,
      trellisQuantisation: false,
      overshootDeringing: false,
      optimiseScans: false,
    });
    expect(jpegOptions(70, 10, '4:4:4').chromaSubsampling).toBe('4:4:4');
  });
});

describe('huge JPEG outputs stream', () => {
  it('converts a 60.8 Mpx image to a baseline JPEG with the standard tables, same size and pixels', async () => {
    const result = await run('convert.jpeg', [await inputOf(huge, 'png')], {}, { outputDir: dir });
    const out = await readFile(result.outputs[0]!.path);
    expect(sofMarker(out)).toBe(0xc0);
    expect(lumaDcBits(out)).toEqual(STANDARD_LUMA_DC_BITS);
    const decoded = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect([decoded.info.width, decoded.info.height]).toEqual([8000, 7600]);
    const at = (x: number, y: number) => [...decoded.data.subarray((y * 8000 + x) * 3, (y * 8000 + x) * 3 + 3)];
    // Left half blue, right half orange (JPEG tolerance).
    for (const [x, y, rgb] of [[100, 100, [0x2a, 0x6d, 0xf4]], [7900, 7500, [0xf2, 0xa2, 0x4a]]] as const) {
      at(x, y).forEach((v, i) => expect(Math.abs(v - rgb[i]!)).toBeLessThanOrEqual(3));
    }
  });

  it('keeps mozjpeg for a small crop of the huge image (decided by the written size)', async () => {
    const result = await run('tool.crop', [await inputOf(huge, 'png')], { rect: { x: 3900, y: 100, width: 400, height: 300 }, outputFormat: 'jpeg' }, { outputDir: dir });
    const out = await readFile(result.outputs[0]!.path);
    expect(sofMarker(out)).toBe(0xc2);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([400, 300]);
  });

  it('streams a full-size Compress of the huge image, but not a resized one', async () => {
    const full = await run('tool.compress', [await inputOf(huge, 'png')], { format: 'jpeg', quality: 80 }, { outputDir: dir });
    expect(sofMarker(await readFile(full.outputs[0]!.path))).toBe(0xc0);
    const small = await run('tool.compress', [await inputOf(huge, 'png')], { format: 'jpeg', quality: 80, maxEdge: 2000 }, { outputDir: dir });
    const out = await readFile(small.outputs[0]!.path);
    expect(sofMarker(out)).toBe(0xc2);
    expect((await sharp(out).metadata()).width).toBe(2000);
  });
});
