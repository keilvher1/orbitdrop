#!/usr/bin/env node
// Renders every OrbitDrop icon from the SVG sources in apps/desktop/build/.
//
//   node scripts/gen-icons.mjs            # render + write + verify
//   node scripts/gen-icons.mjs --verify   # only verify the committed files
//
// Outputs (all committed):
//   apps/desktop/build/icon.png                    1024 px (macOS grid, used by electron-builder)
//   apps/desktop/build/icon.icns                   PNG-compressed ICNS (16 … 1024 px)
//   apps/desktop/build/icon.ico                    PNG-compressed ICO (16 … 256 px, Windows variant)
//   apps/desktop/resources/icons/icon.png          512 px runtime icon (dock/window icon in dev)
//   apps/desktop/resources/tray/trayTemplate.png   18 px macOS menu-bar template (black + alpha)
//   apps/desktop/resources/tray/trayTemplate@2x.png 36 px
//   apps/desktop/resources/tray/tray.png           16 px Windows notification-area icon
//   apps/desktop/resources/tray/tray@2x.png        32 px
//   apps/desktop/resources/tray/tray.ico           16 … 64 px
//
// Only sharp (already a runtime dependency) is used; the ICNS and ICO containers are
// written by the small encoders below. On macOS the ICNS is additionally checked with
// `iconutil` when it is available (optional).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const buildDir = join(desktop, 'build');
const iconsDir = join(desktop, 'resources', 'icons');
const trayDir = join(desktop, 'resources', 'tray');

const SRC = {
  app: join(buildDir, 'icon.svg'),
  trayTemplate: join(buildDir, 'tray-template.svg'),
  trayColor: join(buildDir, 'tray-color.svg'),
};

// ICNS element types with PNG payloads (all readable on macOS 10.8+; we target 14+).
const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32], // 16@2x
  ['ic12', 64], // 32@2x
  ['ic07', 128],
  ['ic13', 256], // 128@2x
  ['ic08', 256],
  ['ic14', 512], // 256@2x
  ['ic09', 512],
  ['ic10', 1024], // 512@2x
];
const APP_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const TRAY_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64];

const rel = (p) => relative(root, p).split('\\').join('/');

/** SVG width attribute (px at 72 dpi), used to pick the density for a target size. */
function svgBaseSize(svg) {
  const m = /<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/.exec(svg);
  if (!m) throw new Error('SVG source needs a numeric width attribute');
  return Number(m[1]);
}

/** Windows variant of the app icon: no macOS drop shadow, tighter view box. */
function windowsAppSvg(svg) {
  const out = svg
    .replace(/<[^>]*data-platform="mac"[^>]*\/>\s*/g, '')
    .replace('viewBox="0 0 1024 1024"', 'viewBox="80 80 864 864"');
  if (out === svg) throw new Error('icon.svg no longer matches the Windows transform (viewBox / data-platform markers)');
  return out;
}

/** Render an SVG string straight to a size x size RGBA PNG (vector render, no downscaling blur). */
async function renderPng(svg, size) {
  const density = (72 * size) / svgBaseSize(svg);
  const png = await sharp(Buffer.from(svg), { density })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const meta = await sharp(png).metadata();
  if (meta.width !== size || meta.height !== size) throw new Error(`render produced ${meta.width}x${meta.height}, expected ${size}`);
  return png;
}

/** ICNS container: 'icns' + total length, then [type, length, PNG] elements and a TOC. */
export function encodeIcns(entries /* [type, pngBuffer][] */) {
  const elems = entries.map(([type, png]) => {
    if (type.length !== 4) throw new Error(`bad ICNS type ${type}`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const toc = Buffer.alloc(8 + entries.length * 8);
  toc.write('TOC ', 0, 'latin1');
  toc.writeUInt32BE(toc.length, 4);
  entries.forEach(([type, png], i) => {
    toc.write(type, 8 + i * 8, 'latin1');
    toc.writeUInt32BE(png.length + 8, 12 + i * 8);
  });
  const body = Buffer.concat([toc, ...elems]);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'latin1');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

/** ICO container with PNG-compressed images (supported by Windows Vista and later). */
export function encodeIco(images /* [size, pngBuffer][] sorted ascending */) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach(([size, png], i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); // width (0 = 256)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette size
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map(([, png]) => png)]);
}

export function parseIcns(buf) {
  if (buf.toString('latin1', 0, 4) !== 'icns') throw new Error('not an ICNS file');
  if (buf.readUInt32BE(4) !== buf.length) throw new Error('ICNS length field does not match the file size');
  const out = [];
  for (let o = 8; o < buf.length; ) {
    const type = buf.toString('latin1', o, o + 4);
    const len = buf.readUInt32BE(o + 4);
    if (len < 8 || o + len > buf.length) throw new Error(`ICNS element ${type} overruns the file`);
    out.push({ type, data: buf.subarray(o + 8, o + len) });
    o += len;
  }
  return out;
}

export function parseIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO file');
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const width = buf.readUInt8(o) || 256;
    const height = buf.readUInt8(o + 1) || 256;
    const size = buf.readUInt32LE(o + 8);
    const offset = buf.readUInt32LE(o + 12);
    if (offset + size > buf.length) throw new Error(`ICO image ${i} overruns the file`);
    out.push({ width, height, data: buf.subarray(offset, offset + size) });
  }
  return out;
}

async function pngSize(data) {
  const isPng = data.length > 8 && data.readUInt32BE(0) === 0x89504e47;
  if (!isPng) throw new Error('entry is not PNG-compressed');
  const m = await sharp(data).metadata();
  return { width: m.width, height: m.height, channels: m.channels };
}

function write(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  console.log(`  wrote ${rel(path)} (${buf.length.toLocaleString('en-US')} bytes)`);
}

async function generate() {
  const appSvg = readFileSync(SRC.app, 'utf8');
  const winSvg = windowsAppSvg(appSvg);
  const trayTemplateSvg = readFileSync(SRC.trayTemplate, 'utf8');
  const trayColorSvg = readFileSync(SRC.trayColor, 'utf8');

  const cache = new Map();
  const appPng = async (size) => {
    if (!cache.has(size)) cache.set(size, await renderPng(appSvg, size));
    return cache.get(size);
  };

  console.log('app icon');
  write(join(buildDir, 'icon.png'), await appPng(1024));
  write(join(iconsDir, 'icon.png'), await appPng(512));
  const icnsEntries = [];
  for (const [type, size] of ICNS_ENTRIES) icnsEntries.push([type, await appPng(size)]);
  write(join(buildDir, 'icon.icns'), encodeIcns(icnsEntries));
  const icoImages = [];
  for (const size of APP_ICO_SIZES) icoImages.push([size, await renderPng(winSvg, size)]);
  write(join(buildDir, 'icon.ico'), encodeIco(icoImages));

  console.log('tray icons');
  write(join(trayDir, 'trayTemplate.png'), await renderPng(trayTemplateSvg, 18));
  write(join(trayDir, 'trayTemplate@2x.png'), await renderPng(trayTemplateSvg, 36));
  write(join(trayDir, 'tray.png'), await renderPng(trayColorSvg, 16));
  write(join(trayDir, 'tray@2x.png'), await renderPng(trayColorSvg, 32));
  const trayIco = [];
  for (const size of TRAY_ICO_SIZES) trayIco.push([size, await renderPng(trayColorSvg, size)]);
  write(join(trayDir, 'tray.ico'), encodeIco(trayIco));
}

async function verify() {
  const problems = [];
  const check = async (label, fn) => {
    try {
      await fn();
      console.log(`  ok  ${label}`);
    } catch (err) {
      problems.push(`${label}: ${err.message}`);
      console.log(`  ERR ${label}: ${err.message}`);
    }
  };
  const expectPng = async (path, size) => {
    const m = await pngSize(readFileSync(path));
    if (m.width !== size || m.height !== size) throw new Error(`is ${m.width}x${m.height}, expected ${size}x${size}`);
    if (m.channels !== 4) throw new Error(`has ${m.channels} channels, expected RGBA`);
  };

  console.log('verify');
  await check('build/icon.png 1024', () => expectPng(join(buildDir, 'icon.png'), 1024));
  await check('resources/icons/icon.png 512', () => expectPng(join(iconsDir, 'icon.png'), 512));
  await check('build/icon.icns', async () => {
    const elems = parseIcns(readFileSync(join(buildDir, 'icon.icns')));
    const byType = new Map(elems.map((e) => [e.type, e.data]));
    for (const [type, size] of ICNS_ENTRIES) {
      const data = byType.get(type);
      if (!data) throw new Error(`missing ${type}`);
      const m = await pngSize(data);
      if (m.width !== size || m.height !== size) throw new Error(`${type} is ${m.width}x${m.height}, expected ${size}`);
    }
  });
  const checkIco = async (path, sizes) => {
    const imgs = parseIco(readFileSync(path));
    const got = imgs.map((i) => i.width);
    if (got.join() !== sizes.join()) throw new Error(`sizes ${got.join(',')} != ${sizes.join(',')}`);
    for (const img of imgs) {
      const m = await pngSize(img.data);
      if (m.width !== img.width || m.height !== img.height) throw new Error(`entry ${img.width} decodes as ${m.width}x${m.height}`);
    }
  };
  await check('build/icon.ico', () => checkIco(join(buildDir, 'icon.ico'), APP_ICO_SIZES));
  await check('resources/tray/tray.ico', () => checkIco(join(trayDir, 'tray.ico'), TRAY_ICO_SIZES));
  await check('resources/tray/tray.png 16', () => expectPng(join(trayDir, 'tray.png'), 16));
  await check('resources/tray/tray@2x.png 32', () => expectPng(join(trayDir, 'tray@2x.png'), 32));
  for (const [name, size] of [
    ['trayTemplate.png', 18],
    ['trayTemplate@2x.png', 36],
  ]) {
    await check(`resources/tray/${name} ${size} (template: black + alpha only)`, async () => {
      const path = join(trayDir, name);
      await expectPng(path, size);
      const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
      let opaque = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        if (data[i + 3] === 0) continue;
        opaque++;
        if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) throw new Error('template image contains non-black pixels');
      }
      if (opaque === 0) throw new Error('template image is empty');
    });
  }
  if (process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'iconutil'], { encoding: 'utf8' }).status === 0) {
    await check('iconutil can read build/icon.icns', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'orbitdrop-icns-'));
      try {
        const out = join(dir, 'icon.iconset');
        const r = spawnSync('iconutil', ['-c', 'iconset', '-o', out, join(buildDir, 'icon.icns')], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr.trim() || `iconutil exited ${r.status}`);
        const files = readdirSync(out).sort();
        if (!files.includes('icon_512x512@2x.png') || !files.includes('icon_16x16.png')) throw new Error(`unexpected iconset: ${files.join(', ')}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  if (problems.length) {
    console.error(`\n${problems.length} icon problem(s):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log('all icons valid');
}

const verifyOnly = process.argv.includes('--verify');
if (!verifyOnly) await generate();
await verify();
