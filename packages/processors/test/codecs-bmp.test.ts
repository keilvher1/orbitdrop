import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { OrbitError } from '@orbitdrop/contracts';
import { decodeBmp, encodeBmp, readBmpHeader } from '../src/codecs/bmp';
import { staticFixture } from './helpers/convert-fixtures';

/**
 * BMP codec. Decoder inputs are (a) files written by an independent encoder
 * (macOS ImageIO via `sips`, committed under tests/fixtures/static) and (b)
 * hand-assembled files for each header/compression variant, built byte by byte
 * from the BMP specification below. Encoder output is checked with our decoder
 * and with macOS ImageIO.
 */

interface Spec {
  width: number;
  height: number;
  bpp: number;
  compression?: number;
  headerSize?: 12 | 40 | 52 | 56 | 108 | 124;
  palette?: [number, number, number][];
  masks?: number[];
  clrUsed?: number;
  data: number[] | Buffer;
}

function buildBmp(spec: Spec): Buffer {
  const headerSize = spec.headerSize ?? 40;
  const entry = headerSize === 12 ? 3 : 4;
  const maskBytes = headerSize === 40 && spec.masks ? spec.masks.length * 4 : 0;
  const paletteBytes = (spec.palette?.length ?? 0) * entry;
  const data = Buffer.from(spec.data);
  const dataOffset = 14 + headerSize + maskBytes + paletteBytes;
  const buf = Buffer.alloc(dataOffset + data.length);
  buf.write('BM', 0, 'latin1');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(dataOffset, 10);
  buf.writeUInt32LE(headerSize, 14);
  if (headerSize === 12) {
    buf.writeUInt16LE(spec.width, 18);
    buf.writeInt16LE(spec.height, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt16LE(spec.bpp, 24);
  } else {
    buf.writeInt32LE(spec.width, 18);
    buf.writeInt32LE(spec.height, 22);
    buf.writeUInt16LE(1, 26);
    buf.writeUInt16LE(spec.bpp, 28);
    buf.writeUInt32LE(spec.compression ?? 0, 30);
    buf.writeUInt32LE(data.length, 34);
    buf.writeInt32LE(2835, 38);
    buf.writeInt32LE(2835, 42);
    buf.writeUInt32LE(spec.clrUsed ?? 0, 46);
    spec.masks?.forEach((m, i) => buf.writeUInt32LE(m >>> 0, 54 + i * 4));
  }
  spec.palette?.forEach(([r, g, b], i) => {
    const o = 14 + headerSize + maskBytes + i * entry;
    buf[o] = b;
    buf[o + 1] = g;
    buf[o + 2] = r;
  });
  data.copy(buf, dataOffset);
  return buf;
}

/** Decoded pixels as [r,g,b,a] tuples, top row first. */
function px(buffer: Buffer, maxPixels = 1e6): number[][] {
  const { data } = decodeBmp(buffer, maxPixels);
  const out: number[][] = [];
  for (let i = 0; i < data.length; i += 4) out.push([data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!]);
  return out;
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof OrbitError ? error.code : 'not-an-OrbitError';
  }
}

const K = [0, 0, 0, 255];
const W = [255, 255, 255, 255];
const R = [255, 0, 0, 255];
const G = [0, 255, 0, 255];
const B = [0, 0, 255, 255];
const T = [0, 0, 0, 0];

describe('BMP decoder', () => {
  it('reads 1-bit palettes, bottom-up, with row padding', () => {
    // 10×2: bottom row stored first. Row bits MSB first.
    const file = buildBmp({
      width: 10,
      height: 2,
      bpp: 1,
      palette: [
        [0, 0, 0],
        [255, 255, 255],
      ],
      data: [0b10101010, 0b11000000, 0, 0, /* top row: */ 0b11110000, 0b00000000, 0, 0],
    });
    expect(px(file)).toEqual([W, W, W, W, K, K, K, K, K, K, W, K, W, K, W, K, W, K, W, W]);
  });

  it('reads 4-bit palettes with odd widths', () => {
    const file = buildBmp({
      width: 3,
      height: 1,
      bpp: 4,
      palette: [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ],
      data: [0x01, 0x20, 0, 0],
    });
    expect(px(file)).toEqual([R, G, B]);
  });

  it('reads 8-bit palettes top-down (negative height) and maps missing palette entries to black', () => {
    const file = buildBmp({
      width: 2,
      height: -2,
      bpp: 8,
      clrUsed: 2,
      palette: [
        [255, 0, 0],
        [0, 0, 255],
      ],
      data: [0, 1, 0, 0, 1, 7, 0, 0],
    });
    expect(px(file)).toEqual([R, B, B, K]);
  });

  it('reads BITMAPCOREHEADER files (3-byte palette entries, 24-bit)', () => {
    const pal = buildBmp({
      headerSize: 12,
      width: 2,
      height: 1,
      bpp: 8,
      palette: [
        [0, 255, 0],
        [255, 255, 255],
      ],
      data: [1, 0, 0, 0],
    });
    expect(px(pal)).toEqual([W, G]);
    const rgb = buildBmp({ headerSize: 12, width: 1, height: 2, bpp: 24, data: [255, 0, 0, 0, 0, 0, 255, 0] });
    expect(px(rgb)).toEqual([R, B]);
    expect(readBmpHeader(rgb)).toMatchObject({ headerSize: 12, width: 1, height: 2, bitsPerPixel: 24, topDown: false });
  });

  it('reads 16-bit 5-5-5 (BI_RGB) and 5-6-5 (BI_BITFIELDS)', () => {
    const rgb555 = buildBmp({ width: 4, height: 1, bpp: 16, data: [0x00, 0x7c, 0xe0, 0x03, 0x1f, 0x00, 0xff, 0x7f] });
    expect(px(rgb555)).toEqual([R, G, B, W]);
    const rgb565 = buildBmp({
      width: 2,
      height: 1,
      bpp: 16,
      compression: 3,
      masks: [0xf800, 0x07e0, 0x001f],
      data: [0x00, 0xf8, 0xe0, 0x07],
    });
    expect(px(rgb565)).toEqual([R, G]);
  });

  it('reads 24-bit rows with padding', () => {
    // width 3 → 9 bytes + 3 padding per row; bottom row first.
    const file = buildBmp({
      width: 3,
      height: 2,
      bpp: 24,
      data: [0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, /* top */ 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    expect(px(file)).toEqual([W, K, K, R, G, B]);
  });

  it('treats an all-zero 4th byte of 32-bit BI_RGB as opaque, and real values as alpha', () => {
    const opaque = buildBmp({ width: 2, height: 1, bpp: 32, data: [0, 0, 255, 0, 255, 0, 0, 0] });
    expect(px(opaque)).toEqual([R, B]);
    const alpha = buildBmp({ width: 2, height: 1, bpp: 32, data: [0, 0, 255, 128, 255, 0, 0, 0] });
    expect(px(alpha)).toEqual([
      [255, 0, 0, 128],
      [0, 0, 255, 0],
    ]);
  });

  it('reads 32-bit BI_BITFIELDS with an alpha mask (V4/V5 headers) and BI_ALPHABITFIELDS', () => {
    const v4 = buildBmp({
      headerSize: 108,
      width: 2,
      height: 1,
      bpp: 32,
      compression: 3,
      masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
      data: [0x10, 0x20, 0x30, 0x40, 0xff, 0xff, 0xff, 0xff],
    });
    expect(px(v4)).toEqual([
      [0x30, 0x20, 0x10, 0x40],
      [255, 255, 255, 255],
    ]);
    const alphaBitfields = buildBmp({
      width: 1,
      height: 1,
      bpp: 32,
      compression: 6,
      masks: [0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000],
      data: [0x11, 0x22, 0x33, 0x80],
    });
    expect(px(alphaBitfields)).toEqual([[0x11, 0x22, 0x33, 0x80]]);
  });

  it('decodes RLE8 (runs, absolute mode with padding, delta, end of line, end of bitmap)', () => {
    // 4×3, bottom-up. Row 0 (bottom): run of 3×1, then EOL. Row 1: absolute 3 pixels [2,0,1] (+1 pad), EOL.
    // Row 2 (top): delta (+2, +0), run of 2×2, EOB.
    const file = buildBmp({
      width: 4,
      height: 3,
      bpp: 8,
      compression: 1,
      palette: [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ],
      data: [3, 1, 0, 0, 0, 3, 2, 0, 1, 0, 0, 0, 0, 2, 2, 0, 2, 2, 0, 1],
    });
    expect(px(file)).toEqual([T, T, B, B, B, R, G, T, G, G, G, T]);
  });

  it('decodes RLE4 (alternating nibbles, odd absolute runs)', () => {
    // 8×1: run of 3 alternating 1/2, then absolute 5 pixels [0,1,2,0,1] (3 bytes + 1 pad), EOB.
    // (Absolute runs are ≥ 3 pixels: escape values 0/1/2 mean EOL/EOB/delta.)
    const file = buildBmp({
      width: 8,
      height: 1,
      bpp: 4,
      compression: 2,
      palette: [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ],
      data: [3, 0x12, 0, 5, 0x01, 0x20, 0x10, 0x00, 0, 1],
    });
    expect(px(file)).toEqual([G, B, G, R, G, B, R, G]);
  });

  it('matches files written by macOS ImageIO (sips: 24-bit top-down and 32-bit V5 with alpha)', async () => {
    for (const [bmp, png] of [
      ['sips-rgb24.bmp', 'sips-source-rgb.png'],
      ['sips-rgba32.bmp', 'sips-source-rgba.png'],
    ] as const) {
      const bmpPath = staticFixture(bmp);
      const pngPath = staticFixture(png);
      expect(bmpPath && pngPath, `${bmp} is committed`).toBeTruthy();
      const decoded = decodeBmp(await readFile(bmpPath!), 1e6);
      const want = await sharp(pngPath!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([decoded.width, decoded.height]).toEqual([want.info.width, want.info.height]);
      expect(decoded.data.equals(want.data)).toBe(true);
    }
  });

  it('validates sizes before allocating: IMAGE_TOO_LARGE above maxPixels, IMAGE_CORRUPT for truncated data', () => {
    const huge = buildBmp({ width: 100_000, height: 100_000, bpp: 24, data: [0, 0, 0, 0] });
    expect(codeOf(() => decodeBmp(huge, 268_402_689))).toBe('IMAGE_TOO_LARGE');
    const truncated = buildBmp({ width: 100, height: 100, bpp: 24, data: new Array(500).fill(0) });
    expect(codeOf(() => decodeBmp(truncated, 1e6))).toBe('IMAGE_CORRUPT');
  });

  it('rejects malformed headers with IMAGE_CORRUPT and embedded JPEG/PNG with UNSUPPORTED_FORMAT', () => {
    const good = buildBmp({ width: 1, height: 1, bpp: 24, data: [1, 2, 3, 0] });
    const badSignature = Buffer.from(good);
    badSignature.write('XX', 0, 'latin1');
    expect(codeOf(() => decodeBmp(badSignature, 10))).toBe('IMAGE_CORRUPT');
    const badHeader = Buffer.from(good);
    badHeader.writeUInt32LE(41, 14);
    expect(codeOf(() => decodeBmp(badHeader, 10))).toBe('IMAGE_CORRUPT');
    expect(codeOf(() => decodeBmp(buildBmp({ width: 0, height: 1, bpp: 24, data: [0, 0, 0, 0] }), 10))).toBe('IMAGE_CORRUPT');
    expect(codeOf(() => decodeBmp(buildBmp({ width: 1, height: 1, bpp: 7, data: [0, 0, 0, 0] }), 10))).toBe('IMAGE_CORRUPT');
    expect(codeOf(() => decodeBmp(buildBmp({ width: 1, height: 1, bpp: 24, compression: 4, data: [0xff, 0xd8] }), 10))).toBe('UNSUPPORTED_FORMAT');
    expect(codeOf(() => decodeBmp(Buffer.from('BM'), 10))).toBe('IMAGE_CORRUPT');
    const badOffset = Buffer.from(good);
    badOffset.writeUInt32LE(9999, 10);
    expect(codeOf(() => decodeBmp(badOffset, 10))).toBe('IMAGE_CORRUPT');
  });
});

describe('BMP encoder', () => {
  function rgba(width: number, height: number, alpha: (x: number, y: number) => number): Buffer {
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) data.set([(x * 50) % 256, (y * 70) % 256, (x * y * 30) % 256, alpha(x, y)], (y * width + x) * 4);
    }
    return data;
  }

  it('writes 24-bit BI_RGB with BITMAPINFOHEADER for opaque images and round-trips all widths (row padding)', () => {
    for (let width = 1; width <= 6; width += 1) {
      const data = rgba(width, 3, () => 255);
      const file = encodeBmp({ data, width, height: 3 });
      expect(file.toString('latin1', 0, 2)).toBe('BM');
      expect(file.readUInt32LE(2)).toBe(file.length);
      expect(file.readUInt32LE(14)).toBe(40);
      expect(file.readUInt16LE(28)).toBe(24);
      expect(file.readUInt32LE(30)).toBe(0);
      expect(file.length).toBe(54 + Math.ceil((width * 3) / 4) * 4 * 3);
      expect(decodeBmp(file, 1e6).data.equals(data)).toBe(true);
    }
  });

  it('writes 32-bit BGRA with BITMAPV5HEADER + BI_BITFIELDS (alpha mask, sRGB) when alpha is present', () => {
    const data = rgba(5, 4, (x, y) => (x + y) * 20);
    const file = encodeBmp({ data, width: 5, height: 4 });
    expect(file.readUInt32LE(14)).toBe(124);
    expect(file.readUInt32LE(10)).toBe(138);
    expect(file.toString('latin1', 70, 74)).toBe('BGRs');
    expect(file.readUInt16LE(28)).toBe(32);
    expect(file.readUInt32LE(30)).toBe(3);
    expect([file.readUInt32LE(54), file.readUInt32LE(58), file.readUInt32LE(62), file.readUInt32LE(66)]).toEqual([0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000]);
    expect(decodeBmp(file, 1e6).data.equals(data)).toBe(true);
  });

  it('rejects invalid sizes', () => {
    expect(codeOf(() => encodeBmp({ data: Buffer.alloc(0), width: 0, height: 1 }))).toBe('INVALID_OPTIONS');
    expect(codeOf(() => encodeBmp({ data: Buffer.alloc(4), width: 2, height: 2 }))).toBe('INTERNAL');
  });

  it.skipIf(process.platform !== 'darwin')('produces files macOS ImageIO decodes to the same pixels (sips)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orbitdrop-bmp-sips-'));
    try {
      for (const [name, alpha] of [
        ['opaque', () => 255],
        ['alpha', (x: number, y: number) => (x === 0 ? 0 : 60 + x * 30 + y * 10)],
      ] as const) {
        const width = 7;
        const height = 5;
        const data = rgba(width, height, alpha);
        const bmpPath = join(dir, `${name}.bmp`);
        const pngPath = join(dir, `${name}.png`);
        await writeFile(bmpPath, encodeBmp({ data, width, height }));
        execFileSync('sips', ['-s', 'format', 'png', bmpPath, '--out', pngPath], { stdio: 'ignore' });
        const back = await sharp(pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect([back.info.width, back.info.height]).toEqual([width, height]);
        for (let i = 0; i < data.length; i += 4) {
          expect(Math.abs(back.data[i + 3]! - data[i + 3]!), `alpha @${i / 4}`).toBeLessThanOrEqual(1);
          if (data[i + 3]! === 0) continue;
          for (let c = 0; c < 3; c += 1) {
            // ImageIO premultiplies internally; allow rounding for translucent pixels.
            const tolerance = data[i + 3] === 255 ? 0 : Math.ceil(255 / data[i + 3]!) + 1;
            expect(Math.abs(back.data[i + c]! - data[i + c]!), `channel ${c} @${i / 4}`).toBeLessThanOrEqual(tolerance);
          }
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
