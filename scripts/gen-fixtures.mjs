#!/usr/bin/env node
// Test fixtures for the conversion engine (processors-convert workstream).
//
//   node scripts/gen-fixtures.mjs [outDir]     (default: tests/fixtures/generated)
//
// Tests import `generateFixtures(dir, { only })` and generate what they need
// into their own temp folder (fast, no network, no external tools), so
// `pnpm test` works from a clean checkout. Static fixtures that need other
// tools (encrypted PDF, PDF with Korean text) live in tests/fixtures/static/
// together with their generator (make-static-fixtures.mjs, macOS only).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  beginText,
  degrees,
  endText,
  moveText,
  rgb,
  setFontAndSize,
  showText,
} from 'pdf-lib';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_DIR = join(ROOT, 'tests', 'fixtures', 'generated');
export const STATIC_DIR = join(ROOT, 'tests', 'fixtures', 'static');

const LETTER = [612, 792];
const A4 = [595.28, 841.89];
const A5_LANDSCAPE = [595.28, 419.53];

/** Text drawn on the fixture PDFs (tests compare extracted text against these). */
export const TEXT = {
  single: ['OrbitDrop single page fixture', 'Second line of the single page'],
  reportHeading: (n, total) => `Report page ${n} of ${total}`,
  reportParagraph1: [
    'The quarterly report describes the conversion pipeline that renders each',
    'page of a PDF document into a separate image file and writes the result',
    'next to the source file without overwriting anything in that folder.',
  ],
  reportParagraph2: ['Closing note for this page.'],
  rotated: 'Rotated page fixture',
  koreanCmap: '한글 CMap',
  partial: (n) => `Partial text page ${n}`,
  many: (n) => `Many pages fixture page ${n}`,
};

async function pdfBytes(build) {
  const doc = await PDFDocument.create();
  doc.setCreator('OrbitDrop fixtures');
  doc.setProducer('pdf-lib');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  await build(doc, { font, bold });
  return doc.save();
}

function drawLines(page, font, lines, { x = 72, y, size = 12, leading = 18 }) {
  let cursor = y;
  for (const line of lines) {
    page.drawText(line, { x, y: cursor, size, font, color: rgb(0, 0, 0) });
    cursor -= leading;
  }
  return cursor;
}

/** A grey "scanned page" image: dark bars that look like text lines, but no text layer. */
async function scannedPageJpeg(seed) {
  const width = 425;
  const height = 550;
  const bars = [];
  for (let i = 0; i < 18; i += 1) {
    const w = 260 + ((i * 37 + seed * 11) % 80);
    bars.push(`<rect x="40" y="${50 + i * 26}" width="${w}" height="10" fill="#222"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f4f1ea"/>${bars.join('')}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

async function solidJpeg(width, height, color, options = {}) {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90, ...options }).toBuffer();
}

/** Left half `left`, right half `right` (RGB). */
function twoToneRaw(width, height, left, right) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = x < width / 2 ? left : right;
      raw.set(c, (y * width + x) * 3);
    }
  }
  return raw;
}

const BUILDERS = {
  // ---------------------------------------------------------------- PDFs
  'Page 001.pdf': () =>
    pdfBytes(async (doc, { font }) => {
      const page = doc.addPage(LETTER);
      drawLines(page, font, TEXT.single, { y: 700, size: 18, leading: 26 });
    }),

  'report.pdf': () =>
    pdfBytes(async (doc, { font, bold }) => {
      for (let n = 1; n <= 3; n += 1) {
        const page = doc.addPage(LETTER);
        page.drawText(TEXT.reportHeading(n, 3), { x: 72, y: 720, size: 20, font: bold });
        const after = drawLines(page, font, TEXT.reportParagraph1, { y: 680, size: 12, leading: 16 });
        drawLines(page, font, TEXT.reportParagraph2, { y: after - 20, size: 12, leading: 16 });
      }
    }),

  // Page 1: /Rotate 90, page 2: /Rotate 180. A black square marks the
  // unrotated top-left corner so tests can check where it ends up.
  'rotated.pdf': () =>
    pdfBytes(async (doc, { font }) => {
      for (const angle of [90, 180]) {
        const page = doc.addPage(LETTER);
        page.drawRectangle({ x: 0, y: LETTER[1] - 72, width: 72, height: 72, color: rgb(0, 0, 0) });
        page.drawText(TEXT.rotated, { x: 100, y: 600, size: 18, font });
        page.setRotation(degrees(angle));
      }
    }),

  'mixed-sizes.pdf': () =>
    pdfBytes(async (doc, { font }) => {
      for (const [i, size] of [LETTER, A4, A5_LANDSCAPE].entries()) {
        const page = doc.addPage(size);
        page.drawText(`Mixed size page ${i + 1}`, { x: 50, y: size[1] - 80, size: 16, font });
      }
    }),

  'scanned.pdf': () =>
    pdfBytes(async (doc) => {
      for (let n = 0; n < 2; n += 1) {
        const image = await doc.embedJpg(await scannedPageJpeg(n));
        const page = doc.addPage(LETTER);
        page.drawImage(image, { x: 0, y: 0, width: LETTER[0], height: LETTER[1] });
      }
    }),

  // Pages 1 and 3 have text, page 2 is image-only.
  'partial-text.pdf': () =>
    pdfBytes(async (doc, { font }) => {
      const image = await doc.embedJpg(await scannedPageJpeg(7));
      for (let n = 1; n <= 3; n += 1) {
        const page = doc.addPage(LETTER);
        if (n === 2) page.drawImage(image, { x: 0, y: 0, width: LETTER[0], height: LETTER[1] });
        else page.drawText(TEXT.partial(n), { x: 72, y: 700, size: 16, font });
      }
    }),

  'many-pages.pdf': () =>
    pdfBytes(async (doc, { font }) => {
      for (let n = 1; n <= 12; n += 1) {
        const page = doc.addPage(LETTER);
        page.drawText(TEXT.many(n), { x: 72, y: 700, size: 16, font });
      }
    }),

  // Korean text in a NON-embedded CID font (HYGoThic-Medium, Adobe-Korea1) with the
  // predefined CMap UniKS-UCS2-H: exercises PDF.js' bundled CMaps (text) and the
  // system-font fallback (rendering).
  'korean-cmap.pdf': async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const descriptor = ctx.register(
      ctx.obj({ Type: 'FontDescriptor', FontName: 'HYGoThic-Medium', Flags: 6, FontBBox: [-6, -145, 1003, 880], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 880, StemV: 93 }),
    );
    const cidFont = ctx.register(
      ctx.obj({
        Type: 'Font',
        Subtype: 'CIDFontType0',
        BaseFont: 'HYGoThic-Medium',
        CIDSystemInfo: ctx.obj({ Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Korea1'), Supplement: 2 }),
        FontDescriptor: descriptor,
        DW: 1000,
      }),
    );
    const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'HYGoThic-Medium-UniKS-UCS2-H', Encoding: 'UniKS-UCS2-H', DescendantFonts: [cidFont] }));
    const page = doc.addPage(LETTER);
    page.node.setFontDictionary(PDFName.of('F1'), font);
    const ucs2 = [...TEXT.koreanCmap].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    page.pushOperators(beginText(), setFontAndSize('F1', 24), moveText(72, 700), showText(PDFHexString.of(ucs2)), endText());
    return doc.save();
  },

  // A PDF header followed by junk that contains no PDF objects at all
  // (upper-case letters and digits only, so no "obj"/"xref"/"trailer" keywords).
  'corrupt.pdf': async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789  \n';
    const junk = Buffer.alloc(4096);
    let x = 0x2545f491;
    for (let i = 0; i < junk.length; i += 1) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      junk[i] = alphabet.charCodeAt((x >>> 0) % alphabet.length);
    }
    return Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), junk]);
  },

  // ---------------------------------------------------------------- images
  'photo.jpg': async () => {
    const raw = Buffer.alloc(320 * 240 * 3);
    for (let y = 0; y < 240; y += 1) {
      for (let x = 0; x < 320; x += 1) raw.set([x % 256, y % 256, (x + y) % 256], (y * 320 + x) * 3);
    }
    return sharp(raw, { raw: { width: 320, height: 240, channels: 3 } })
      .withExif({ IFD0: { Make: 'OrbitDrop', Model: 'Fixture Camera', Copyright: 'fixture' } })
      .jpeg({ quality: 90 })
      .toBuffer();
  },

  'photo-progressive.jpg': () => solidJpeg(200, 120, '#3366cc', { progressive: true }),

  // Stored 60×30 (left red, right blue) with EXIF Orientation 6 (rotate 90° CW
  // to display): upright it is 30×60, red on top, blue at the bottom.
  'exif-orientation-6.jpg': () =>
    sharp(twoToneRaw(60, 30, [255, 0, 0], [0, 0, 255]), { raw: { width: 60, height: 30, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 95 })
      .toBuffer(),

  // 64×48: left half fully transparent, right half opaque green.
  'transparent.png': () => {
    const raw = Buffer.alloc(64 * 48 * 4);
    for (let y = 0; y < 48; y += 1) {
      for (let x = 32; x < 64; x += 1) raw.set([0, 200, 0, 255], (y * 64 + x) * 4);
    }
    return sharp(raw, { raw: { width: 64, height: 48, channels: 4 } }).png().toBuffer();
  },

  'png-named.jpg': () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#ff8800' } }).png().toBuffer(),

  'sample.webp': () => sharp(twoToneRaw(64, 48, [10, 120, 200], [240, 240, 20]), { raw: { width: 64, height: 48, channels: 3 } }).webp({ quality: 90 }).toBuffer(),

  'sample.tiff': () => sharp({ create: { width: 50, height: 40, channels: 3, background: '#884422' } }).tiff().toBuffer(),

  'sample.avif': () => sharp({ create: { width: 48, height: 32, channels: 3, background: '#228844' } }).avif({ quality: 60, effort: 0 }).toBuffer(),

  'sample.gif': () => sharp({ create: { width: 30, height: 20, channels: 3, background: '#aa00aa' } }).gif().toBuffer(),

  'landscape.png': () => sharp({ create: { width: 300, height: 200, channels: 3, background: '#1155aa' } }).png().toBuffer(),

  'portrait.png': () => sharp({ create: { width: 200, height: 300, channels: 3, background: '#aa5511' } }).png().toBuffer(),

  '사진 테스트 😀.jpg': () => solidJpeg(48, 32, '#11aa55'),

  'corrupt.jpg': async () => {
    const good = await solidJpeg(64, 64, '#123456');
    return good.subarray(0, Math.floor(good.length / 3));
  },
};

export const FIXTURE_NAMES = Object.freeze(Object.keys(BUILDERS));

/**
 * Write fixtures into `outDir` (created if needed). Returns { name: absolutePath }.
 * `only` limits generation to some names.
 */
export async function generateFixtures(outDir = DEFAULT_OUT_DIR, { only } = {}) {
  const names = only ?? FIXTURE_NAMES;
  await mkdir(outDir, { recursive: true });
  const paths = {};
  await Promise.all(
    names.map(async (name) => {
      const build = BUILDERS[name];
      if (!build) throw new Error(`Unknown fixture: ${name}`);
      const data = await build();
      const path = join(outDir, name);
      await writeFile(path, data);
      paths[name] = path;
    }),
  );
  return paths;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const outDir = resolve(process.argv[2] ?? DEFAULT_OUT_DIR);
  const started = Date.now();
  const paths = await generateFixtures(outDir);
  console.log(`Generated ${Object.keys(paths).length} fixtures in ${outDir} (${Date.now() - started} ms)`);
}
