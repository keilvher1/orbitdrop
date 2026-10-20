import type { FileFormat } from '@orbitdrop/contracts';

/** Bytes needed by detectFormatFromHeader. */
export const SNIFF_BYTES = 64;

const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/**
 * Detect a file format from its first bytes. Extensions are never trusted on
 * their own; main compares the result with the extension and flags mismatches.
 */
export function detectFormatFromHeader(bytes: Uint8Array): FileFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a) return 'png';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'gif';
  if (bytes.length >= 4) {
    const le = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
    const be = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
    const bigLe = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2b && bytes[3] === 0x00;
    const bigBe = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2b;
    if (le || be || bigLe || bigBe) return 'tiff';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.length >= 14) {
    // 'BM' + plausible header size at offset 14 (12, 40, 52, 56, 64, 108, 124).
    const dib = bytes.length >= 18 ? (bytes[14]! | (bytes[15]! << 8)) : 40;
    if ([12, 16, 40, 52, 56, 64, 108, 124].includes(dib)) return 'bmp';
  }
  // ISO-BMFF: size(4) 'ftyp' major_brand(4) minor(4) compatible brands...
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    const end = Math.min(bytes.length, Math.max(16, boxSize));
    const brands = [ascii(bytes, 8, 4)];
    for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(bytes, i, 4));
    if (brands.some((b) => b === 'avif' || b === 'avis')) return 'avif';
    if (brands.some((b) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(b))) return 'heic';
  }
  // PDF: "%PDF-" may be preceded by up to 1024 junk bytes per spec; we check the sniffed window.
  for (let i = 0; i + 5 <= bytes.length; i += 1) {
    if (bytes[i] === 0x25 && ascii(bytes, i, 5) === '%PDF-') return 'pdf';
  }
  return null;
}
