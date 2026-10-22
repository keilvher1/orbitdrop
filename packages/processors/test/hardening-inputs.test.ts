import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_LIMITS, type ActionId, type JobWarning } from '@orbitdrop/contracts';
import { inspectImage } from '../src';
import { staticFixture } from './helpers/convert-fixtures';
import { errorCode, inputOf, maxDiff, meanDiff, preview, renderPdfRgb, rgbOf, run } from './helpers/hardening';

/**
 * Inputs the happy-path tests do not cover (hardening pass): animated and multi-page images,
 * damaged and empty files, JPEG coding variants, dimension bombs, and output folders that do
 * not accept files. Every case goes through runJob/renderPreview/inspectImage.
 */

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

function pngChunks(png: Buffer): { type: string; data: Buffer }[] {
  const out: { type: string; data: Buffer }[] = [];
  for (let pos = 8; pos + 12 <= png.length; ) {
    const length = png.readUInt32BE(pos);
    out.push({ type: png.toString('latin1', pos + 4, pos + 8), data: png.subarray(pos + 8, pos + 8 + length) });
    pos += 12 + length;
  }
  return out;
}

/** A two-frame APNG (red, then green) built from two sharp PNGs of the same size. */
async function apng(width: number, height: number): Promise<Buffer> {
  const frame = (colour: string) => sharp({ create: { width, height, channels: 3, background: colour } }).png({ compressionLevel: 0 }).toBuffer();
  const [a, b] = [pngChunks(await frame('#ff0000')), pngChunks(await frame('#00ff00'))];
  const ihdr = a.find((c) => c.type === 'IHDR')!.data;
  const fctl = (seq: number) => {
    const d = Buffer.alloc(26);
    d.writeUInt32BE(seq, 0);
    d.writeUInt32BE(width, 4);
    d.writeUInt32BE(height, 8);
    d.writeUInt16BE(1, 20); // delay 1/10 s
    d.writeUInt16BE(10, 22);
    return chunk('fcTL', d);
  };
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);
  const idatA = Buffer.concat(a.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const idatB = Buffer.concat(b.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const seq2 = Buffer.alloc(4);
  seq2.writeUInt32BE(2);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('acTL', actl),
    fctl(0),
    chunk('IDAT', idatA),
    fctl(1),
    chunk('fdAT', Buffer.concat([seq2, idatB])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 3 frames (or pages) of 20×10: red, green, blue. */
function threeFrames(): Buffer {
  const data = Buffer.alloc(20 * 30 * 4);
  for (let f = 0; f < 3; f += 1) for (let i = 0; i < 200; i += 1) data.set([f === 0 ? 255 : 0, f === 1 ? 255 : 0, f === 2 ? 255 : 0, 255], (f * 200 + i) * 4);
  return data;
}

const codes = (warnings: readonly JobWarning[]) => warnings.map((w) => w.code);

describe('inputs beyond the happy path (hardening)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-hard-inputs-'));
  });
  afterAll(async () => {
    await chmod(join(dir, 'ro'), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('animated GIF/WebP/APNG and multi-page TIFF: the first frame/page is used and the job says so', async () => {
    const raw = { raw: { width: 20, height: 30, channels: 4 as const, pageHeight: 10 } };
    const files = {
      'anim.gif': await sharp(threeFrames(), raw).gif({ loop: 0, delay: [100, 100, 100] }).toBuffer(),
      'anim.webp': await sharp(threeFrames(), raw).webp({ loop: 0, delay: [100, 100, 100], lossless: true }).toBuffer(),
      'pages.tiff': await sharp(threeFrames(), raw).tiff().toBuffer(),
      'anim.png': await apng(20, 10),
    };
    const expected: Record<string, { code: string; params: Record<string, number> }> = {
      'anim.gif': { code: 'FIRST_FRAME_ONLY', params: { frames: 3, files: 1 } },
      'anim.webp': { code: 'FIRST_FRAME_ONLY', params: { frames: 3, files: 1 } },
      'pages.tiff': { code: 'FIRST_PAGE_ONLY', params: { pages: 3, files: 1 } },
      'anim.png': { code: 'FIRST_FRAME_ONLY', params: { frames: 2, files: 1 } },
    };
    for (const [name, data] of Object.entries(files)) {
      const path = join(dir, name);
      await writeFile(path, data);
      const format = name.endsWith('.gif') ? 'gif' : name.endsWith('.webp') ? 'webp' : name.endsWith('.tiff') ? 'tiff' : 'png';
      const input = await inputOf(path, format);
      const jobs: [ActionId, unknown][] = [
        [format === 'png' ? 'convert.jpeg' : 'convert.png', {}],
        ['convert.docx', {}],
        ['tool.crop', { rect: { x: 0, y: 0, width: 20, height: 10 }, outputFormat: 'png' }],
        ['tool.compress', {}],
        ['tool.edit', { rotate: 90 }],
        ['tool.redact', { regions: [{ id: 'r', rect: { x: 0, y: 0, width: 2, height: 2 }, style: 'solid' }] }],
        ['tool.annotate', { shapes: [{ id: 'a', type: 'rect', x: 1, y: 1, width: 5, height: 5, color: '#000000', strokeWidth: 1 }] }],
        ['tool.addBackground', { background: { kind: 'solid', color: '#FFFFFF' }, padding: 4, cornerRadius: 0, shadow: 0, ratio: 'auto', maxEdge: 2400, format: 'png', quality: 90 }],
      ];
      for (const [actionId, options] of jobs) {
        const result = await run(actionId, [input], options, { outputDir: dir });
        expect(result.warnings, `${name} ${actionId}`).toContainEqual(expected[name]);
      }
      expect((await inspectImage(input, DEFAULT_PROCESSING_LIMITS)).pages, name).toBe(expected[name]!.params.frames ?? expected[name]!.params.pages);
      // The first frame really is what was converted (red).
      const first = await run(format === 'png' ? 'convert.jpeg' : 'convert.png', [input], {}, { outputDir: dir });
      const px = await sharp(first.outputs[0]!.path).raw().toBuffer();
      expect([px[0]! > 200, px[1]! < 60, px[2]! < 60], name).toEqual([true, true, true]);
      expect((await sharp(first.outputs[0]!.path).metadata()).height, name).toBe(10);
    }
    // Merged PDF: one warning per kind, counting the affected files.
    const gif = await inputOf(join(dir, 'anim.gif'), 'gif');
    const webp = await inputOf(join(dir, 'anim.webp'), 'webp');
    const tiff = await inputOf(join(dir, 'pages.tiff'), 'tiff');
    const merged = await run('convert.pdf', [gif, webp, tiff], {}, { outputDir: dir });
    expect(merged.warnings).toContainEqual({ code: 'FIRST_FRAME_ONLY', params: { frames: 3, files: 2 } });
    expect(merged.warnings).toContainEqual({ code: 'FIRST_PAGE_ONLY', params: { pages: 3, files: 1 } });
    expect((await PDFDocument.load(await readFile(merged.outputs[0]!.path))).getPageCount()).toBe(3);
    // Metadata: the lossless path keeps every frame (no warning); re-encoding a TIFF keeps one page and says so.
    const strippedGif = await run('tool.metadata', [gif], { mode: 'strip' }, { outputDir: dir });
    expect(codes(strippedGif.warnings)).not.toContain('FIRST_FRAME_ONLY');
    expect((await sharp(strippedGif.outputs[0]!.path, { animated: true }).metadata()).pages).toBe(3);
    const strippedTiff = await run('tool.metadata', [tiff], { mode: 'strip' }, { outputDir: dir });
    expect(strippedTiff.warnings).toContainEqual(expected['pages.tiff']);
    // A still image gets neither warning.
    const still = join(dir, 'still.png');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png().toFile(still);
    const plain = await run('convert.jpeg', [await inputOf(still, 'png')], {}, { outputDir: dir });
    expect(codes(plain.warnings)).toEqual([]);
  });

  it('an empty file is FILE_EMPTY (not INTERNAL / PDF_CORRUPT) for conversions, tools and previews', async () => {
    const jpg = join(dir, 'empty.jpg');
    const pdf = join(dir, 'empty.pdf');
    await writeFile(jpg, Buffer.alloc(0));
    await writeFile(pdf, Buffer.alloc(0));
    const image = await inputOf(jpg, 'jpeg');
    const document = await inputOf(pdf, 'pdf');
    expect(await errorCode(run('convert.png', [image], {}, { outputDir: dir }))).toBe('FILE_EMPTY');
    expect(await errorCode(run('convert.pdf', [image], {}, { outputDir: dir }))).toBe('FILE_EMPTY');
    expect(await errorCode(run('tool.crop', [image], { rect: { x: 0, y: 0, width: 1, height: 1 } }, { outputDir: dir }))).toBe('FILE_EMPTY');
    expect(await errorCode(preview('source', image, {}, 64))).toBe('FILE_EMPTY');
    expect(await errorCode(inspectImage(image, DEFAULT_PROCESSING_LIMITS))).toBe('FILE_EMPTY');
    for (const actionId of ['convert.jpeg', 'convert.txt', 'convert.docx'] as const) {
      expect(await errorCode(run(actionId, [document], {}, { outputDir: dir })), actionId).toBe('FILE_EMPTY');
    }
  });

  it('a file that grew past the size limit after validation is FILE_TOO_LARGE before it is read', async () => {
    const path = join(dir, 'grown.png');
    await sharp({ create: { width: 256, height: 256, channels: 3, background: '#123456' } }).png({ compressionLevel: 0 }).toFile(path);
    // Main validated it when it was 10 bytes; the limit is far below its real size now.
    const input = { ...(await inputOf(path, 'png')), bytes: 10 };
    const limits = { maxInputBytes: 4096 };
    expect(await errorCode(run('convert.jpeg', [input], {}, { outputDir: dir, limits }))).toBe('FILE_TOO_LARGE');
    expect(await errorCode(run('tool.crop', [input], { rect: { x: 0, y: 0, width: 4, height: 4 } }, { outputDir: dir, limits }))).toBe('FILE_TOO_LARGE');
    expect(await errorCode(preview('source', input, {}, 64, { limits }))).toBe('FILE_TOO_LARGE');
  });

  it('a truncated PNG is IMAGE_CORRUPT everywhere (libpng\'s read error was INTERNAL)', async () => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } }).png({ compressionLevel: 0 }).toBuffer();
    const path = join(dir, 'truncated.png');
    await writeFile(path, png.subarray(0, Math.floor(png.length / 2)));
    const input = await inputOf(path, 'png');
    for (const [actionId, options] of [
      ['convert.jpeg', {}],
      ['convert.pdf', {}],
      ['convert.docx', {}],
      ['tool.crop', { rect: { x: 0, y: 40, width: 8, height: 8 } }],
      ['tool.compress', {}],
      ['tool.redact', { regions: [{ id: 'r', rect: { x: 0, y: 0, width: 4, height: 4 }, style: 'solid' }] }],
    ] as const) {
      expect(await errorCode(run(actionId, [input], options, { outputDir: dir })), actionId).toBe('IMAGE_CORRUPT');
    }
    expect(await errorCode(preview('source', input, {}, 64))).toBe('IMAGE_CORRUPT');
  });

  it('images → PDF and image → DOCX refuse a truncated JPEG instead of embedding a broken picture', async () => {
    const noise = Buffer.alloc(64 * 48 * 3);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 2654435761) >>> 24;
    const jpeg = await sharp(noise, { raw: { width: 64, height: 48, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    const cases = {
      'cut-half.jpg': jpeg.subarray(0, Math.floor(jpeg.length / 2)),
      'no-eoi.jpg': jpeg.subarray(0, jpeg.length - 2),
    };
    const sub = join(dir, 'truncated-jpegs');
    await mkdir(sub);
    for (const [name, data] of Object.entries(cases)) {
      const path = join(sub, name);
      await writeFile(path, data);
      const input = await inputOf(path, 'jpeg');
      for (const actionId of ['convert.pdf', 'convert.docx', 'convert.png'] as const) {
        expect(await errorCode(run(actionId, [input], {}, { outputDir: sub })), `${name} ${actionId}`).toBe('IMAGE_CORRUPT');
      }
    }
    expect((await readdir(sub)).sort()).toEqual(['cut-half.jpg', 'no-eoi.jpg']);
    // The intact file still passes through byte for byte.
    const intact = join(sub, 'intact.jpg');
    await writeFile(intact, jpeg);
    const pdf = await run('convert.pdf', [await inputOf(intact, 'jpeg')], {}, { outputDir: sub });
    expect((await readFile(pdf.outputs[0]!.path)).includes(jpeg.subarray(200, 400))).toBe(true);
  });

  it('image → DOCX embeds a picture above 32 MB at 300 ppi of its page size instead of failing (docx hashes through a JS array)', async () => {
    // 3400×3400 random RGB: the PNG is ~35 MB (incompressible) — above the 32 MB the DOCX writer
    // is given; a 72 MB one used to fail with INTERNAL "Invalid array length".
    const side = 3400;
    const { randomBytes } = await import('node:crypto');
    const path = join(dir, 'big-noise.png');
    await sharp(randomBytes(side * side * 3), { raw: { width: side, height: side, channels: 3 } }).png({ compressionLevel: 1 }).toFile(path);
    const result = await run('convert.docx', [await inputOf(path, 'png')], {}, { outputDir: dir });
    expect(result.warnings).toContainEqual({ code: 'DOWNSCALED', params: { dpi: 300 } });
    const { readZip } = await import('./helpers/convert-fixtures');
    const zip = readZip(await readFile(result.outputs[0]!.path));
    const media = [...zip.entries()].find(([name, data]) => name.startsWith('word/media/') && data.length > 0)!;
    const meta = await sharp(media[1]).metadata();
    // Shown at the A4 text width (6.27 in, 602 CSS px): 300 ppi of that is 1881 pixels.
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 1881, 1881]);
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(zip.get('word/document.xml')!.toString('utf8'))!;
    expect(Number(extent[1])).toBe(602 * 9525);
  });

  it('arithmetic-coded and restart-marker JPEGs decode to the same pixels in every path', async () => {
    const sourcePath = staticFixture('jpeg-source.jpg');
    const arithmetic = staticFixture('jpeg-arithmetic.jpg');
    const restart = staticFixture('jpeg-restart.jpg');
    if (!sourcePath || !arithmetic || !restart) throw new Error('static JPEG fixtures missing (node tests/fixtures/static/make-static-fixtures.mjs jpegs)');
    const reference = await rgbOf(sourcePath);
    for (const path of [arithmetic, restart]) {
      const input = await inputOf(path, 'jpeg');
      const png = await run('convert.png', [input], {}, { outputDir: dir });
      expect(maxDiff(await rgbOf(png.outputs[0]!.path), reference), path).toBe(0);
      const crop = await run('tool.crop', [input], { rect: { x: 0, y: 0, width: 48, height: 32 }, outputFormat: 'png' }, { outputDir: dir });
      expect(maxDiff(await rgbOf(crop.outputs[0]!.path), reference), path).toBe(0);
      const pdf = await run('convert.pdf', [input], {}, { outputDir: dir });
      expect(meanDiff(await renderPdfRgb(pdf.outputs[0]!.path), reference), path).toBeLessThan(3);
    }
    // Lossless metadata removal keeps the restart markers and the entropy-coded data as they were.
    const stripped = await run('tool.metadata', [await inputOf(restart, 'jpeg')], { mode: 'strip' }, { outputDir: dir });
    const out = await readFile(stripped.outputs[0]!.path);
    const original = await readFile(restart);
    const sos = (b: Buffer) => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])));
    expect(sos(out).equals(sos(original))).toBe(true);
    expect(maxDiff(await rgbOf(out), reference)).toBe(0);
  });

  it('dimension bombs (headers claiming 60000×60000) fail fast with IMAGE_TOO_LARGE before decoding', async () => {
    const pngHeader = (w: number, h: number) => {
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(w, 0);
      ihdr.writeUInt32BE(h, 4);
      ihdr[8] = 8;
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(4 * (w + 1)).subarray(0, 4096))), chunk('IEND', Buffer.alloc(0))]);
    };
    const jpegHeader = async (w: number, h: number) => {
      const small = Buffer.from(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#808080' } }).jpeg().toBuffer());
      const sof = small.indexOf(Buffer.from([0xff, 0xc0]));
      small.writeUInt16BE(h, sof + 5);
      small.writeUInt16BE(w, sof + 7);
      return small;
    };
    const gifHeader = (w: number, h: number) => {
      const b = Buffer.alloc(28);
      b.write('GIF89a', 0, 'latin1');
      b.writeUInt16LE(w, 6);
      b.writeUInt16LE(h, 8);
      b[13] = 0x2c;
      b.writeUInt16LE(w, 18);
      b.writeUInt16LE(h, 20);
      b.set([2, 1, 0, 0, 0x3b], 23);
      return b;
    };
    const bmpHeader = (w: number, h: number) => {
      const b = Buffer.alloc(14 + 40 + 1024 + 2);
      b.write('BM', 0, 'latin1');
      b.writeUInt32LE(b.length, 2);
      b.writeUInt32LE(14 + 40 + 1024, 10);
      b.writeUInt32LE(40, 14);
      b.writeInt32LE(w, 18);
      b.writeInt32LE(h, 22);
      b.writeUInt16LE(1, 26);
      b.writeUInt16LE(8, 28);
      b.writeUInt32LE(1, 30); // RLE8
      b.set([0, 1], 14 + 40 + 1024); // end of bitmap
      return b;
    };
    const bombs: [string, 'png' | 'jpeg' | 'gif' | 'bmp', Buffer][] = [
      ['bomb.png', 'png', pngHeader(60000, 60000)],
      ['bomb.jpg', 'jpeg', await jpegHeader(60000, 60000)],
      ['bomb.gif', 'gif', gifHeader(65535, 65535)],
      ['bomb.bmp', 'bmp', bmpHeader(60000, 60000)],
    ];
    for (const [name, format, data] of bombs) {
      const path = join(dir, name);
      await writeFile(path, data);
      const input = await inputOf(path, format);
      const started = Date.now();
      for (const [actionId, options] of [
        [format === 'png' ? 'convert.jpeg' : 'convert.png', {}],
        ['convert.pdf', {}],
        ['convert.docx', {}],
        ['tool.crop', { rect: { x: 0, y: 0, width: 8, height: 8 } }],
        ['tool.addBackground', { background: { kind: 'solid', color: '#FFFFFF' }, padding: 0, cornerRadius: 0, shadow: 0, ratio: 'auto', maxEdge: 2400, format: 'png', quality: 90 }],
      ] as const) {
        expect(await errorCode(run(actionId, [input], options, { outputDir: dir })), `${name} ${actionId}`).toBe('IMAGE_TOO_LARGE');
      }
      expect(await errorCode(preview('source', input, {}, 256)), name).toBe('IMAGE_TOO_LARGE');
      expect(await errorCode(inspectImage(input, DEFAULT_PROCESSING_LIMITS)), name).toBe('IMAGE_TOO_LARGE');
      expect(Date.now() - started, name).toBeLessThan(5000);
    }
  });

  it.skipIf(process.platform === 'win32')('tools check the output folder first, like conversions: OUTPUT_DIR_NOT_WRITABLE before any decoding', async () => {
    const corrupt = join(dir, 'corrupt-for-ro.png');
    await writeFile(corrupt, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]));
    const input = await inputOf(corrupt, 'png');
    const ro = join(dir, 'ro');
    await mkdir(ro);
    await chmod(ro, 0o555);
    const missing = join(dir, 'does-not-exist');
    for (const [actionId, options] of [
      ['tool.crop', { rect: { x: 0, y: 0, width: 1, height: 1 } }],
      ['tool.compress', {}],
      ['tool.metadata', { mode: 'strip' }],
      ['tool.redact', { regions: [{ id: 'r', rect: { x: 0, y: 0, width: 1, height: 1 }, style: 'solid' }] }],
    ] as const) {
      // A corrupt input would be IMAGE_CORRUPT: the folder is reported first, without decoding.
      expect(await errorCode(run(actionId, [input], options, { outputDir: ro })), `${actionId} read-only`).toBe('OUTPUT_DIR_NOT_WRITABLE');
      expect(await errorCode(run(actionId, [input], options, { outputDir: missing })), `${actionId} missing`).toBe('OUTPUT_DIR_NOT_WRITABLE');
    }
    expect(await errorCode(run('convert.jpeg', [input], {}, { outputDir: missing }))).toBe('OUTPUT_DIR_NOT_WRITABLE');
    await chmod(ro, 0o755);
    expect(await readdir(ro)).toEqual([]);
  });
});
