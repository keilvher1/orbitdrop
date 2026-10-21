import { OrbitError } from '@orbitdrop/contracts';

/**
 * Built-in BMP codec (sharp/libvips has no BMP loader or saver).
 *
 * Decoder: BITMAPCOREHEADER (OS/2 1.x), OS/2 2.x (16/64 bytes), BITMAPINFOHEADER
 * and its V2/V3/V4/V5 extensions; 1/2/4/8-bit palettes, 16/24/32-bit, BI_RGB,
 * BI_BITFIELDS, BI_ALPHABITFIELDS, BI_RLE8, BI_RLE4; bottom-up and top-down rows.
 * Sizes are validated against the buffer and the pixel limit before any pixel
 * buffer is allocated.
 *
 * Encoder: 24-bit BI_RGB with BITMAPINFOHEADER when every pixel is opaque,
 * otherwise 32-bit BGRA with BITMAPV5HEADER + BI_BITFIELDS (explicit alpha
 * mask, LCS_sRGB) — the layout Windows and macOS themselves write for alpha
 * BMPs. (A BITMAPV4HEADER with LCS_sRGB is rejected by macOS ImageIO —
 * "Cannot extract image from file" — so V5 is used; V5 is a superset of V4.)
 */

export interface RawRgba {
  /** Straight (non-premultiplied) RGBA, row-major, top row first, width × height × 4 bytes. */
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

export interface BmpHeaderInfo {
  readonly width: number;
  readonly height: number;
  readonly bitsPerPixel: number;
  readonly compression: BmpCompression;
  readonly headerSize: number;
  readonly topDown: boolean;
}

export type BmpCompression = 'rgb' | 'rle8' | 'rle4' | 'bitfields' | 'alphabitfields';

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;
const BI_JPEG = 4;
const BI_PNG = 5;
const BI_ALPHABITFIELDS = 6;

const FILE_HEADER_SIZE = 14;
const INFO_HEADER_SIZE = 40;
const V5_HEADER_SIZE = 124;
/** bV5Intent: LCS_GM_IMAGES (perceptual), what Windows writes. */
const LCS_GM_IMAGES = 4;
/** 72 DPI expressed in pixels per metre. */
const PELS_PER_METER_72DPI = 2835;
const LCS_SRGB = 0x73524742;
const MAX_FILE_BYTES = 0xffffffff;

function corrupt(detail: string): OrbitError {
  return new OrbitError('IMAGE_CORRUPT', 'BMP could not be decoded', { detail });
}

interface Header extends BmpHeaderInfo {
  readonly dataOffset: number;
  readonly paletteOffset: number;
  readonly paletteEntrySize: 3 | 4;
  readonly colorsUsed: number;
  readonly masks: { r: number; g: number; b: number; a: number } | null;
}

function parseHeader(buf: Buffer): Header {
  if (buf.length < FILE_HEADER_SIZE + 12) throw corrupt('file too short');
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) throw corrupt('missing BM signature');
  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  const isCore = headerSize === 12;
  const isOs2v2 = headerSize === 16 || headerSize === 64;
  const knownInfo = [40, 52, 56, 108, 124].includes(headerSize);
  if (!isCore && !isOs2v2 && !knownInfo) throw corrupt(`unknown DIB header size ${headerSize}`);
  if (FILE_HEADER_SIZE + headerSize > buf.length) throw corrupt('truncated DIB header');

  let width: number;
  let height: number;
  let bitsPerPixel: number;
  let compressionCode = BI_RGB;
  let colorsUsed = 0;
  if (isCore) {
    width = buf.readUInt16LE(18);
    height = buf.readInt16LE(20);
    bitsPerPixel = buf.readUInt16LE(24);
  } else {
    width = buf.readInt32LE(18);
    height = buf.readInt32LE(22);
    bitsPerPixel = buf.readUInt16LE(28);
    if (headerSize >= 20) compressionCode = buf.readUInt32LE(30);
    if (headerSize >= 36) colorsUsed = buf.readUInt32LE(46);
  }

  if (isOs2v2 && (compressionCode === 3 || compressionCode === 4)) {
    throw new OrbitError('UNSUPPORTED_FORMAT', 'OS/2 Huffman/RLE24 BMP is not supported');
  }
  if (compressionCode === BI_JPEG || compressionCode === BI_PNG) {
    throw new OrbitError('UNSUPPORTED_FORMAT', 'BMP with embedded JPEG/PNG data is not supported');
  }

  let compression: BmpCompression;
  switch (compressionCode) {
    case BI_RGB:
      compression = 'rgb';
      break;
    case BI_RLE8:
      compression = 'rle8';
      break;
    case BI_RLE4:
      compression = 'rle4';
      break;
    case BI_BITFIELDS:
      compression = 'bitfields';
      break;
    case BI_ALPHABITFIELDS:
      compression = 'alphabitfields';
      break;
    default:
      throw corrupt(`unknown compression ${compressionCode}`);
  }

  if (width <= 0) throw corrupt('invalid width');
  if (height === 0 || height === -2147483648) throw corrupt('invalid height');
  const topDown = height < 0;
  const absHeight = Math.abs(height);

  const validDepth =
    (compression === 'rgb' && [1, 2, 4, 8, 16, 24, 32].includes(bitsPerPixel)) ||
    (compression === 'rle8' && bitsPerPixel === 8) ||
    (compression === 'rle4' && bitsPerPixel === 4) ||
    ((compression === 'bitfields' || compression === 'alphabitfields') && (bitsPerPixel === 16 || bitsPerPixel === 32));
  if (!validDepth) throw corrupt(`unsupported bit depth ${bitsPerPixel} for ${compression}`);

  let masks: Header['masks'] = null;
  if (compression === 'bitfields' || compression === 'alphabitfields') {
    // V2+ headers carry the masks inside the header; a 40-byte header is followed by them.
    const maskOffset = FILE_HEADER_SIZE + 40;
    const needAlpha = compression === 'alphabitfields' || headerSize >= 56;
    if (maskOffset + (needAlpha ? 16 : 12) > buf.length) throw corrupt('truncated bitfield masks');
    masks = {
      r: buf.readUInt32LE(maskOffset),
      g: buf.readUInt32LE(maskOffset + 4),
      b: buf.readUInt32LE(maskOffset + 8),
      a: needAlpha ? buf.readUInt32LE(maskOffset + 12) : 0,
    };
    if ((masks.r | masks.g | masks.b) === 0) {
      // Malformed header without colour masks: use the BI_RGB defaults.
      masks = bitsPerPixel === 16 ? { r: 0x7c00, g: 0x03e0, b: 0x001f, a: masks.a } : { r: 0xff0000, g: 0xff00, b: 0xff, a: masks.a };
    }
  } else if (compression === 'rgb' && bitsPerPixel === 16) {
    masks = { r: 0x7c00, g: 0x03e0, b: 0x001f, a: 0 };
  }

  const extraMaskBytes = headerSize === 40 ? (compression === 'bitfields' ? 12 : compression === 'alphabitfields' ? 16 : 0) : 0;
  const paletteOffset = FILE_HEADER_SIZE + headerSize + extraMaskBytes;
  if (dataOffset < paletteOffset || dataOffset >= buf.length) throw corrupt('invalid pixel data offset');

  return {
    width,
    height: absHeight,
    bitsPerPixel,
    compression,
    headerSize,
    topDown,
    dataOffset,
    paletteOffset,
    paletteEntrySize: isCore ? 3 : 4,
    colorsUsed,
    masks,
  };
}

/** Header fields only (no pixel decoding). Throws IMAGE_CORRUPT/UNSUPPORTED_FORMAT like decodeBmp. */
export function readBmpHeader(buffer: Buffer): BmpHeaderInfo {
  const h = parseHeader(buffer);
  return { width: h.width, height: h.height, bitsPerPixel: h.bitsPerPixel, compression: h.compression, headerSize: h.headerSize, topDown: h.topDown };
}

/** Palette as packed 0xRRGGBB values. Missing entries decode as black. */
function readPalette(buf: Buffer, h: Header): Uint32Array {
  const max = 1 << h.bitsPerPixel;
  const declared = h.colorsUsed > 0 ? Math.min(h.colorsUsed, max) : max;
  const room = Math.floor((h.dataOffset - h.paletteOffset) / h.paletteEntrySize);
  const count = Math.max(0, Math.min(declared, room));
  const palette = new Uint32Array(max);
  for (let i = 0; i < count; i += 1) {
    const o = h.paletteOffset + i * h.paletteEntrySize;
    palette[i] = (buf[o + 2]! << 16) | (buf[o + 1]! << 8) | buf[o]!;
  }
  return palette;
}

interface Channel {
  readonly mask: number;
  readonly shift: number;
  readonly bits: number;
}

function channelOf(mask: number): Channel {
  const m = mask >>> 0;
  if (m === 0) return { mask: 0, shift: 0, bits: 0 };
  let shift = 0;
  while (((m >>> shift) & 1) === 0) shift += 1;
  let bits = 0;
  while (shift + bits < 32 && ((m >>> (shift + bits)) & 1) === 1) bits += 1;
  return { mask: m, shift, bits };
}

function extract(value: number, ch: Channel): number {
  if (ch.bits === 0) return 0;
  const v = ((value & ch.mask) >>> 0) >>> ch.shift;
  if (ch.bits === 8) return v & 0xff;
  if (ch.bits > 8) return (v >>> (ch.bits - 8)) & 0xff;
  return Math.round((v * 255) / ((1 << ch.bits) - 1));
}

function decodeUncompressed(buf: Buffer, h: Header, out: Buffer): void {
  const { width, height, bitsPerPixel: bpp } = h;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const lastRowBytes = Math.ceil((bpp * width) / 8);
  const needed = rowSize * (height - 1) + lastRowBytes;
  if (needed > buf.length - h.dataOffset) throw corrupt('pixel data is truncated');
  const palette = bpp <= 8 ? readPalette(buf, h) : null;
  const masks = h.masks;
  const r = masks ? channelOf(masks.r) : null;
  const g = masks ? channelOf(masks.g) : null;
  const b = masks ? channelOf(masks.b) : null;
  const a = masks ? channelOf(masks.a) : null;
  const rgb32UsesAlphaByte = bpp === 32 && h.compression === 'rgb';
  let anyAlpha = false;

  for (let row = 0; row < height; row += 1) {
    const src = h.dataOffset + row * rowSize;
    const y = h.topDown ? row : height - 1 - row;
    let dst = y * width * 4;
    if (palette) {
      const perByte = 8 / bpp;
      const valueMask = (1 << bpp) - 1;
      for (let x = 0; x < width; x += 1) {
        const byte = buf[src + Math.floor(x / perByte)]!;
        const shift = 8 - bpp * ((x % perByte) + 1);
        const color = palette[(byte >> shift) & valueMask]!;
        out[dst] = (color >> 16) & 0xff;
        out[dst + 1] = (color >> 8) & 0xff;
        out[dst + 2] = color & 0xff;
        out[dst + 3] = 255;
        dst += 4;
      }
    } else if (bpp === 24) {
      for (let x = 0, s = src; x < width; x += 1, s += 3) {
        out[dst] = buf[s + 2]!;
        out[dst + 1] = buf[s + 1]!;
        out[dst + 2] = buf[s]!;
        out[dst + 3] = 255;
        dst += 4;
      }
    } else if (rgb32UsesAlphaByte) {
      for (let x = 0, s = src; x < width; x += 1, s += 4) {
        out[dst] = buf[s + 2]!;
        out[dst + 1] = buf[s + 1]!;
        out[dst + 2] = buf[s]!;
        const alpha = buf[s + 3]!;
        out[dst + 3] = alpha;
        if (alpha !== 0) anyAlpha = true;
        dst += 4;
      }
    } else {
      // 16/32-bit with masks (BI_BITFIELDS, BI_ALPHABITFIELDS or default 5-5-5).
      for (let x = 0; x < width; x += 1) {
        const value = bpp === 16 ? buf.readUInt16LE(src + x * 2) : buf.readUInt32LE(src + x * 4);
        out[dst] = extract(value, r!);
        out[dst + 1] = extract(value, g!);
        out[dst + 2] = extract(value, b!);
        out[dst + 3] = a!.bits === 0 ? 255 : extract(value, a!);
        dst += 4;
      }
    }
  }

  // 32-bit BI_RGB: the 4th byte is "reserved". Most writers leave it 0 (opaque
  // image); some store real alpha. All-zero means opaque.
  if (rgb32UsesAlphaByte && !anyAlpha) {
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
  }
}

function decodeRle(buf: Buffer, h: Header, out: Buffer): void {
  const { width, height } = h;
  const palette = readPalette(buf, h);
  const is4 = h.compression === 'rle4';
  let x = 0;
  let line = 0;
  let pos = h.dataOffset;
  const end = buf.length;

  const put = (index: number): void => {
    if (x < width && line < height) {
      const y = h.topDown ? line : height - 1 - line;
      const dst = (y * width + x) * 4;
      const color = palette[index] ?? 0;
      out[dst] = (color >> 16) & 0xff;
      out[dst + 1] = (color >> 8) & 0xff;
      out[dst + 2] = color & 0xff;
      out[dst + 3] = 255;
    }
    x += 1;
  };

  while (pos + 1 < end && line < height) {
    const count = buf[pos]!;
    const value = buf[pos + 1]!;
    pos += 2;
    if (count > 0) {
      if (is4) {
        const hi = value >> 4;
        const lo = value & 0x0f;
        for (let i = 0; i < count; i += 1) put(i % 2 === 0 ? hi : lo);
      } else {
        for (let i = 0; i < count; i += 1) put(value);
      }
      continue;
    }
    if (value === 0) {
      // end of line
      x = 0;
      line += 1;
    } else if (value === 1) {
      // end of bitmap
      return;
    } else if (value === 2) {
      // delta
      if (pos + 1 >= end) return;
      x += buf[pos]!;
      line += buf[pos + 1]!;
      pos += 2;
    } else {
      // absolute run of `value` pixels, padded to a 16-bit boundary
      const bytes = is4 ? Math.ceil(value / 2) : value;
      if (pos + bytes > end) return;
      for (let i = 0; i < value; i += 1) {
        if (is4) {
          const byte = buf[pos + (i >> 1)]!;
          put(i % 2 === 0 ? byte >> 4 : byte & 0x0f);
        } else {
          put(buf[pos + i]!);
        }
      }
      pos += bytes + (bytes % 2);
    }
  }
}

/**
 * Decode a BMP file to straight RGBA. Pixels an RLE stream never sets stay
 * fully transparent.
 */
export function decodeBmp(buffer: Buffer, maxPixels: number): RawRgba {
  const h = parseHeader(buffer);
  const pixels = h.width * h.height;
  if (pixels > maxPixels) {
    throw new OrbitError('IMAGE_TOO_LARGE', 'Image exceeds the pixel limit', { detail: `${h.width}x${h.height}` });
  }
  const out = Buffer.alloc(pixels * 4);
  if (h.compression === 'rle8' || h.compression === 'rle4') decodeRle(buffer, h, out);
  else decodeUncompressed(buffer, h, out);
  return { data: out, width: h.width, height: h.height };
}

function isOpaque(data: Buffer, length: number): boolean {
  for (let i = 3; i < length; i += 4) if (data[i] !== 255) return false;
  return true;
}

/**
 * Encode straight RGBA as BMP: 24-bit BI_RGB when fully opaque, otherwise
 * 32-bit BGRA (BITMAPV5HEADER, BI_BITFIELDS with an alpha mask). Rows are
 * written bottom-up, the most compatible orientation.
 */
export function encodeBmp(image: RawRgba): Buffer {
  const { data, width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new OrbitError('INVALID_OPTIONS', 'Invalid image size for BMP');
  }
  const pixelBytes = width * height * 4;
  if (data.length < pixelBytes) throw new OrbitError('INTERNAL', 'Pixel buffer is smaller than width × height × 4');

  const opaque = isOpaque(data, pixelBytes);
  const headerSize = opaque ? INFO_HEADER_SIZE : V5_HEADER_SIZE;
  const rowSize = opaque ? Math.ceil((width * 3) / 4) * 4 : width * 4;
  const imageSize = rowSize * height;
  const dataOffset = FILE_HEADER_SIZE + headerSize;
  const fileSize = dataOffset + imageSize;
  if (fileSize > MAX_FILE_BYTES || width > 0x7fffffff || height > 0x7fffffff) {
    throw new OrbitError('IMAGE_TOO_LARGE', 'Image is too large for the BMP format', { detail: `${width}x${height}` });
  }

  const out = Buffer.alloc(fileSize);
  // BITMAPFILEHEADER
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(fileSize, 2);
  out.writeUInt32LE(dataOffset, 10);
  // BITMAPINFOHEADER / BITMAPV5HEADER
  out.writeUInt32LE(headerSize, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(opaque ? 24 : 32, 28);
  out.writeUInt32LE(opaque ? BI_RGB : BI_BITFIELDS, 30);
  out.writeUInt32LE(imageSize, 34);
  out.writeInt32LE(PELS_PER_METER_72DPI, 38);
  out.writeInt32LE(PELS_PER_METER_72DPI, 42);
  if (!opaque) {
    out.writeUInt32LE(0x00ff0000, 54);
    out.writeUInt32LE(0x0000ff00, 58);
    out.writeUInt32LE(0x000000ff, 62);
    out.writeUInt32LE(0xff000000, 66);
    out.writeUInt32LE(LCS_SRGB, 70);
    // CIEXYZTRIPLE endpoints and gamma values stay zero (unused for LCS_sRGB).
    out.writeUInt32LE(LCS_GM_IMAGES, 122);
    // bV5ProfileData, bV5ProfileSize, bV5Reserved stay zero (no embedded profile).
  }

  for (let y = 0; y < height; y += 1) {
    let src = (height - 1 - y) * width * 4;
    let dst = dataOffset + y * rowSize;
    if (opaque) {
      for (let x = 0; x < width; x += 1, src += 4, dst += 3) {
        out[dst] = data[src + 2]!;
        out[dst + 1] = data[src + 1]!;
        out[dst + 2] = data[src]!;
      }
    } else {
      for (let x = 0; x < width; x += 1, src += 4, dst += 4) {
        out[dst] = data[src + 2]!;
        out[dst + 1] = data[src + 1]!;
        out[dst + 2] = data[src]!;
        out[dst + 3] = data[src + 3]!;
      }
    }
  }
  return out;
}
