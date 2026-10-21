/**
 * Lossless metadata removal: the compressed image data is copied byte for byte,
 * only metadata containers are dropped. Each function returns null when the
 * file does not parse cleanly (the caller then falls back to re-encoding).
 *
 * JPEG — kept: SOI, SOFn, DHT, DQT, DRI, DAC, SOS + entropy-coded data, EOI,
 *   APP0 "JFIF" (density; any embedded JFIF thumbnail is cut out), APP14
 *   "Adobe" (needed to decode CMYK/YCCK colours), APP2 "ICC_PROFILE" when
 *   `keepIcc`. Dropped: APP1 (EXIF incl. GPS and the IFD1 thumbnail, XMP,
 *   extended XMP), APP2 MPF/FlashPix, APP0 JFXX thumbnails, APP3–APP13
 *   (IPTC/Photoshop IRB in APP13), APP15, COM, and everything after EOI
 *   (MPF secondary images such as large previews, gain or depth maps).
 * PNG — kept: IHDR, PLTE, IDAT, IEND, tRNS, gAMA, cHRM, sRGB, sBIT, pHYs, bKGD,
 *   cICP, mDCv, cLLi, APNG acTL/fcTL/fdAT, iCCP when `keepIcc`. Dropped: tEXt,
 *   zTXt, iTXt (XMP, comments), eXIf, tIME, and all other ancillary chunks.
 *   An unknown critical chunk aborts (null).
 * WebP — kept: VP8/VP8L/ALPH/ANIM/ANMF, VP8X (flags updated), ICCP when
 *   `keepIcc`. Dropped: EXIF, XMP and unknown chunks.
 * GIF — kept: header, palettes, image data, graphic control and plain-text
 *   extensions, NETSCAPE/ANIMEXTS looping extensions. Dropped: comments, XMP
 *   and other application extensions (ICC application extension when !keepIcc).
 */

export interface LosslessOptions {
  readonly keepIcc: boolean;
}

// ------------------------------------------------------------------------ JPEG

function startsWith(buf: Buffer, offset: number, text: string): boolean {
  if (offset + text.length > buf.length) return false;
  for (let i = 0; i < text.length; i += 1) if (buf[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

/** Bytes of a JFIF APP0 segment without a thumbnail: marker (2) + length field value 16. */
const JFIF_BASE_SEGMENT = 18;

/**
 * JFIF APP0 without its optional uncompressed thumbnail, or null when the segment
 * is too short to be valid (APP0 is optional, so it is then dropped).
 * Layout (offsets within the segment): 0–1 FF E0, 2–3 length, 4–8 "JFIF\0",
 * 9–10 version, 11 units, 12–13 Xdensity, 14–15 Ydensity, 16 Xthumbnail,
 * 17 Ythumbnail, 18… thumbnail RGB data (3 × X × Y bytes).
 */
export function jfifWithoutThumbnail(segment: Buffer): Buffer | null {
  if (segment.length < JFIF_BASE_SEGMENT) return null;
  if (segment.length === JFIF_BASE_SEGMENT && segment[16] === 0 && segment[17] === 0) return segment;
  const out = Buffer.from(segment.subarray(0, JFIF_BASE_SEGMENT));
  out.writeUInt16BE(JFIF_BASE_SEGMENT - 2, 2);
  out[16] = 0;
  out[17] = 0;
  return out;
}

export function stripJpeg(buf: Buffer, options: LosslessOptions): Buffer | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let pos = 2;
  let sawFrame = false;
  let sawScan = false;
  for (;;) {
    if (pos >= buf.length) return null; // no EOI
    if (buf[pos] !== 0xff) return null;
    while (pos < buf.length && buf[pos] === 0xff && buf[pos + 1] === 0xff) pos += 1; // fill bytes
    if (pos + 1 >= buf.length) return null;
    const marker = buf[pos + 1]!;
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan) return null;
      parts.push(buf.subarray(pos, pos + 2));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    if (pos + 4 > buf.length) return null;
    const length = buf.readUInt16BE(pos + 2);
    if (length < 2 || pos + 2 + length > buf.length) return null;
    const segment = buf.subarray(pos, pos + 2 + length);
    const payload = pos + 4;
    pos += 2 + length;

    if (marker >= 0xe0 && marker <= 0xef) {
      if (marker === 0xe0 && startsWith(buf, payload, 'JFIF\u0000')) {
        const jfif = jfifWithoutThumbnail(segment);
        if (jfif) parts.push(jfif);
      } else if (marker === 0xe2 && options.keepIcc && startsWith(buf, payload, 'ICC_PROFILE\u0000')) parts.push(segment);
      else if (marker === 0xee && startsWith(buf, payload, 'Adobe')) parts.push(segment);
      continue; // every other APPn is metadata
    }
    if (marker === 0xfe) continue; // COM
    if ((marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) sawFrame = true;
    parts.push(segment);
    if (marker === 0xda) {
      sawScan = true;
      // Entropy-coded data runs until the next marker that is not a stuffed 0xFF00, RSTn or fill byte.
      const start = pos;
      let i = pos;
      for (;;) {
        if (i + 1 >= buf.length) return null;
        if (buf[i] === 0xff) {
          const next = buf[i + 1]!;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            i += 2;
            continue;
          }
          if (next === 0xff) {
            i += 1;
            continue;
          }
          break;
        }
        i += 1;
      }
      parts.push(buf.subarray(start, i));
      pos = i;
    }
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------------- PNG

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'pHYs', 'bKGD', 'cICP', 'mDCv', 'cLLi', 'acTL', 'fcTL', 'fdAT']);

export function stripPng(buf: Buffer, options: LosslessOptions): Buffer | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let pos = 8;
  let ended = false;
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + length;
    if (end > buf.length || !/^[A-Za-z]{4}$/.test(type)) return null;
    const critical = type.charCodeAt(0) < 0x61;
    if (PNG_KEEP.has(type) || (type === 'iCCP' && options.keepIcc)) parts.push(buf.subarray(pos, end));
    else if (critical) return null;
    pos = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  return ended ? Buffer.concat(parts) : null;
}

// ------------------------------------------------------------------------ WebP

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

export function stripWebp(buf: Buffer, options: LosslessOptions): Buffer | null {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const riffEnd = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const chunks: Buffer[] = [];
  let vp8x: Buffer | null = null;
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const fourcc = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const end = pos + 8 + size + (size & 1);
    if (pos + 8 + size > riffEnd) return null;
    const chunk = buf.subarray(pos, Math.min(end, riffEnd));
    if (fourcc === 'VP8X') {
      vp8x = Buffer.from(chunk);
      chunks.push(vp8x);
    } else if (WEBP_KEEP.has(fourcc) || (fourcc === 'ICCP' && options.keepIcc)) {
      chunks.push(chunk.length % 2 === 1 ? Buffer.concat([chunk, Buffer.alloc(1)]) : chunk);
    }
    pos = end;
  }
  if (!chunks.some((c) => ['VP8 ', 'VP8L', 'ANMF'].includes(c.toString('latin1', 0, 4)))) return null;
  if (vp8x && vp8x.length >= 9) {
    // Flags: ICC 0x20, alpha 0x10, EXIF 0x08, XMP 0x04, animation 0x02.
    let flags = vp8x[8]! & ~0x08 & ~0x04;
    if (!options.keepIcc) flags &= ~0x20;
    vp8x[8] = flags;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

// ------------------------------------------------------------------------- GIF

function skipSubBlocks(buf: Buffer, pos: number): number | null {
  let p = pos;
  for (;;) {
    if (p >= buf.length) return null;
    const size = buf[p]!;
    p += 1;
    if (size === 0) return p;
    p += size;
  }
}

export function stripGif(buf: Buffer, options: LosslessOptions): Buffer | null {
  if (buf.length < 14) return null;
  const sig = buf.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const packed = buf[10]!;
  let pos = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
  if (pos > buf.length) return null;
  const parts: Buffer[] = [buf.subarray(0, pos)];
  let images = 0;
  for (;;) {
    if (pos >= buf.length) return null;
    const introducer = buf[pos]!;
    if (introducer === 0x3b) {
      parts.push(buf.subarray(pos, pos + 1));
      break;
    }
    if (introducer === 0x2c) {
      if (pos + 10 > buf.length) return null;
      const lp = buf[pos + 9]!;
      let p = pos + 10 + (lp & 0x80 ? 3 * (1 << ((lp & 7) + 1)) : 0);
      p += 1; // LZW minimum code size
      const end = skipSubBlocks(buf, p);
      if (end === null) return null;
      parts.push(buf.subarray(pos, end));
      pos = end;
      images += 1;
      continue;
    }
    if (introducer === 0x21) {
      if (pos + 2 > buf.length) return null;
      const label = buf[pos + 1]!;
      const end = skipSubBlocks(buf, pos + 2);
      if (end === null) return null;
      let keep = label === 0xf9 || label === 0x01;
      if (label === 0xff && pos + 3 + 11 <= buf.length && buf[pos + 2] === 11) {
        const id = buf.toString('latin1', pos + 3, pos + 14);
        keep = id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0' || (options.keepIcc && id === 'ICCRGBG1012');
      }
      if (keep) parts.push(buf.subarray(pos, end));
      pos = end;
      continue;
    }
    return null;
  }
  return images > 0 ? Buffer.concat(parts) : null;
}
