import type { FileFormat } from '@orbitdrop/contracts';

/**
 * Bytes read by validateInputFile for detection. PDF readers accept up to 1024
 * junk bytes before "%PDF-", and HEIF/AVIF `ftyp` brand lists can be long, so the
 * window is 1 KiB. (Every image signature sits at offset 0.)
 */
export const SNIFF_BYTES = 1024;

const ascii = (bytes: Uint8Array, start: number, length: number): string => {
  let out = '';
  for (let i = start; i < start + length && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
};

/** BITMAPINFOHEADER family sizes our BMP codec reads (OS/2 1.x/2.x, V1–V5). */
const BMP_DIB_HEADER_SIZES = [12, 16, 40, 52, 56, 64, 108, 124];

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];

/**
 * Detect a file format from its first bytes. Extensions are never trusted on
 * their own; main compares the result with the extension and flags mismatches.
 */
export function detectFormatFromHeader(bytes: Uint8Array): FileFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'gif';
  if (bytes.length >= 4) {
    const le = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
    const be = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
    const bigLe = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2b && bytes[3] === 0x00;
    const bigBe = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2b;
    if (le || be || bigLe || bigBe) return 'tiff';
  }
  if (bytes.length >= 18 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    // 'BM' + a DIB header size we know at offset 14 (32-bit little endian).
    const dib = (bytes[14]! | (bytes[15]! << 8) | (bytes[16]! << 16) | (bytes[17]! << 24)) >>> 0;
    if (BMP_DIB_HEADER_SIZES.includes(dib)) return 'bmp';
  }
  // ISO-BMFF: size(4) 'ftyp' major_brand(4) minor_version(4) compatible_brands(4·n)
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
    const end = Math.min(bytes.length, Math.max(16, boxSize));
    const brands = [ascii(bytes, 8, 4)];
    for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(bytes, i, 4));
    if (brands.some((b) => b === 'avif' || b === 'avis')) return 'avif';
    if (brands.some((b) => HEIC_BRANDS.includes(b))) return 'heic';
  }
  // PDF: "%PDF-" may be preceded by up to 1024 junk bytes.
  const limit = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i + 5 <= limit; i += 1) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return 'pdf';
  }
  return null;
}

/** Windows Shell Link (.lnk) header: size 0x4C + CLSID 00021401-0000-0000-C000-000000000046. */
const LNK_HEADER = [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46];

/**
 * Files that only point at another file: a macOS Finder alias (bookmark data,
 * "book\0\0\0\0mark\0\0\0\0") or a Windows shortcut (.lnk). Symbolic links are
 * resolved by the file system; these are regular files and are rejected with a
 * hint to drag the original.
 */
export function detectLinkFile(bytes: Uint8Array): 'macAlias' | 'windowsShortcut' | null {
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'book' && ascii(bytes, 8, 4) === 'mark') {
    if ([4, 5, 6, 7, 12, 13, 14, 15].every((i) => bytes[i] === 0)) return 'macAlias';
  }
  if (bytes.length >= LNK_HEADER.length && LNK_HEADER.every((b, i) => bytes[i] === b)) return 'windowsShortcut';
  return null;
}
