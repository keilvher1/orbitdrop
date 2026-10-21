import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrbitError } from '@orbitdrop/contracts';
import { runConvert } from '../src/convert';
import { exactBytes, iccDescription, jpegFrameInfo, layoutPage, orderInputs, stripJpegMetadata } from '../src/convert/images-to-pdf';
import { inputFor, listFiles, makeCtx, makeFixtureDir, makeJob, tempFilesIn, type FixtureDir } from './helpers/convert-fixtures';

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OrbitError);
  expect((error as OrbitError).code).toBe(code);
}

async function pageSizes(path: string): Promise<[number, number][]> {
  const doc = await PDFDocument.load(await readFile(path));
  return doc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return [Math.round(width * 100) / 100, Math.round(height * 100) / 100];
  });
}

describe('images → PDF (P1, merging)', () => {
  let fx: FixtureDir;

  beforeAll(async () => {
    fx = await makeFixtureDir(['landscape.png', 'portrait.png', 'photo.jpg', 'transparent.png', 'exif-orientation-6.jpg', 'photo-progressive.jpg', '사진 테스트 😀.jpg', 'Page 001.pdf', 'sample.webp']);
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('puts one image per page in the confirmed order, named after the first file', async () => {
    const [landscape, portrait, photo, transparent] = await Promise.all([
      fx.input('landscape.png', 'land'),
      fx.input('portrait.png', 'port'),
      fx.input('photo.jpg', 'photo'),
      fx.input('transparent.png', 'trans'),
    ]);
    const { ctx, progress } = makeCtx();
    const result = await runConvert(makeJob('convert.pdf', [landscape, portrait, photo, transparent], { order: ['photo', 'land', 'trans', 'port'] }), ctx);
    expect(result.outputs).toHaveLength(1);
    const out = result.outputs[0]!;
    expect(out).toMatchObject({ path: join(fx.dir, 'photo.pdf'), format: 'pdf', pages: 4 });
    // pageSize 'image': points = pixels × 72 / density (72 DPI when the file has none).
    expect(await pageSizes(out.path)).toEqual([
      [320, 240],
      [300, 200],
      [64, 48],
      [200, 300],
    ]);
    expect(progress.filter((p) => p.kind === 'determinate').map((p) => (p.kind === 'determinate' ? p.done : -1))).toEqual([0, 1, 2, 3, 4]);
    expect(await tempFilesIn(fx.dir)).toEqual([]);
  });

  it('embeds an upright baseline JPEG byte-for-byte (no re-encoding) but strips its EXIF', async () => {
    const original = await readFile(fx.path('photo.jpg'));
    const result = await runConvert(makeJob('convert.pdf', [await fx.input('photo.jpg')]), makeCtx().ctx);
    const pdf = await readFile(result.outputs[0]!.path);
    // The entropy-coded image data (from the SOS marker on) appears unchanged inside the PDF.
    const sos = original.indexOf(Buffer.from([0xff, 0xda]));
    expect(sos).toBeGreaterThan(0);
    expect(pdf.includes(original.subarray(sos))).toBe(true);
    expect(pdf.includes(Buffer.from('Fixture Camera'))).toBe(false);
    expect(result.warnings).toContainEqual({ code: 'METADATA_REMOVED', params: { kinds: 'exif' } });
    expect(result.outputs[0]!.path).toBe(join(fx.dir, 'photo (2).pdf'));
  });

  it('embeds small EXIF JPEGs whose stripped bytes live in Node\'s shared Buffer pool (pdf-lib reads .buffer)', async () => {
    // Regression: stripJpegMetadata → Buffer.concat (< 4 KiB is pooled, byteOffset ≠ 0) → pdf-lib "SOI not found in JPEG".
    const sub = await makeFixtureDir([]);
    try {
      const tiny = join(sub.dir, 'tiny.jpg');
      const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#cc6633' } }).withExif({ IFD0: { Make: 'Test' } }).jpeg().toBuffer();
      expect(jpeg.length).toBeLessThan(4096);
      await (await import('node:fs/promises')).writeFile(tiny, jpeg);
      const result = await runConvert(makeJob('convert.pdf', [await inputFor(tiny)]), makeCtx().ctx);
      expect(await pageSizes(result.outputs[0]!.path)).toEqual([[16, 16]]);
      const docx = await runConvert(makeJob('convert.docx', [await inputFor(tiny)]), makeCtx().ctx);
      expect(docx.outputs[0]!.format).toBe('docx');
    } finally {
      await sub.cleanup();
    }
  });

  it('re-encodes EXIF-rotated JPEGs upright (30×60 page) and progressive JPEGs as baseline', async () => {
    const rotated = await runConvert(makeJob('convert.pdf', [await fx.input('exif-orientation-6.jpg')]), makeCtx().ctx);
    expect(await pageSizes(rotated.outputs[0]!.path)).toEqual([[30, 60]]);
    const progressive = await runConvert(makeJob('convert.pdf', [await fx.input('photo-progressive.jpg')]), makeCtx().ctx);
    expect(await pageSizes(progressive.outputs[0]!.path)).toEqual([[200, 120]]);
    // Rendering the PDF back shows the rotated image upright: red on top, blue at the bottom.
    const png = await runConvert(makeJob('convert.png', [await inputFor(rotated.outputs[0]!.path)], { dpi: 150 }), makeCtx().ctx);
    const { data, info } = await sharp(png.outputs[0]!.path).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    expect(at(Math.floor(info.width / 2), 5)[0]).toBeGreaterThan(200);
    expect(at(Math.floor(info.width / 2), info.height - 5)[2]).toBeGreaterThan(200);
  });

  it('fits images into A4/Letter with margins, turning the page for landscape images, and keeps transparency', async () => {
    const a4 = await runConvert(makeJob('convert.pdf', [await fx.input('landscape.png')], { pageSize: 'a4', marginPt: 36 }), makeCtx().ctx);
    expect(await pageSizes(a4.outputs[0]!.path)).toEqual([[841.89, 595.28]]);
    const letter = await runConvert(makeJob('convert.pdf', [await fx.input('portrait.png'), await fx.input('transparent.png')], { pageSize: 'letter' }), makeCtx().ctx);
    expect(await pageSizes(letter.outputs[0]!.path)).toEqual([
      [612, 792],
      [792, 612],
    ]);

    // Render the A4 page back (72 DPI): the image sits centred at its natural size, margins are white.
    const rendered = await runConvert(makeJob('convert.png', [await inputFor(a4.outputs[0]!.path)], {}, { settings: { pdfDpi: 150 } }), makeCtx().ctx);
    const meta = await sharp(rendered.outputs[0]!.path).metadata();
    expect([meta.width, meta.height]).toEqual([1754, 1240]);
    const { data, info } = await sharp(rendered.outputs[0]!.path).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    expect(at(877, 620)).toEqual([0x11, 0x55, 0xaa].map((v) => expect.closeTo(v, -1)) as unknown as number[]);
    expect(Math.min(...at(20, 20))).toBeGreaterThan(245);
    // 300×200 pt image at 150 DPI = 625×417 px, centred.
    expect(Math.min(...at(877 - 330, 620))).toBeGreaterThan(245);
    expect(at(877 - 300, 620)[2]).toBeGreaterThan(150);

    // Transparent PNG on the Letter page: the transparent half shows the white page.
    const second = await runConvert(makeJob('convert.png', [await inputFor(letter.outputs[0]!.path)], { dpi: 150 }), makeCtx().ctx);
    const page2 = second.outputs[1]!;
    const p2 = await sharp(page2.path).raw().toBuffer({ resolveWithObject: true });
    const cx = Math.floor(p2.info.width / 2);
    const cy = Math.floor(p2.info.height / 2);
    const px = (x: number, y: number) => [...p2.data.subarray((y * p2.info.width + x) * p2.info.channels, (y * p2.info.width + x) * p2.info.channels + 3)];
    expect(Math.min(...px(cx - 30, cy))).toBeGreaterThan(245); // transparent left half → white
    expect(px(cx + 30, cy)[1]).toBeGreaterThan(150); // opaque green right half
  });

  it('names the PDF after the first file in order (Korean/emoji names kept)', async () => {
    const [korean, webp] = await Promise.all([fx.input('사진 테스트 😀.jpg', 'k'), fx.input('sample.webp', 'w')]);
    const result = await runConvert(makeJob('convert.pdf', [webp, korean], { order: ['k', 'w'] }), makeCtx().ctx);
    expect(result.outputs[0]!.path).toBe(join(fx.dir, '사진 테스트 😀.pdf'));
    expect(await pageSizes(result.outputs[0]!.path)).toEqual([
      [48, 32],
      [64, 48],
    ]);
  });

  it('rejects an order that does not list every file exactly once, and non-image inputs', async () => {
    const [a, b] = await Promise.all([fx.input('landscape.png', 'a'), fx.input('portrait.png', 'b')]);
    for (const order of [['a'], ['a', 'a'], ['a', 'c'], ['a', 'b', 'b']]) {
      await rejectsWith(runConvert(makeJob('convert.pdf', [a, b], { order }), makeCtx().ctx), 'INVALID_OPTIONS');
    }
    await rejectsWith(runConvert(makeJob('convert.pdf', [a, await fx.input('Page 001.pdf', 'p')]), makeCtx().ctx), 'UNSUPPORTED_FORMAT');
  });

  it('cancels without writing a PDF', async () => {
    const before = await listFiles(fx.dir);
    const { ctx } = makeCtx((p, controller) => {
      if (p.kind === 'determinate' && p.done === 1) controller.abort();
    });
    await rejectsWith(runConvert(makeJob('convert.pdf', [await fx.input('landscape.png', 'x'), await fx.input('portrait.png', 'y')]), ctx), 'CANCELLED');
    expect(await listFiles(fx.dir)).toEqual(before);
  });
});

interface EmbeddedImage {
  readonly filter: string | undefined;
  readonly width: number;
  readonly height: number;
  readonly contents: Buffer;
}

/** Image XObjects of every page, read back from the PDF with pdf-lib. */
async function embeddedImages(path: string): Promise<EmbeddedImage[][]> {
  const doc = await PDFDocument.load(await readFile(path));
  return doc.getPages().map((page) => {
    const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    const images: EmbeddedImage[] = [];
    for (const [, ref] of xobjects?.entries() ?? []) {
      const obj = doc.context.lookup(ref);
      if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
      images.push({
        filter: obj.dict.get(PDFName.of('Filter'))?.toString(),
        width: (obj.dict.get(PDFName.of('Width')) as PDFNumber).asNumber(),
        height: (obj.dict.get(PDFName.of('Height')) as PDFNumber).asNumber(),
        contents: Buffer.from(obj.contents),
      });
    }
    return images;
  });
}

describe('images → PDF with real JPEG variants (regression: "SOI not found in JPEG")', () => {
  /**
   * Root cause, measured in an Electron 44 utilityProcess: Buffer.poolSize is 64 KiB there (8 KiB in
   * Node), so Buffers under 32 KiB made by Buffer.concat/allocUnsafe — e.g. a JPEG whose EXIF was
   * stripped — are views into a shared pool with byteOffset ≠ 0, and pdf-lib parses JPEGs with
   * `new DataView(bytes.buffer)`, ignoring byteOffset. The worker now hands pdf-lib exact copies.
   * This test runs with the same 64 KiB pool.
   */
  it('embeds 1600×1200 + 1200×900 sharp JPEGs, progressive, CMYK, EXIF-rotated and EXIF-tagged JPEGs; the PDF re-reads with the right pages and decodable images', async () => {
    const savedPool = Buffer.poolSize;
    const fx = await makeFixtureDir([]);
    try {
      Buffer.poolSize = 64 * 1024;
      Buffer.allocUnsafe(20_000); // start a 64 KiB pool so later small Buffers sit at an offset
      const half = (w: number, h: number) => {
        const raw = Buffer.alloc(w * h * 3);
        for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) raw.set(x < w / 2 ? [220, 30, 30] : [30, 30, 220], (y * w + x) * 3);
        return sharp(raw, { raw: { width: w, height: h, channels: 3 } });
      };
      const files: [string, Buffer][] = [
        ['plain-1600.jpg', await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#cc6633' } }).jpeg().toBuffer()],
        ['plain-1200.jpg', await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#3366cc' } }).jpeg().toBuffer()],
        ['progressive.jpg', await sharp({ create: { width: 800, height: 600, channels: 3, background: '#22aa55' } }).jpeg({ progressive: true }).toBuffer()],
        ['cmyk.jpg', await sharp({ create: { width: 640, height: 480, channels: 3, background: '#228844' } }).toColourspace('cmyk').jpeg().toBuffer()],
        ['rotated.jpg', await half(640, 480).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer()],
        ['exif-tagged.jpg', await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#cc6633' } }).withExif({ IFD0: { Make: 'Camera', Model: 'Regression' } }).jpeg().toBuffer()],
      ];
      expect(jpegFrameInfo(files[2]![1])?.marker).toBe(0xc2);
      expect(jpegFrameInfo(files[3]![1])?.components).toBe(4);
      expect(files[5]![1].length).toBeLessThan(32 * 1024); // small enough for the pool once stripped
      const inputs = [];
      for (const [i, [name, data]] of files.entries()) {
        await (await import('node:fs/promises')).writeFile(fx.path(name), data);
        inputs.push(await inputFor(fx.path(name), `img${i}`));
      }

      const result = await runConvert(makeJob('convert.pdf', inputs, { order: inputs.map((i) => i.fileId) }), makeCtx().ctx);
      const out = result.outputs[0]!;
      expect(out).toMatchObject({ path: fx.path('plain-1600.pdf'), format: 'pdf', pages: 6 });
      expect(await pageSizes(out.path)).toEqual([
        [1600, 1200],
        [1200, 900],
        [800, 600],
        [640, 480],
        [480, 640],
        [1600, 1200],
      ]);

      const images = await embeddedImages(out.path);
      expect(images.map((p) => p.length)).toEqual([1, 1, 1, 1, 1, 1]);
      const expected = [
        [1600, 1200],
        [1200, 900],
        [800, 600],
        [640, 480],
        [480, 640],
        [1600, 1200],
      ];
      for (const [i, [image]] of images.entries()) {
        expect(image!.filter, `page ${i + 1}`).toBe('/DCTDecode');
        expect([image!.width, image!.height]).toEqual(expected[i]);
        const meta = await sharp(image!.contents).metadata(); // the embedded stream is a JPEG that decodes
        expect([meta.format, meta.width, meta.height, meta.channels]).toEqual(['jpeg', ...expected[i]!, 3]);
      }
      // Plain baseline JPEGs are embedded byte for byte; the EXIF one only loses its APP1 segment.
      expect(images[0]![0]!.contents.equals(files[0]![1])).toBe(true);
      expect(images[1]![0]!.contents.equals(files[1]![1])).toBe(true);
      expect(images[5]![0]!.contents.includes(Buffer.from('Regression'))).toBe(false);
      expect((await sharp(images[5]![0]!.contents).raw().toBuffer()).equals(await sharp(files[5]![1]).raw().toBuffer())).toBe(true);
      expect(result.warnings).toContainEqual({ code: 'METADATA_REMOVED', params: { kinds: 'exif' } });

      // Rendered back by the engine: colours survive (CMYK converted to sRGB), the rotated page is upright.
      Buffer.poolSize = savedPool;
      const rendered = await runConvert(makeJob('convert.png', [await inputFor(out.path)], {}, { settings: { pdfDpi: 150 } }), makeCtx().ctx);
      const centre = async (path: string, fx_ = 0.5, fy = 0.5) => {
        const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
        const o = (Math.floor(info.height * fy) * info.width + Math.floor(info.width * fx_)) * info.channels;
        return [data[o]!, data[o + 1]!, data[o + 2]!];
      };
      const near = (got: number[], want: number[], tolerance: number) => got.forEach((v, c) => expect(Math.abs(v - want[c]!), `channel ${c}: ${got} vs ${want}`).toBeLessThanOrEqual(tolerance));
      near(await centre(rendered.outputs[0]!.path), [0xcc, 0x66, 0x33], 6);
      near(await centre(rendered.outputs[1]!.path), [0x33, 0x66, 0xcc], 6);
      near(await centre(rendered.outputs[2]!.path), [0x22, 0xaa, 0x55], 6);
      near(await centre(rendered.outputs[3]!.path), [0x22, 0x88, 0x44], 30);
      near(await centre(rendered.outputs[4]!.path, 0.5, 0.1), [220, 30, 30], 20);
      near(await centre(rendered.outputs[4]!.path, 0.5, 0.9), [30, 30, 220], 20);
    } finally {
      Buffer.poolSize = savedPool;
      await fx.cleanup();
    }
  });

  it('pdf-lib really ignores byteOffset (why exactBytes exists)', async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    // A Buffer that is a view at offset 100 into a larger ArrayBuffer (like a pooled Buffer).
    const backing = new ArrayBuffer(100 + jpeg.length);
    new Uint8Array(backing).fill(0xaa, 0, 100);
    new Uint8Array(backing).set(jpeg, 100);
    const view = Buffer.from(backing, 100, jpeg.length);
    expect(view.equals(jpeg)).toBe(true);
    const doc = await PDFDocument.create();
    await expect(doc.embedJpg(view)).rejects.toThrow(/SOI not found/);
    const copy = exactBytes(view);
    expect([copy.byteOffset, copy.buffer.byteLength]).toEqual([0, jpeg.length]);
    await expect(doc.embedJpg(copy)).resolves.toBeTruthy();
    expect(exactBytes(jpeg)).toBe(jpeg); // already exact: no copy
  });
});

describe('images → PDF helpers', () => {
  it('orderInputs keeps the job order without options.order', () => {
    const inputs = ['a', 'b'].map((fileId) => ({ fileId, path: `/${fileId}`, displayName: fileId, sourceDir: '/', format: 'png' as const, bytes: 1 }));
    expect(orderInputs(inputs, undefined).map((i) => i.fileId)).toEqual(['a', 'b']);
    expect(orderInputs(inputs, ['b', 'a']).map((i) => i.fileId)).toEqual(['b', 'a']);
  });

  it('layoutPage: physical size for "image", centred fit (never enlarged) for A4/Letter', () => {
    expect(layoutPage(144, 72, 144, 'image', 0)).toEqual({ pageWidth: 72, pageHeight: 36, x: 0, y: 0, width: 72, height: 36 });
    expect(layoutPage(100, 100, 72, 'image', 10)).toMatchObject({ pageWidth: 120, pageHeight: 120, x: 10, y: 10 });
    const big = layoutPage(6000, 3000, 72, 'a4', 36);
    expect(big.pageWidth).toBeCloseTo(841.89);
    expect(big.width).toBeCloseTo(841.89 - 72);
    expect(big.x).toBeCloseTo(36);
    const small = layoutPage(100, 50, 72, 'letter', 0);
    expect(small).toMatchObject({ pageWidth: 792, pageHeight: 612, width: 100, height: 50 });
    const huge = layoutPage(30_000, 100, 1, 'image', 0);
    expect(huge.pageWidth).toBeLessThanOrEqual(14_400);
  });

  it('jpegFrameInfo, stripJpegMetadata and iccDescription read real files', async () => {
    const fx = await makeFixtureDir(['photo.jpg', 'photo-progressive.jpg']);
    try {
      const baseline = await readFile(fx.path('photo.jpg'));
      expect(jpegFrameInfo(baseline)).toEqual({ marker: 0xc0, precision: 8, components: 3 });
      expect(jpegFrameInfo(await readFile(fx.path('photo-progressive.jpg')))?.marker).toBe(0xc2);
      const stripped = stripJpegMetadata(baseline);
      expect(stripped.removed).toEqual(['exif']);
      expect(stripped.data.length).toBeLessThan(baseline.length);
      const a = await sharp(baseline).raw().toBuffer();
      const b = await sharp(stripped.data).raw().toBuffer();
      expect(a.equals(b)).toBe(true);
      expect((await sharp(stripped.data).metadata()).exif).toBeUndefined();
      const p3 = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } }).withIccProfile('p3').jpeg().toBuffer();
      expect(iccDescription((await sharp(p3).metadata()).icc!)).toMatch(/P3/);
      const srgb = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } }).withIccProfile('srgb').jpeg().toBuffer();
      expect(iccDescription((await sharp(srgb).metadata()).icc!)).toMatch(/sRGB/i);
    } finally {
      await fx.cleanup();
    }
  });
});
