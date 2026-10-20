import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { SNIFF_BYTES, detectFormatFromHeader, detectLinkFile } from '../src';

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

function bmpHeader(dibSize: number): Uint8Array {
  const b = new Uint8Array(64);
  b[0] = 0x42;
  b[1] = 0x4d;
  new DataView(b.buffer).setUint32(14, dibSize, true);
  return b;
}

/** First 40 bytes of a real HEIC written by macOS `sips -s format heic` (ftyp heic, brands mif1 MiPr miaf MiHB heic). */
const REAL_HEIC_HEAD = Uint8Array.from([
  0x00, 0x00, 0x00, 0x24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00, 0x6d, 0x69, 0x66, 0x31, 0x4d, 0x69, 0x50, 0x72, 0x6d,
  0x69, 0x61, 0x66, 0x4d, 0x69, 0x48, 0x42, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x01, 0xc3,
]);

describe('detectFormatFromHeader', () => {
  it('recognizes every input format by its signature', () => {
    expect(detectFormatFromHeader(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(detectFormatFromHeader(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(detectFormatFromHeader(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('webp');
    expect(detectFormatFromHeader(bytes('GIF89a'))).toBe('gif');
    expect(detectFormatFromHeader(bytes('GIF87a'))).toBe('gif');
    expect(detectFormatFromHeader(bytes('II*', [0]))).toBe('tiff');
    expect(detectFormatFromHeader(bytes('MM', [0], '*'))).toBe('tiff');
    expect(detectFormatFromHeader(bytes('II+', [0]))).toBe('tiff');
    expect(detectFormatFromHeader(REAL_HEIC_HEAD)).toBe('heic');
    expect(detectFormatFromHeader(bytes([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0], 'avifmif1miaf'))).toBe('avif');
    expect(detectFormatFromHeader(bytes([0, 0, 0, 0x18], 'ftypmif1', [0, 0, 0, 0], 'mif1avis'))).toBe('avif');
    expect(detectFormatFromHeader(bytes('%PDF-1.7\n'))).toBe('pdf');
    for (const size of [12, 16, 40, 52, 56, 64, 108, 124]) expect(detectFormatFromHeader(bmpHeader(size))).toBe('bmp');
  });

  it('finds %PDF- after up to 1 KiB of junk, not beyond', () => {
    const junk = (n: number) => {
      const b = new Uint8Array(n + 8).fill(0x20);
      b.set(bytes('%PDF-1.4'), n);
      return b;
    };
    expect(SNIFF_BYTES).toBe(1024);
    expect(detectFormatFromHeader(junk(1000))).toBe('pdf');
    expect(detectFormatFromHeader(junk(1019))).toBe('pdf');
    expect(detectFormatFromHeader(junk(1020))).toBeNull();
  });

  it('rejects look-alikes and truncated headers', () => {
    expect(detectFormatFromHeader(new Uint8Array())).toBeNull();
    expect(detectFormatFromHeader(bytes([0xff, 0xd8]))).toBeNull();
    expect(detectFormatFromHeader(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x00, 0x00]))).toBeNull();
    expect(detectFormatFromHeader(bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt '))).toBeNull();
    expect(detectFormatFromHeader(bytes('GIF90a'))).toBeNull();
    expect(detectFormatFromHeader(bytes('BMW is a car brand, not a bitmap'))).toBeNull();
    expect(detectFormatFromHeader(bmpHeader(41))).toBeNull();
    expect(detectFormatFromHeader(bytes('BM', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40]))).toBeNull(); // too short for the DIB size
    expect(detectFormatFromHeader(bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 2, 0], 'isomiso2'))).toBeNull(); // MP4 video
    expect(detectFormatFromHeader(bytes([0, 0, 0, 0x18], 'ftypcrx ', [0, 0, 0, 1], 'crx isom'))).toBeNull(); // Canon CR3
    expect(detectFormatFromHeader(bytes('PK', [3, 4], 'word/document.xml'))).toBeNull(); // DOCX is output only
    expect(detectFormatFromHeader(bytes('hello world'))).toBeNull();
  });
});

describe('detectLinkFile', () => {
  it('recognizes Finder aliases and Windows shortcuts', () => {
    expect(detectLinkFile(bytes('book', [0, 0, 0, 0], 'mark', [0, 0, 0, 0, 0x38, 0, 0, 0]))).toBe('macAlias');
    const lnk = Uint8Array.from([0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46, 0x9b, 0, 0x08, 0]);
    expect(detectLinkFile(lnk)).toBe('windowsShortcut');
    expect(detectLinkFile(bytes('bookmark is a word'))).toBeNull();
    expect(detectLinkFile(bytes([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

const require = createRequire(import.meta.url);
let sharp: ((input?: unknown, options?: unknown) => any) | null = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

describe.runIf(sharp !== null)('real encoder output (sharp, when installed)', () => {
  it('detects files written by the bundled encoders', async () => {
    const base = sharp!({ create: { width: 3, height: 2, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 0.5 } } });
    const png = await base.png().toBuffer();
    for (const [format, expected] of [
      ['jpeg', 'jpeg'],
      ['png', 'png'],
      ['webp', 'webp'],
      ['tiff', 'tiff'],
      ['gif', 'gif'],
      ['avif', 'avif'],
    ] as const) {
      const encoded: Buffer = await sharp!(png)[format]().toBuffer();
      expect(detectFormatFromHeader(encoded.subarray(0, SNIFF_BYTES))).toBe(expected);
    }
  });
});
