import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdfResourceLoads, withFallbackFamily } from '../src/pdf/engine';
import { extractPageText, linesToParagraphs, type TextLine } from '../src/pdf/text';
import { detectKoreanFont } from '../src/tools';
import { docxParagraphs, makeFixtureDir, readZip, staticFixture } from './helpers/convert-fixtures';
import { errorCode, inputOf, pixel, rgbOf, run, type Rgb } from './helpers/hardening';

/**
 * PDF inputs beyond the happy path (hardening pass): page boxes and /Rotate, UserUnit,
 * encryption policy, damaged structure, CCITT/JBIG2/JPX images, annotations and form fields,
 * transparency, DPI metadata, text layout limits. Rendered results are decoded and sampled.
 */

const ptToPx = (pt: number, dpi: number) => Math.round((pt * dpi) / 72);

/** Distance-tolerant colour test (anti-aliasing never reaches the centre of a 40 pt square). */
const isColour = (px: readonly number[], c: readonly number[]) => px.every((v, i) => Math.abs(v - c[i]!) <= 8);

async function rotatedPage(path: string, rotate: number): Promise<void> {
  // MediaBox [-100 -50 300 250] (400×300 pt), CropBox [-80 -40 220 160] (300×200 pt): the
  // visible page is the crop box. Red square = its top-left corner, blue = its bottom-right.
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.setMediaBox(-100, -50, 400, 300);
  page.setCropBox(-80, -40, 300, 200);
  if (rotate) page.setRotation(degrees(rotate));
  page.drawRectangle({ x: -100, y: -50, width: 400, height: 300, color: rgb(0.8, 0.8, 0.8) });
  page.drawRectangle({ x: -80, y: 120, width: 40, height: 40, color: rgb(1, 0, 0) });
  page.drawRectangle({ x: 180, y: -40, width: 40, height: 40, color: rgb(0, 0, 1) });
  await writeFile(path, await doc.save());
}

describe('PDF inputs (hardening)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-hard-pdf-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([0, 90, 180, 270])('/Rotate %i with an offset MediaBox and a CropBox: crop box size, turned clockwise, at 150 and 300 DPI', async (rotate) => {
    const path = join(dir, `rot${rotate}.pdf`);
    await rotatedPage(path, rotate);
    const input = await inputOf(path, 'pdf');
    // Centres of the marks in the displayed (rotated) page, in points, page 300×200 before turning.
    const [w, h] = rotate % 180 === 0 ? [300, 200] : [200, 300];
    const marks: Record<number, { red: [number, number]; blue: [number, number] }> = {
      0: { red: [20, 20], blue: [280, 180] },
      90: { red: [180, 20], blue: [20, 280] },
      180: { red: [280, 180], blue: [20, 20] },
      270: { red: [20, 280], blue: [180, 20] },
    };
    for (const dpi of [150, 300] as const) {
      const out = (await run('convert.png', [input], { dpi }, { outputDir: dir })).outputs[0]!;
      const image = await rgbOf(out.path);
      expect([image.width, image.height], `${dpi} DPI`).toEqual([ptToPx(w, dpi), ptToPx(h, dpi)]);
      const at = ([x, y]: [number, number]) => pixel(image, ptToPx(x, dpi), ptToPx(y, dpi));
      expect(isColour(at(marks[rotate]!.red), [255, 0, 0]), `${dpi} red ${at(marks[rotate]!.red).join(',')}`).toBe(true);
      expect(isColour(at(marks[rotate]!.blue), [0, 0, 255]), `${dpi} blue`).toBe(true);
    }
  });

  it('UserUnit 2 doubles the physical page size (PDF.js honours it)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    page.drawRectangle({ x: 0, y: 0, width: 150, height: 100, color: rgb(1, 0, 0) });
    const path = join(dir, 'userunit.pdf');
    await writeFile(path, await doc.save());
    const out = (await run('convert.png', [await inputOf(path, 'pdf')], { dpi: 150 }, { outputDir: dir })).outputs[0]!;
    expect([out.width, out.height]).toEqual([ptToPx(600, 150), ptToPx(400, 150)]);
  });

  it('odd page sizes give exact pixel sizes at 150 and 300 DPI (rounded to the nearest pixel)', async () => {
    const doc = await PDFDocument.create();
    const sizes: [number, number][] = [[200, 100], [612, 792], [595.28, 841.89], [1191, 842], [72.5, 36.1]];
    for (const size of sizes) doc.addPage(size);
    const path = join(dir, 'sizes.pdf');
    await writeFile(path, await doc.save());
    for (const dpi of [150, 300] as const) {
      const result = await run('convert.jpeg', [await inputOf(path, 'pdf')], { dpi }, { outputDir: dir });
      const decoded = await Promise.all(result.outputs.map(async (o) => (await sharp(o.path).metadata()) as { width: number; height: number }));
      expect(decoded.map((m) => [m.width, m.height])).toEqual(sizes.map(([w, h]) => [ptToPx(w, dpi), ptToPx(h, dpi)]));
    }
  });

  it('owner-password-only PDFs open (render and text); a user password is PDF_ENCRYPTED', async () => {
    const owner = staticFixture('owner-only.pdf');
    const user = staticFixture('encrypted.pdf');
    if (!owner || !user) throw new Error('static PDF fixtures missing');
    const input = await inputOf(owner, 'pdf');
    const png = (await run('convert.png', [input], { dpi: 150 }, { outputDir: dir })).outputs[0]!;
    const stats = await sharp(png.path).stats();
    expect(stats.channels[0]!.min).toBeLessThan(60); // the text is drawn
    const txt = (await run('convert.txt', [input], {}, { outputDir: dir })).outputs[0]!;
    expect(await readFile(txt.path, 'utf8')).toContain('Owner password only');
    for (const actionId of ['convert.png', 'convert.txt', 'convert.docx'] as const) {
      expect(await errorCode(run(actionId, [await inputOf(user, 'pdf')], {}, { outputDir: dir })), actionId).toBe('PDF_ENCRYPTED');
    }
  });

  it('a broken xref offset is recovered; truncated or header-only files are PDF_CORRUPT', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([300, 200]).drawText('Recovered text', { x: 20, y: 100, size: 18, font });
    const good = Buffer.from(await doc.save({ useObjectStreams: false }));
    const startxref = good.lastIndexOf(Buffer.from('startxref'));
    const broken = Buffer.from(good);
    broken.write('99999', startxref + 10, 'latin1');
    const cases: [string, Buffer, string][] = [
      ['broken-xref.pdf', broken, 'ok'],
      ['truncated.pdf', good.subarray(0, Math.floor(good.length / 2)), 'PDF_CORRUPT'],
      ['header-only.pdf', Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), 'PDF_CORRUPT'],
    ];
    for (const [name, data, expected] of cases) {
      const path = join(dir, name);
      await writeFile(path, data);
      const input = await inputOf(path, 'pdf');
      expect(await errorCode(run('convert.png', [input], { dpi: 150 }, { outputDir: dir })), name).toBe(expected);
      expect(await errorCode(run('convert.txt', [input], {}, { outputDir: dir })), name).toBe(expected);
    }
  });

  it('CCITT G4, JBIG2 (MMR) and JPEG 2000 images are decoded pixel for pixel, from the local wasm decoders', async () => {
    const source = staticFixture('bilevel-source.png');
    if (!source) throw new Error('bilevel fixtures missing (node tests/fixtures/static/make-static-fixtures.mjs bilevel)');
    const expected = await rgbOf(source);
    for (const name of ['ccitt-g4.pdf', 'jbig2-mmr.pdf']) {
      const path = staticFixture(name)!;
      const out = (await run('convert.png', [await inputOf(path, 'pdf')], { dpi: 150 }, { outputDir: dir })).outputs[0]!;
      const got = await rgbOf(out.path);
      expect([got.width, got.height], name).toEqual([expected.width, expected.height]);
      let mismatches = 0;
      for (let i = 0; i < got.data.length; i += 3) if (got.data[i]! < 128 !== expected.data[i]! < 128) mismatches += 1;
      expect(mismatches, name).toBe(0);
    }
    const jpx = staticFixture('jpx-image.pdf')!;
    const page = await rgbOf((await run('convert.png', [await inputOf(jpx, 'pdf')], { dpi: 150 }, { outputDir: dir })).outputs[0]!.path);
    // 32×24 JPEG 2000 (left red, right blue) drawn at 320×240 pt from (146, 276) on a Letter page.
    const centre = (xPt: number, yPtFromTop: number) => pixel(page, ptToPx(xPt, 150), ptToPx(yPtFromTop, 150));
    expect(isColour(centre(146 + 80, 792 - 276 - 120), [220, 30, 30])).toBe(true);
    expect(isColour(centre(146 + 240, 792 - 276 - 120), [30, 30, 220])).toBe(true);
    const loads = pdfResourceLoads();
    expect(loads['jbig2.wasm']).toBeGreaterThan(0);
    expect(loads['openjpeg.wasm']).toBeGreaterThan(0);
  });

  it('annotations and form fields are drawn from their appearance streams (hidden ones are not); TXT has page text only', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    page.drawText('Page text', { x: 20, y: 180, size: 12, font });
    const form = doc.getForm();
    const field = form.createTextField('name');
    field.setText('Field value');
    field.addToPage(page, { x: 20, y: 120, width: 160, height: 30, backgroundColor: rgb(1, 1, 0.6), textColor: rgb(0, 0, 0), font });
    const square = (rect: [number, number, number, number], colour: string, flags: number) => {
      const appearance = doc.context.register(
        doc.context.stream(`${colour} rg 0 0 ${rect[2] - rect[0]} ${rect[3] - rect[1]} re f`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, rect[2] - rect[0], rect[3] - rect[1]] }),
      );
      page.node.addAnnot(doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: rect, F: flags, AP: { N: appearance } })));
    };
    square([200, 20, 260, 80], '0 0 1', 4); // printable, visible: drawn
    square([200, 100, 260, 160], '1 0 0', 2); // hidden: not drawn
    const path = join(dir, 'annots.pdf');
    await writeFile(path, await doc.save());
    const input = await inputOf(path, 'pdf');
    const image = await rgbOf((await run('convert.png', [input], { dpi: 150 }, { outputDir: dir })).outputs[0]!.path);
    const at = (x: number, yFromTop: number) => pixel(image, ptToPx(x, 150), ptToPx(yFromTop, 150));
    expect(isColour(at(230, 200 - 50), [0, 0, 255])).toBe(true); // visible square annotation
    expect(isColour(at(230, 200 - 130), [255, 255, 255])).toBe(true); // hidden annotation
    expect(isColour(at(170, 200 - 135), [255, 255, 153])).toBe(true); // field background
    const text = await readFile((await run('convert.txt', [input], {}, { outputDir: dir })).outputs[0]!.path, 'utf8');
    expect(text).toContain('Page text');
    expect(text).not.toContain('Field value');
  });

  it('transparency: constant alpha and soft-masked images are composited like other renderers', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    page.drawRectangle({ x: 20, y: 50, width: 180, height: 130, color: rgb(0, 0, 1) });
    page.drawRectangle({ x: 100, y: 10, width: 180, height: 130, color: rgb(1, 0, 0), opacity: 0.5 });
    const alpha = Buffer.alloc(64 * 64 * 4);
    for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) alpha.set([0, 200, 0, Math.round((255 * x) / 63)], (y * 64 + x) * 4);
    const png = await doc.embedPng(await sharp(alpha, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer());
    page.drawImage(png, { x: 20, y: 5, width: 64, height: 40 });
    const path = join(dir, 'transparency.pdf');
    await writeFile(path, await doc.save());
    const image: Rgb = await rgbOf((await run('convert.png', [await inputOf(path, 'pdf')], { dpi: 150 }, { outputDir: dir })).outputs[0]!.path);
    const at = (x: number, yFromTop: number) => pixel(image, ptToPx(x, 150), ptToPx(yFromTop, 150));
    expect(isColour(at(50, 200 - 150), [0, 0, 255])).toBe(true);
    expect(isColour(at(150, 200 - 100), [128, 0, 128])).toBe(true); // 50 % red over blue
    expect(isColour(at(250, 200 - 30), [255, 128, 128])).toBe(true); // 50 % red over white
    expect(isColour(at(22, 200 - 25), [255, 255, 255])).toBe(true); // alpha ≈ 0
    expect(isColour(at(82, 200 - 25), [0, 200, 0])).toBe(true); // alpha ≈ 1
  });

  it('page DPI is written as JFIF density (and EXIF) in JPEGs and as pHYs in PNGs, also when downscaled', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const path = join(dir, 'letter.pdf');
    await writeFile(path, await doc.save());
    const input = await inputOf(path, 'pdf');
    const jfif = (jpeg: Buffer) => {
      expect(jpeg.toString('latin1', 6, 11)).toBe('JFIF\u0000');
      return { units: jpeg[13], x: jpeg.readUInt16BE(14), y: jpeg.readUInt16BE(16) };
    };
    for (const dpi of [150, 300] as const) {
      const jpg = (await run('convert.jpeg', [input], { dpi }, { outputDir: dir })).outputs[0]!;
      const bytes = await readFile(jpg.path);
      expect(jfif(bytes)).toEqual({ units: 1, x: dpi, y: dpi });
      expect((await sharp(bytes).metadata()).density).toBe(dpi);
      const png = (await run('convert.png', [input], { dpi }, { outputDir: dir })).outputs[0]!;
      expect((await sharp(png.path).metadata()).density).toBe(dpi);
    }
    const small = await run('convert.jpeg', [input], { dpi: 300 }, { outputDir: dir, limits: { maxOutputPixels: 2_000_000 } });
    const warning = small.warnings.find((w) => w.code === 'DOWNSCALED')!;
    expect(warning).toBeDefined();
    expect(jfif(await readFile(small.outputs[0]!.path)).x).toBe(Math.round(Number(warning.params!.dpi)));
  });

  it('Korean text in a non-embedded font with a predefined CMap: glyphs on the page, Hangul in TXT and DOCX', async () => {
    const fixtures = await makeFixtureDir(['korean-cmap.pdf']);
    try {
      const input = await inputOf(fixtures.path('korean-cmap.pdf'), 'pdf');
      const txt = await readFile((await run('convert.txt', [input], {}, { outputDir: dir })).outputs[0]!.path, 'utf8');
      expect(txt).toContain('한글 CMap');
      const docx = (await run('convert.docx', [input], {}, { outputDir: dir })).outputs[0]!;
      const xml = readZip(await readFile(docx.path)).get('word/document.xml')!.toString('utf8');
      expect(docxParagraphs(xml).map((p) => p.text)).toContain('한글 CMap');
      // The glyphs come from a system font (PDF.js has no CJK font data): only where one exists.
      if ((await detectKoreanFont()) !== null) {
        const page = await rgbOf((await run('convert.png', [input], { dpi: 150 }, { outputDir: dir })).outputs[0]!.path);
        let dark = 0;
        for (let y = ptToPx(792 - 700 - 24, 150); y < ptToPx(792 - 700 + 6, 150); y += 1) {
          for (let x = ptToPx(72, 150); x < ptToPx(72 + 48, 150); x += 1) if (pixel(page, x, y)[0] < 100) dark += 1;
        }
        expect(dark).toBeGreaterThan(200); // two Hangul syllables at 24 pt
      }
    } finally {
      await fixtures.cleanup();
    }
  });

  it('fonts PDF.js sets get the Hangul fallback family appended once (Windows: the generic family has no Hangul)', () => {
    const font = 'normal normal 24px "g_d0_f1", sans-serif';
    expect(withFallbackFamily(font, '"Malgun Gothic"')).toBe('normal normal 24px "g_d0_f1", sans-serif, "Malgun Gothic"');
    expect(withFallbackFamily(withFallbackFamily(font, '"Malgun Gothic"'), '"Malgun Gothic"')).toBe('normal normal 24px "g_d0_f1", sans-serif, "Malgun Gothic"');
    expect(withFallbackFamily(font, null)).toBe(font);
  });

  it('text layout survives pages with hundreds of thousands of lines (no call-stack overflow)', async () => {
    const lines: TextLine[] = Array.from({ length: 300_000 }, (_, i) => ({ text: 'x', x: 10 + (i % 7), y: 1e6 - i * 2, width: 5 + (i % 3), size: 1 }));
    expect(linesToParagraphs(lines, 0).length).toBe(300_000);
    const items = lines.map((l) => ({ str: l.text, transform: [1, 0, 0, 1, l.x, l.y], width: l.width, height: 1, hasEOL: true }));
    const page = { getTextContent: async () => ({ items }), view: [0, 0, 595, 842] } as unknown as Parameters<typeof extractPageText>[0];
    const text = await extractPageText(page);
    expect(text.lines.length).toBe(300_000);
    expect(text.columnWidth).toBeGreaterThan(0);
  });

  it('@napi-rs/canvas data() returns a copy, so rendered pages can free the canvas before encoding (engine.ts relies on it)', () => {
    const canvas = createCanvas(8, 8);
    const context = canvas.getContext('2d');
    context.fillStyle = '#00ff00';
    context.fillRect(0, 0, 8, 8);
    const first = canvas.data();
    context.fillStyle = '#0000ff';
    context.fillRect(0, 0, 8, 8);
    expect([...first.subarray(0, 3)]).toEqual([0, 255, 0]);
    canvas.width = 0;
    canvas.height = 0;
    expect([...first.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  });
});
