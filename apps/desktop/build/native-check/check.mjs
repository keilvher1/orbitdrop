// Loads sharp/libvips and @napi-rs/canvas the way the packaged app's bundles resolve them (from
// inside app.asar/out/main) and checks what Add Background and Annotate depend on:
//   * libvips built with librsvg: userSpaceOnUse linear/radial gradients and an rx/ry rounded
//     mask read back through extractChannel(0), as in packages/processors/src/tools;
//   * @napi-rs/canvas mapped from app.asar.unpacked, a system Korean font, Hangul ink;
//   * the native files actually mapped into the process (Node diagnostic report);
//   * the pure-JS writers the packaged smoke test does not reach: pdf-lib (Images → PDF) embeds a
//     PNG and reads the PDF back, docx (PDF → DOCX) packs a Korean paragraph into a ZIP — from the
//     package's own node_modules, so a dependency copied at the wrong version or trimmed away by
//     electron-builder.yml "files" fails here.
// Prints one line: NATIVE_CHECK {...}
import { createRequire } from 'node:module';
import path from 'node:path';

const resources = process.argv[process.argv.length - 1];
const req = createRequire(path.join(resources, 'app.asar', 'out', 'main', 'index.js'));
const out = { arch: process.arch, platform: process.platform, electron: process.versions.electron, processType: process.type, problems: [], warnings: [] };
const fail = (msg) => out.problems.push(msg);
// The Korean font is an OS component (Windows 11 / macOS ship one); a build machine without it
// (e.g. a Windows Server CI image) is reported, not treated as a broken package.
const warn = (msg) => out.warnings.push(msg);
const px = (data, info, x, y) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x + 1) * info.channels));

try {
  const sharp = req('sharp');
  out.sharp = { sharp: sharp.versions.sharp, vips: sharp.versions.vips, rsvg: sharp.versions.rsvg ?? null, svgInput: Boolean(sharp.format.svg?.input?.buffer) };
  if (!out.sharp.rsvg || !out.sharp.svgInput) fail('libvips has no librsvg / SVG input');
  const W = 200;
  const H = 100;
  const bg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>` +
    `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>` +
    `<radialGradient id="r" gradientUnits="userSpaceOnUse" cx="${W / 2}" cy="${H / 2}" r="20"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>` +
    `</defs><rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#r)"/></svg>`;
  const g = await sharp(Buffer.from(bg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [left, right, center] = [px(g.data, g.info, 1, 5), px(g.data, g.info, W - 2, 5), px(g.data, g.info, W / 2, H / 2)];
  out.gradient = { left, right, center };
  if (!(left[0] > 200 && left[2] < 50 && right[2] > 200 && right[0] < 50 && center.slice(0, 3).every((v) => v > 200))) fail('SVG gradients rendered wrong');
  const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#000"/><rect width="${W}" height="${H}" rx="30" ry="30" fill="#fff"/></svg>`;
  const m = await sharp(Buffer.from(maskSvg)).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  out.mask = { corner: m.data[0], edgeMid: m.data[(H / 2) * W], center: m.data[(H / 2) * W + W / 2] };
  if (!(out.mask.corner === 0 && out.mask.edgeMid === 255 && out.mask.center === 255)) fail('rounded-corner SVG mask rendered wrong');
} catch (err) {
  fail(`sharp: ${err.message}`);
}

try {
  const { createCanvas, GlobalFonts } = req('@napi-rs/canvas');
  const candidates = process.platform === 'win32' ? ['Malgun Gothic'] : ['Apple SD Gothic Neo', 'AppleGothic'];
  out.koreanFont = candidates.find((f) => GlobalFonts.has(f)) ?? null;
  if (!out.koreanFont) warn(`no system Korean font on this machine (${candidates.join(', ')})`);
  else {
    const c = createCanvas(160, 48);
    const ctx = c.getContext('2d');
    ctx.font = `32px "${out.koreanFont}"`;
    ctx.textBaseline = 'top';
    ctx.fillText('한글 주석', 4, 4);
    const d = ctx.getImageData(0, 0, 160, 48).data;
    let ink = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) ink++;
    out.hangulInkPixels = ink;
    if (ink < 100) warn('Hangul text produced no ink');
  }
} catch (err) {
  fail(`@napi-rs/canvas: ${err.message}`);
}

try {
  const { PDFDocument } = req('pdf-lib');
  // 1×1 RGBA PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  doc.addPage([72, 72]).drawImage(image, { x: 0, y: 0, width: 72, height: 72 });
  const bytes = await doc.save();
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  out.pdfLib = { bytes: bytes.length, pages };
  if (pages !== 1 || Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') fail('pdf-lib wrote a broken PDF');
} catch (err) {
  fail(`pdf-lib: ${err.message}`);
}

try {
  const docx = req('docx');
  const document = new docx.Document({ sections: [{ children: [new docx.Paragraph({ children: [new docx.TextRun('한글 문단')] })] }] });
  const buffer = await docx.Packer.toBuffer(document);
  out.docx = { bytes: buffer.length };
  if (buffer.subarray(0, 2).toString('latin1') !== 'PK') fail('docx wrote no ZIP container');
} catch (err) {
  fail(`docx: ${err.message}`);
}

out.loaded = process.report.getReport().sharedObjects.filter((p) => /sharp-|libvips|skia\./i.test(p));
// Windows reports the loaded files as \\?\D:\…; compare without that prefix, with one separator.
const comparable = (p) => p.replace(/^(\\\\|\/\/)\?(\\|\/)/, '').replace(/\\/g, '/').toLowerCase();
const unpacked = `${comparable(path.join(resources, 'app.asar.unpacked'))}/`;
for (const [label, re] of [
  ['sharp', /sharp-[a-z0-9]+-[a-z0-9]+.*\.node$/i],
  ['libvips', /libvips/i],
  ['@napi-rs/canvas', /skia\..*\.node$/i],
]) {
  const hit = out.loaded.find((p) => re.test(p));
  if (!hit) fail(`${label} native library was not loaded`);
  else if (!comparable(hit).startsWith(unpacked)) fail(`${label} was loaded from outside the package: ${hit}`);
}
out.ok = out.problems.length === 0;
console.log(`NATIVE_CHECK ${JSON.stringify(out)}`);
process.exit(0);
