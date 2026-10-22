import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers/convert-fixtures';
import { docxMedia, inputOf, run } from './helpers/hardening';

/**
 * Colour regressions found in the hardening pass (reference colours measured with macOS
 * ColorSync during the investigation; here the reference is the source picture itself, decoded
 * through sharp's 8-bit colour management, which agreed with ColorSync within 3 levels):
 *  - conversions of 16-bit input with an embedded profile (any profile, sRGB included — also
 *    what ImageIO decodes a 10-bit HEIC to) came out up to 57 levels off;
 *  - keepMetadata on a CMYK JPEG with an embedded profile converted with sharp's built-in CMYK
 *    profile instead of the embedded one (44–55 levels off) and tagged the result sRGB.
 */

const COLOURS: [number, number, number][] = [
  [230, 40, 40], [40, 200, 60], [30, 60, 220], [250, 220, 30],
  [128, 128, 128], [20, 20, 20], [240, 240, 240], [200, 100, 160],
];
const W = 32;
const H = 16;

function blocks(alpha = false): Buffer {
  const channels = alpha ? 4 : 3;
  const data = Buffer.alloc(W * H * channels);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const c = COLOURS[(x >> 3) + 4 * (y >> 3)]!;
      data.set(alpha ? [...c, 255] : c, (y * W + x) * channels);
    }
  }
  return data;
}

/** sRGB colour a colour-managed viewer shows at the centre of each 8×8 block. */
async function shown(input: string | Buffer | Uint8Array): Promise<[number, number, number][]> {
  const { data, info } = await sharp(input).withIccProfile('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out: [number, number, number][] = [];
  for (let by = 0; by < info.height / 8; by += 1) {
    for (let bx = 0; bx < info.width / 8; bx += 1) {
      const i = ((by * 8 + 4) * info.width + bx * 8 + 4) * info.channels;
      out.push([data[i]!, data[i + 1]!, data[i + 2]!]);
    }
  }
  return out;
}

function worst(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): number {
  let m = 0;
  a.forEach((px, i) => px.forEach((v, c) => (m = Math.max(m, Math.abs(v - b[i]![c]!)))));
  return m;
}

/** The first image XObject of page 1, decoded (DCTDecode → JPEG bytes, FlateDecode PNG → raw RGB). */
async function pdfImageColours(path: string): Promise<[number, number, number][]> {
  const doc = await PDFDocument.load(await readFile(path));
  const page = doc.getPage(0);
  const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject')) as unknown as { entries(): [PDFName, unknown][] };
  const [, ref] = xobjects.entries()[0]!;
  const stream = doc.context.lookup(ref as never) as PDFRawStream;
  const filter = stream.dict.get(PDFName.of('Filter'))?.toString();
  if (filter === '/DCTDecode') return shown(Buffer.from(stream.contents));
  // pdf-lib's PNG embedding: FlateDecode RGB, 8 bits, Width × Height.
  const { inflateSync } = await import('node:zlib');
  const width = Number(stream.dict.get(PDFName.of('Width'))?.toString());
  const height = Number(stream.dict.get(PDFName.of('Height'))?.toString());
  const raw = inflateSync(Buffer.from(stream.contents));
  return shown(await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer());
}

describe('colour of conversions and keepMetadata (hardening)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-hard-colour-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['png', 'srgb', false],
    ['png', 'p3', false],
    ['png', 'p3', true],
    ['tiff', 'p3', false],
    ['png', null, false],
  ] as const)('16-bit %s with profile %s (alpha %s) converts to the colours it shows', async (format, profile, alpha) => {
    let pipeline = sharp(blocks(alpha), { raw: { width: W, height: H, channels: alpha ? 4 : 3 } }).toColourspace('rgb16');
    if (profile) pipeline = pipeline.withIccProfile(profile);
    const data = await (format === 'png' ? pipeline.png() : pipeline.tiff({ compression: 'lzw' })).toBuffer();
    expect((await sharp(data).metadata()).depth).toBe('ushort');
    const path = join(dir, `src16-${profile ?? 'none'}-${alpha ? 'a' : 'o'}.${format}`);
    await writeFile(path, data);
    const input = await inputOf(path, format);
    const targets = [format === 'png' ? 'convert.tiff' : 'convert.png', 'convert.jpeg', 'convert.webp', 'convert.avif', 'convert.bmp'] as const;
    for (const actionId of targets) {
      const output = (await run(actionId, [input], { quality: 100 }, { outputDir: dir })).outputs[0]!;
      if (actionId === 'convert.bmp') {
        const { decodeBmp } = await import('../src/codecs/bmp');
        const bmp = decodeBmp(await readFile(output.path), 1e6);
        const png = await sharp(bmp.data, { raw: { width: bmp.width, height: bmp.height, channels: 4 } }).png().toBuffer();
        expect(worst(await shown(png), COLOURS), actionId).toBeLessThanOrEqual(3);
        continue;
      }
      expect(worst(await shown(output.path), COLOURS), `${actionId} ${profile}`).toBeLessThanOrEqual(actionId === 'convert.avif' || actionId === 'convert.webp' ? 6 : 3);
      expect((await sharp(output.path).metadata()).depth, actionId).toBe('uchar');
    }
    // images → PDF and image → DOCX embed the same 8-bit sRGB picture.
    const pdf = (await run('convert.pdf', [input], {}, { outputDir: dir })).outputs[0]!;
    expect(worst(await pdfImageColours(pdf.path), COLOURS)).toBeLessThanOrEqual(3);
    const docx = (await run('convert.docx', [input], {}, { outputDir: dir })).outputs[0]!;
    expect(worst(await shown(await docxMedia(docx.path)), COLOURS)).toBeLessThanOrEqual(3);
  });

  it('keepMetadata on a CMYK JPEG converts with its embedded profile, keeps EXIF and tags sRGB', async () => {
    // A CMYK JPEG tagged with a CMYK profile that is not sharp's built-in one: pdf.js' CGATS001
    // profile (an installed dependency, so the test runs anywhere). 44 levels separate it from
    // sharp's default CMYK conversion on these colours.
    const profile = await readFile(join(REPO_ROOT, 'node_modules', 'pdfjs-dist', 'iccs', 'CGATS001Compat-v2-micro.icc'));
    const cmyk = await sharp(blocks(), { raw: { width: W, height: H, channels: 3 } }).toColourspace('cmyk').withExif({ IFD0: { Make: 'Hardening' } }).jpeg({ quality: 100 }).toBuffer();
    const payload = Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([1, 1]), profile]);
    const app2 = Buffer.alloc(4);
    app2.set([0xff, 0xe2]);
    app2.writeUInt16BE(payload.length + 2, 2);
    const tagged = Buffer.concat([cmyk.subarray(0, 2), app2, payload, cmyk.subarray(2)]);
    expect(await sharp(tagged).metadata()).toMatchObject({ space: 'cmyk', channels: 4 });
    const path = join(dir, 'cmyk-tagged.jpg');
    await writeFile(path, tagged);
    const input = await inputOf(path, 'jpeg');
    // Reference: the conversion without keepMetadata (sharp's default path uses the embedded profile).
    const plain = await shown((await run('convert.png', [input], {}, { outputDir: dir })).outputs[0]!.path);
    for (const [actionId, options] of [
      ['convert.png', { keepMetadata: true }],
      ['convert.webp', { keepMetadata: true, quality: 100 }],
      ['tool.compress', { keepMetadata: true, format: 'png', pngMode: 'lossless' }],
      ['tool.compress', { keepMetadata: true, format: 'jpeg', quality: 100 }],
    ] as const) {
      const output = (await run(actionId, [input], options, { outputDir: dir })).outputs[0]!;
      const meta = await sharp(output.path).metadata();
      const label = `${actionId} ${JSON.stringify(options)}`;
      expect(worst(await shown(output.path), plain), label).toBeLessThanOrEqual(3);
      expect(meta.space, label).toBe('srgb');
      expect(meta.exif, label).toBeDefined();
      if (meta.icc) expect(meta.icc.toString('latin1', 16, 20), label).toBe('RGB ');
    }
  });
});
