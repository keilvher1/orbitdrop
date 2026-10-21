import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectImage } from '../src/tools';
import { iccDescription, isSrgbProfile } from '../src/tools/icc';
import { jfifWithoutThumbnail, stripGif, stripJpeg, stripPng, stripWebp } from '../src/tools/metadata-lossless';
import {
  BLUE,
  GREEN,
  RED,
  XMP_PACKET,
  YELLOW,
  buildTiffExif,
  commentSegment,
  exifSegment,
  inputFor,
  insertJpegSegments,
  insertPngChunks,
  iptcSegment,
  jpegScanData,
  limits,
  listDir,
  makeTempDir,
  meanAbsDiff,
  near,
  pngChunk,
  pngChunkData,
  pngChunkTypes,
  px,
  quadrantJpeg,
  readRgba,
  removeDir,
  riffChunk,
  riffChunkTypes,
  runToolJob,
  sha256,
  xmpSegment,
  writeFixture,
} from './helpers/tools-fixtures';

async function thumbnailJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 12, channels: 3, background: '#FF00FF' } }).jpeg({ quality: 50 }).toBuffer();
}

const FULL_EXIF = {
  make: 'TestMaker',
  model: 'Model Z',
  software: 'Editor 1.0',
  dateTimeOriginal: '2024:05:06 07:08:09',
  exposureTime: [1, 250] as const,
  fNumber: [28, 10] as const,
  iso: 400,
  lensModel: 'Lens 24-70',
  gps: { lat: 37.5665, lon: -126.978 },
};

/** JPEG carrying EXIF (GPS + thumbnail), XMP, IPTC and a comment; optional orientation and P3 profile. */
async function richJpeg(options: { orientation?: number; p3?: boolean } = {}): Promise<Buffer> {
  let pipeline = sharp(Buffer.from(await quadrantJpeg(320, 160)));
  if (options.p3) pipeline = pipeline.withIccProfile('p3');
  const base = await pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
  return insertJpegSegments(base, [
    exifSegment({ ...FULL_EXIF, ...(options.orientation ? { orientation: options.orientation } : {}), thumbnail: await thumbnailJpeg() }),
    xmpSegment(),
    iptcSegment('Secret caption'),
    commentSegment('secret comment'),
  ]);
}

function containsText(buf: Buffer, text: string): boolean {
  return buf.includes(Buffer.from(text, 'latin1'));
}

describe('inspectImage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('inspect');
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('reads size, orientation, EXIF summary (GPS, thumbnail), XMP/IPTC presence and the ICC description', async () => {
    const path = await writeFixture(dir, 'rich.jpg', await richJpeg({ orientation: 6, p3: true }));
    const info = await inspectImage(await inputFor(path), limits);
    expect(info.format).toBe('jpeg');
    expect(info.bytes).toBe((await readFile(path)).length);
    expect([info.width, info.height]).toEqual([320, 160]);
    expect([info.orientedWidth, info.orientedHeight]).toEqual([160, 320]);
    expect(info.orientation).toBe(6);
    expect(info.hasAlpha).toBe(false);
    expect(info.channels).toBe(3);
    expect(info.space).toBe('srgb');
    expect(info.bitDepth).toBe('8-bit');
    expect(info.hasIccProfile).toBe(true);
    expect(info.iccDescription).toMatch(/P3/);
    expect(info.hasExif).toBe(true);
    expect(info.hasXmp).toBe(true);
    expect(info.hasIptc).toBe(true);
    const exif = info.exif!;
    expect(exif.make).toBe('TestMaker');
    expect(exif.model).toBe('Model Z');
    expect(exif.software).toBe('Editor 1.0');
    expect(exif.lens).toBe('Lens 24-70');
    expect(exif.dateTimeOriginal).toBe('2024-05-06 07:08:09');
    expect(exif.exposureTime).toBe('1/250');
    expect(exif.fNumber).toBeCloseTo(2.8, 5);
    expect(exif.iso).toBe(400);
    expect(exif.gps!.latitude).toBeCloseTo(37.5665, 3);
    expect(exif.gps!.longitude).toBeCloseTo(-126.978, 3);
    expect(exif.other).toContainEqual({ tag: 'EmbeddedThumbnail', value: 'yes' });
    expect(info.pages).toBeNull();
  });

  it('works for a plain PNG with alpha and density', async () => {
    const png = await sharp({ create: { width: 30, height: 20, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer();
    // Replace sharp's pHYs with 144 DPI (5669 px/m).
    const phys = Buffer.alloc(9);
    phys.writeUInt32BE(5669, 0);
    phys.writeUInt32BE(5669, 4);
    phys[8] = 1;
    const start = png.indexOf(Buffer.from('pHYs', 'latin1')) - 4;
    const withPhys = Buffer.concat([png.subarray(0, start), pngChunk('pHYs', phys), png.subarray(start + 21)]);
    const path = await writeFixture(dir, 'a.png', withPhys);
    const info = await inspectImage(await inputFor(path), limits);
    expect(info.hasAlpha).toBe(true);
    expect(info.orientation).toBeNull();
    expect([info.orientedWidth, info.orientedHeight]).toEqual([30, 20]);
    expect(info.density).toBe(144);
    expect(info.exif).toBeNull();
    expect(info.hasExif).toBe(false);
  });
});

describe('tool.metadata (strip)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('meta');
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('removes EXIF/GPS/thumbnail/XMP/IPTC/comments from a JPEG losslessly when nothing else changes', async () => {
    const data = await richJpeg();
    const path = await writeFixture(dir, 'photo.jpg', data);
    const before = await sha256(path);
    const result = await runToolJob('tool.metadata', await inputFor(path), { mode: 'strip' });
    const out = result.outputs[0]!;
    expect(out.path.endsWith('photo No Metadata.jpg')).toBe(true);
    const stripped = await readFile(out.path);
    const meta = await sharp(stripped).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    for (const secret of ['TestMaker', 'Secret Author', 'Secret caption', 'secret comment', 'Exif']) expect(containsText(stripped, secret)).toBe(false);
    // the thumbnail JPEG (its own SOI after the main SOI) is gone too
    expect(stripped.indexOf(Buffer.from([0xff, 0xd8]), 2)).toBe(-1);
    // lossless: the compressed scan data is byte-identical and the pixels are identical
    expect(jpegScanData(stripped).equals(jpegScanData(data))).toBe(true);
    expect(meanAbsDiff(await readRgba(stripped), await readRgba(data))).toBe(0);
    expect(stripped.length).toBeLessThan(data.length);
    expect(await sha256(path)).toBe(before);
    expect(await listDir(dir)).toEqual(['photo No Metadata.jpg', 'photo.jpg']);
  });

  it('cuts the uncompressed JFIF thumbnail out of APP0 and keeps the rest of the segment', async () => {
    // sharp writes no APP0; build one: JFIF with a 2×2 RGB thumbnail whose first bytes are zero
    // (the thumbnail data starts at segment offset 18).
    const base = await quadrantJpeg(64, 48);
    expect(base[2] === 0xff && base[3] === 0xe0).toBe(false);
    const thumb = Buffer.from([0, 0, 0, 0, 0, 0, 255, 0, 255, 9, 9, 9]);
    const app0 = Buffer.alloc(18 + thumb.length);
    app0[0] = 0xff;
    app0[1] = 0xe0;
    app0.writeUInt16BE(16 + thumb.length, 2);
    app0.write('JFIF\u0000', 4, 'latin1');
    app0[9] = 1;
    app0[10] = 2;
    app0[11] = 1; // dots per inch
    app0.writeUInt16BE(300, 12);
    app0.writeUInt16BE(300, 14);
    app0[16] = 2;
    app0[17] = 2;
    thumb.copy(app0, 18);
    const data = Buffer.concat([base.subarray(0, 2), app0, base.subarray(2)]);
    const withExif = insertJpegSegments(data, [exifSegment({ make: 'JfifCam' })]);
    expect(withExif.readUInt16BE(4)).toBe(16 + thumb.length); // APP0 first, EXIF after it
    expect((await sharp(withExif).metadata()).density).toBe(300);
    const path = await writeFixture(dir, 'jfif.jpg', withExif);
    const result = await runToolJob('tool.metadata', await inputFor(path), { mode: 'strip' });
    const out = await readFile(result.outputs[0]!.path);
    // APP0 kept (density) but 18 bytes long with a 0×0 thumbnail
    expect(out[2] === 0xff && out[3] === 0xe0).toBe(true);
    expect(out.readUInt16BE(4)).toBe(16);
    expect([out[18], out[19]]).toEqual([0, 0]);
    expect(out[20] === 0xff).toBe(true); // next marker follows immediately
    expect((await sharp(out).metadata()).density).toBe(300);
    expect(jpegScanData(out).equals(jpegScanData(withExif))).toBe(true);
    expect(containsText(out, 'JfifCam')).toBe(false);
    expect(meanAbsDiff(await readRgba(out), await readRgba(withExif))).toBe(0);

    // unit: an 18-byte segment without thumbnail is returned as is; truncated segments are dropped
    const plain = Buffer.from(out.subarray(2, 20));
    expect(jfifWithoutThumbnail(plain)).toBe(plain);
    expect(jfifWithoutThumbnail(app0)!.length).toBe(18);
    expect(jfifWithoutThumbnail(app0.subarray(0, 12))).toBeNull();
  });

  it('handles progressive JPEGs (several scans) losslessly', async () => {
    const progressive = await sharp(await quadrantJpeg(320, 160)).jpeg({ quality: 90, progressive: true }).toBuffer();
    const sosCount = (buf: Buffer): number => {
      let n = 0;
      for (let i = 0; i + 1 < buf.length; i += 1) if (buf[i] === 0xff && buf[i + 1] === 0xda) n += 1;
      return n;
    };
    expect(sosCount(progressive)).toBeGreaterThan(1);
    const data = insertJpegSegments(progressive, [exifSegment({ make: 'Prog', gps: { lat: 1, lon: 1 } }), xmpSegment()]);
    const path = await writeFixture(dir, 'prog.jpg', data);
    const out = await readFile((await runToolJob('tool.metadata', await inputFor(path), { mode: 'strip' })).outputs[0]!.path);
    expect(jpegScanData(out).equals(jpegScanData(data))).toBe(true);
    expect(containsText(out, 'Prog')).toBe(false);
    expect(meanAbsDiff(await readRgba(out), await readRgba(data))).toBe(0);
  });

  it('keeps the visual orientation: orientation ≠ 1 rotates the pixels (re-encode path)', async () => {
    const path = await writeFixture(dir, 'rot.jpg', await richJpeg({ orientation: 6 }));
    const result = await runToolJob('tool.metadata', await inputFor(path), { mode: 'strip' });
    const stripped = await readFile(result.outputs[0]!.path);
    const meta = await sharp(stripped).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([160, 320]);
    expect(containsText(stripped, 'TestMaker')).toBe(false);
    expect(containsText(stripped, 'Secret Author')).toBe(false);
    // oriented quadrants: TL blue, TR red, BL yellow, BR green (as displayed before)
    const img = await readRgba(stripped);
    expect(near(px(img, 40, 80), BLUE, 30)).toBe(true);
    expect(near(px(img, 120, 80), RED, 30)).toBe(true);
    expect(near(px(img, 40, 240), YELLOW, 30)).toBe(true);
    expect(near(px(img, 120, 240), GREEN, 30)).toBe(true);
  });

  it('ICC policy: convertToSrgb converts P3 pixels and drops the profile; keep preserves it losslessly', async () => {
    const data = await richJpeg({ p3: true });
    const path = await writeFixture(dir, 'p3.jpg', data);
    const input = await inputFor(path);

    const converted = await readFile((await runToolJob('tool.metadata', input, { mode: 'strip', iccPolicy: 'convertToSrgb' })).outputs[0]!.path);
    const cm = await sharp(converted).metadata();
    expect(cm.icc).toBeUndefined();
    expect(cm.exif).toBeUndefined();
    // displayed colour is preserved: the P3-tagged red quadrant decodes to sRGB red
    const cimg = await readRgba(converted);
    expect(near(px(cimg, 80, 40), RED, 12)).toBe(true);
    // stored values were converted (they differ from the original stored P3 values)
    const storedOriginal = await sharp(data, { ignoreIcc: true }).raw().toBuffer();
    const storedConverted = await sharp(converted, { ignoreIcc: true }).raw().toBuffer();
    expect(Math.abs(storedOriginal[(40 * 320 + 80) * 3 + 1]! - storedConverted[(40 * 320 + 80) * 3 + 1]!)).toBeGreaterThan(20);

    const kept = await readFile((await runToolJob('tool.metadata', input, { mode: 'strip', iccPolicy: 'keep' })).outputs[0]!.path);
    const km = await sharp(kept).metadata();
    expect(km.icc).toBeDefined();
    expect(iccDescription(km.icc)).toMatch(/P3/);
    expect(km.exif).toBeUndefined();
    expect(km.xmp).toBeUndefined();
    expect(jpegScanData(kept).equals(jpegScanData(data))).toBe(true);
  });

  it('drops an sRGB profile losslessly under convertToSrgb (no conversion needed)', async () => {
    const base = await sharp(await quadrantJpeg(64, 64)).withIccProfile('srgb').jpeg({ quality: 90 }).toBuffer();
    const desc = iccDescription((await sharp(base).metadata()).icc);
    expect(isSrgbProfile(desc)).toBe(true);
    const data = insertJpegSegments(base, [exifSegment({ make: 'X' })]);
    const path = await writeFixture(dir, 's.jpg', data);
    const out = await readFile((await runToolJob('tool.metadata', await inputFor(path), { mode: 'strip' })).outputs[0]!.path);
    expect((await sharp(out).metadata()).icc).toBeUndefined();
    expect(jpegScanData(out).equals(jpegScanData(data))).toBe(true);
  });

  it('CMYK JPEG: keep preserves the CMYK profile losslessly; convertToSrgb re-encodes to RGB', async () => {
    const cmyk = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#E03C28' } }).withIccProfile('cmyk').jpeg({ quality: 95 }).toBuffer();
    const cm = await sharp(cmyk).metadata();
    expect(cm.space).toBe('cmyk');
    expect(cm.icc).toBeDefined();
    const data = insertJpegSegments(cmyk, [exifSegment({ make: 'Printer' })]);
    const path = await writeFixture(dir, 'print.jpg', data);
    const input = await inputFor(path);
    const shown = px(await readRgba(data), 30, 20);

    const kept = await readFile((await runToolJob('tool.metadata', input, { mode: 'strip', iccPolicy: 'keep' })).outputs[0]!.path);
    const km = await sharp(kept).metadata();
    expect(km.space).toBe('cmyk');
    expect(km.icc!.equals(cm.icc!)).toBe(true);
    expect(km.exif).toBeUndefined();
    expect(jpegScanData(kept).equals(jpegScanData(data))).toBe(true);
    expect(near(px(await readRgba(kept), 30, 20), shown, 0)).toBe(true);

    const converted = await readFile((await runToolJob('tool.metadata', input, { mode: 'strip' })).outputs[0]!.path);
    const vm = await sharp(converted).metadata();
    expect(vm.space).toBe('srgb');
    expect(vm.icc).toBeUndefined();
    expect(near(px(await readRgba(converted), 30, 20), shown, 8)).toBe(true);
  });

  it('PNG: removes text/XMP/eXIf/time chunks and keeps the image data byte for byte', async () => {
    const rgba = await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 0.8 } } }).png().toBuffer();
    const data = insertPngChunks(rgba, [
      pngChunk('tEXt', Buffer.from('Comment\u0000secret png comment', 'latin1')),
      pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\u0000\u0000\u0000\u0000\u0000', 'latin1'), Buffer.from(XMP_PACKET)])),
      pngChunk('eXIf', buildTiffExif({ make: 'PngCam', gps: { lat: 1, lon: 2 } })),
      pngChunk('tIME', Buffer.from([0x07, 0xe8, 1, 2, 3, 4, 5])),
    ]);
    const path = await writeFixture(dir, 'shot.png', data);
    expect((await sharp(path).metadata()).exif).toBeDefined();
    const out = await readFile((await runToolJob('tool.metadata', await inputFor(path), { mode: 'strip' })).outputs[0]!.path);
    expect(pngChunkTypes(out)).toEqual(pngChunkTypes(rgba));
    expect(pngChunkData(out, 'IDAT').equals(pngChunkData(data, 'IDAT'))).toBe(true);
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(containsText(out, 'secret png comment')).toBe(false);
  });

  it('WebP: removes EXIF and XMP chunks and clears the VP8X flags', async () => {
    const data = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#123456' } })
      .webp({ quality: 80 })
      .withExif({ IFD0: { Make: 'WebpCam' } })
      .withXmp(XMP_PACKET)
      .toBuffer();
    expect(riffChunkTypes(data)).toEqual(expect.arrayContaining(['VP8X', 'EXIF', 'XMP ']));
    const path = await writeFixture(dir, 'w.webp', data);
    const out = await readFile((await runToolJob('tool.metadata', await inputFor(path), { mode: 'strip' })).outputs[0]!.path);
    expect(riffChunkTypes(out)).not.toContain('EXIF');
    expect(riffChunkTypes(out)).not.toContain('XMP ');
    expect(riffChunk(out, 'VP8X')![0]! & 0x0c).toBe(0);
    expect(riffChunk(out, 'VP8 ')!.equals(riffChunk(data, 'VP8 ')!)).toBe(true);
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([40, 30]);
  });

  it('GIF: removes comment extensions and keeps the image', async () => {
    const gif = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#00FF00' } }).gif().toBuffer();
    const packed = gif[10]!;
    const at = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
    const comment = Buffer.concat([Buffer.from([0x21, 0xfe, 14]), Buffer.from('secret comment', 'latin1'), Buffer.from([0])]);
    const data = Buffer.concat([gif.subarray(0, at), comment, gif.subarray(at)]);
    const path = await writeFixture(dir, 'g.gif', data);
    const result = await runToolJob('tool.metadata', await inputFor(path), { mode: 'strip' });
    const out = await readFile(result.outputs[0]!.path);
    expect(result.outputs[0]!.path.endsWith('g No Metadata.gif')).toBe(true);
    expect(containsText(out, 'secret comment')).toBe(false);
    expect(out.length).toBe(gif.length);
    expect(near(px(await readRgba(out), 5, 5), GREEN, 0)).toBe(true);
  });

  it('can convert while stripping (outputFormat png)', async () => {
    const path = await writeFixture(dir, 'c.jpg', await richJpeg());
    const result = await runToolJob('tool.metadata', await inputFor(path), { mode: 'strip', outputFormat: 'png' });
    expect(result.outputs[0]!.path.endsWith('c No Metadata.png')).toBe(true);
    const meta = await sharp(result.outputs[0]!.path).metadata();
    expect(meta.format).toBe('png');
    expect(meta.exif).toBeUndefined();
  });

  it('lossless filters refuse malformed input instead of guessing', () => {
    expect(stripJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]), { keepIcc: false })).toBeNull();
    expect(stripPng(Buffer.from('not a png'), { keepIcc: false })).toBeNull();
    expect(stripWebp(Buffer.from('RIFF0000WEBPxxxx'), { keepIcc: false })).toBeNull();
    expect(stripGif(Buffer.from('GIF89a'), { keepIcc: false })).toBeNull();
  });
});
