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
 *
 * Every produced name is NFC, at most MAX_NAME_BYTES UTF-8 bytes, valid on
 * macOS and Windows (no forbidden characters, no trailing dot/space, no device
 * names) and visible (no leading dot).
 */

/**
 * Most file systems limit a name to 255 bytes or units (APFS: UTF-8 bytes,
 * NTFS: UTF-16 units, HFS+: UTF-16 units of the NFD form). 255 UTF-8 bytes of
 * NFC text satisfies all of them (a Hangul syllable is 3 bytes / 1 unit and
 * decomposes into at most 3 units).
 */
export const MAX_NAME_BYTES = 255;

/**
 * Windows device names. Reserved with any extension ("NUL.tar.gz" is NUL), so
 * they are checked against the part before the first dot. COM0/LPT0 and the
 * superscript digits ¹²³ are reserved too.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/** UTF-8 length; a lone surrogate counts 3 bytes (it is written as U+FFFD). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

let segmenter: GraphemeSegmenter | null | undefined;

/** User-perceived characters (grapheme clusters) when Intl.Segmenter exists, else code points. */
function graphemes(text: string): Iterable<string> {
  if (segmenter === undefined) {
    const Ctor = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => GraphemeSegmenter }).Segmenter;
    segmenter = Ctor ? new Ctor(undefined, { granularity: 'grapheme' }) : null;
  }
  if (segmenter === null) return text;
  const segments = segmenter.segment(text);
  return (function* () {
    for (const s of segments) yield s.segment;
  })();
}

/**
 * Trim `base` so that base + tail fits in MAX_NAME_BYTES. Cuts only between
 * grapheme clusters (so never inside a code point, an emoji sequence or a
 * Hangul syllable block) and drops dots/spaces left at the cut.
 */
function fitName(base: string, tail: string): string {
  const budget = MAX_NAME_BYTES - utf8Length(tail);
  if (utf8Length(base) <= budget) return base + tail;
  const take = (pieces: Iterable<string>): string => {
    let out = '';
    let used = 0;
    for (const piece of pieces) {
      const size = utf8Length(piece);
      if (used + size > budget) break;
      out += piece;
      used += size;
    }
    return out;
  };
  let out = take(graphemes(base));
  // A single cluster larger than the whole budget (e.g. a letter with hundreds of combining marks): cut by code point.
  if (out === '') out = take(base);
  out = out.replace(/[ .]+$/u, '');
  if (out === '') out = take('Untitled');
  return out + tail;
}

/**
 * Make a base name safe on both macOS and Windows: NFC, no path separators, no
 * characters Windows forbids (control characters, < > : " / \ | ? *), no lone
 * surrogates, no leading dots (outputs must not be hidden), no trailing dots or
 * spaces, no reserved device names ("CON" → "CON_", "nul.tar" → "nul_.tar").
 */
export function sanitizeBaseName(base: string): string {
  let out = base
    .replace(LONE_SURROGATE, '�')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '_')
    .replace(/^\.+/u, '')
    .replace(/[ .]+$/u, '');
  if (out.length === 0) out = 'Untitled';
  const firstDot = out.indexOf('.');
  const stem = firstDot < 0 ? out : out.slice(0, firstDot);
  if (WINDOWS_RESERVED.test(stem)) out = `${stem}_${out.slice(stem.length)}`;
  return out;
}

function baseOf(inputName: string): string {
  return sanitizeBaseName(splitName(inputName).base);
}

/** Zero-padded page number: at least 3 digits, more for very long documents (p0001 from 1000 pages). */
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
