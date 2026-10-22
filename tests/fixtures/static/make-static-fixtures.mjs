#!/usr/bin/env node
// Regenerates the committed static fixtures in this folder (macOS only: uses
// Swift/CoreGraphics and the system `sips` tool as independent encoders).
//
//   node tests/fixtures/static/make-static-fixtures.mjs [pdfs] [bmp] [jpx]   (default: all)
//
//   korean-text.pdf      Hangul text, embedded font subset (CoreText)       → text extraction / rendering
//   encrypted.pdf        user password "orbitdrop" (CoreGraphics RC4-128)   → PDF_ENCRYPTED
//   owner-only.pdf       owner password only, printing/copying not allowed  → opens (policy)
//                        (`make-static-fixtures.mjs owner` writes only this one)
//   sips-rgb24.bmp       24-bit top-down BMP written by macOS ImageIO       → BMP decoder vs. independent encoder
//   sips-rgba32.bmp      32-bit BITMAPV5HEADER BI_BITFIELDS BMP with alpha (ImageIO)
//   sips-source-rgb.png / sips-source-rgba.png   the pixels those BMPs were made from
//   jpx-image.pdf        a JPEG 2000 image (/JPXDecode, written by ImageIO) → PDF.js openjpeg wasm decoder
//   ccitt-g4.pdf         a CCITT Group 4 image (/CCITTFaxDecode, K -1)        → PDF.js CCITT decoder
//   jbig2-mmr.pdf        the same bitmap as a JBIG2 generic region (MMR)       → PDF.js jbig2 wasm decoder
//   bilevel-source.png   the bitmap both were encoded from (bilevel-codecs.mjs, pure JS); each PDF
//                        page shows it at exactly 1 image pixel per output pixel at 150 DPI
//   jpeg-arithmetic.jpg  arithmetic-coded baseline JPEG  ┐ jpegtran (libjpeg-turbo, e.g. Homebrew
//   jpeg-restart.jpg     baseline JPEG with a restart    │ jpeg-turbo) from jpeg-source.jpg,
//                        marker after every MCU row      │ which sharp writes; the `jpegs` target
//   jpeg-source.jpg      the JPEG both were made from    ┘ needs jpegtran on PATH
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from 'pdf-lib';
import sharp from 'sharp';

if (process.platform !== 'darwin') {
  console.error('make-static-fixtures.mjs needs macOS (swift, sips).');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const wanted = new Set(process.argv.slice(2));
const want = (name) => wanted.size === 0 || wanted.has(name);

if (want('pdfs')) execFileSync('swift', [join(here, 'make-pdfs.swift'), here], { stdio: 'inherit' });
else if (want('owner')) execFileSync('swift', [join(here, 'make-pdfs.swift'), here, 'owner-only.pdf'], { stdio: 'inherit' });

if (want('bmp')) {
  // 7×5 gradient: odd width so BMP rows need padding.
  const width = 7;
  const height = 5;
  const rgb = Buffer.alloc(width * height * 3);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      rgb.set([x * 36, y * 60, 255 - x * 30], i * 3);
      rgba.set([x * 36, y * 60, 255 - x * 30, x === 0 ? 0 : 40 + y * 50], i * 4);
    }
  }
  await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toFile(join(here, 'sips-source-rgb.png'));
  await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(join(here, 'sips-source-rgba.png'));
  for (const [src, out] of [
    ['sips-source-rgb.png', 'sips-rgb24.bmp'],
    ['sips-source-rgba.png', 'sips-rgba32.bmp'],
  ]) {
    execFileSync('sips', ['-s', 'format', 'bmp', join(here, src), '--out', join(here, out)], { stdio: 'ignore' });
  }
}

if (want('jpx')) {
  // 32×24 JPEG 2000 (left half red, right half blue) shown at 320×240 pt on a Letter page.
  const work = mkdtempSync(join(tmpdir(), 'orbitdrop-jpx-'));
  try {
    const raw = Buffer.alloc(32 * 24 * 3);
    for (let y = 0; y < 24; y += 1) for (let x = 0; x < 32; x += 1) raw.set(x < 16 ? [220, 30, 30] : [30, 30, 220], (y * 32 + x) * 3);
    await sharp(raw, { raw: { width: 32, height: 24, channels: 3 } }).png().toFile(join(work, 'src.png'));
    execFileSync('sips', ['-s', 'format', 'jp2', join(work, 'src.png'), '--out', join(work, 'img.jp2')], { stdio: 'ignore' });
    const jp2 = readFileSync(join(work, 'img.jp2'));
    const doc = await PDFDocument.create();
    const image = doc.context.register(doc.context.stream(jp2, { Type: 'XObject', Subtype: 'Image', Width: 32, Height: 24, Filter: 'JPXDecode' }));
    const page = doc.addPage([612, 792]);
    page.node.setXObject(PDFName.of('Im1'), image);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(320, 0, 0, 240, 146, 276), drawObject('Im1'), popGraphicsState());
    await writeFile(join(here, 'jpx-image.pdf'), await doc.save());
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
if (want('jpegs')) {
  // 48×32 gradient with a red block: arithmetic coding and restart markers only change the
  // entropy-coded data, so all three files decode to the same pixels.
  const width = 48;
  const height = 32;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgb.set(x < 16 && y < 16 ? [220, 30, 30] : [x * 5, y * 7, 128], (y * width + x) * 3);
  }
  const source = join(here, 'jpeg-source.jpg');
  await sharp(rgb, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toFile(source);
  execFileSync('jpegtran', ['-arithmetic', '-outfile', join(here, 'jpeg-arithmetic.jpg'), source]);
  execFileSync('jpegtran', ['-restart', '1', '-outfile', join(here, 'jpeg-restart.jpg'), source]);
}

if (want('bilevel')) {
  const { bilevelPattern, encodeG4, jbig2MmrStream } = await import('./bilevel-codecs.mjs');
  const { bitmap, width, height } = bilevelPattern();
  const grey = Buffer.alloc(width * height);
  for (let i = 0; i < bitmap.length; i += 1) grey[i] = bitmap[i] ? 0 : 255;
  await sharp(grey, { raw: { width, height, channels: 1 } }).png().toFile(join(here, 'bilevel-source.png'));
  const g4 = encodeG4(bitmap, width, height);
  // Page = image at 150 DPI, so a 150 DPI render maps one image pixel onto one output pixel.
  const pageW = (width * 72) / 150;
  const pageH = (height * 72) / 150;
  const images = {
    'ccitt-g4.pdf': (doc) =>
      doc.context.stream(g4, {
        Type: 'XObject', Subtype: 'Image', Width: width, Height: height, BitsPerComponent: 1, ColorSpace: 'DeviceGray',
        Filter: 'CCITTFaxDecode', DecodeParms: { K: -1, Columns: width, Rows: height },
      }),
    'jbig2-mmr.pdf': (doc) =>
      doc.context.stream(jbig2MmrStream(g4, width, height), {
        Type: 'XObject', Subtype: 'Image', Width: width, Height: height, BitsPerComponent: 1, ColorSpace: 'DeviceGray', Filter: 'JBIG2Decode',
      }),
  };
  for (const [name, make] of Object.entries(images)) {
    const doc = await PDFDocument.create();
    const image = doc.context.register(make(doc));
    const page = doc.addPage([pageW, pageH]);
    page.node.setXObject(PDFName.of('Im1'), image);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(pageW, 0, 0, pageH, 0, 0), drawObject('Im1'), popGraphicsState());
    await writeFile(join(here, name), await doc.save());
  }
}
console.log('static fixtures written to', here);
