/**
 * Output file naming. Pure string functions (no file system access) shared by
 * processors, main and tests.
 *
 *   convertedName('Page 001.pdf', '.jpg')                      → 'Page 001.jpg'
 *   convertedName('report.pdf', '.jpg', { index: 0, count: 3 }) → 'report-p001.jpg'
 *   toolResultName('photo.jpg', ' Cropped', '.jpg')             → 'photo Cropped.jpg'
 *   toolResultName('photo Cropped.jpg', ' With Background', '.png')
 *                                                               → 'photo Cropped With Background.png'
 *   numberedName('photo.jpg', 2)                                → 'photo (2).jpg'
 */

/** Most file systems limit a name to 255 bytes (APFS: UTF-8 bytes, NTFS: UTF-16 units). */
export const MAX_NAME_BYTES = 255;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Trim `base` (never splitting a code point) so that base + tail fits in MAX_NAME_BYTES. */
function fitName(base: string, tail: string): string {
  const budget = MAX_NAME_BYTES - utf8Length(tail);
  if (utf8Length(base) <= budget) return base + tail;
  let out = '';
  let used = 0;
  for (const ch of base) {
    const size = utf8Length(ch);
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out.replace(/[ .]+$/u, '') + tail;
}

/**
 * Make a name safe on both macOS and Windows: no path separators, no
 * characters Windows forbids, no trailing dots/spaces, no reserved device names.
 */
export function sanitizeBaseName(base: string): string {
  let out = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '_')
    .replace(/[ .]+$/u, '');
  if (out.length === 0) out = 'Untitled';
  if (WINDOWS_RESERVED.test(out)) out = `${out}_`;
  return out;
}

function baseOf(inputName: string): string {
  return sanitizeBaseName(splitName(inputName).base);
}

/** Zero-padded page number: at least 3 digits, more for very long documents. */
export function pageLabel(index: number, count: number): string {
  const width = Math.max(3, String(count).length);
  return `p${String(index + 1).padStart(width, '0')}`;
}

export function convertedName(inputName: string, targetExt: string, page?: { index: number; count: number }): string {
  const base = baseOf(inputName);
  if (page && page.count > 1) return fitName(base, `-${pageLabel(page.index, page.count)}${targetExt}`);
  return fitName(base, targetExt);
}

export function toolResultName(inputName: string, suffix: string, ext: string): string {
  return fitName(baseOf(inputName), `${suffix}${ext}`);
}

export function numberedName(name: string, n: number): string {
  if (n <= 1) return name;
  const { base, ext } = splitName(name);
  return fitName(base, ` (${n})${ext}`);
}
