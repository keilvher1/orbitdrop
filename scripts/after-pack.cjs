// electron-builder afterPack hook for OrbitDrop (CommonJS: loaded by electron-builder).
//
// Runs after the app directory (app.asar, app.asar.unpacked, extraResources) is assembled and
// before Electron fuses, code signing and dmg/zip/nsis creation. It fails the build when the
// package would not work on a clean machine:
//   * the native drag helper is missing, not executable, or built for another architecture;
//   * sharp (+ libvips) or @napi-rs/canvas binaries for the target os/arch are missing;
//   * required JS entry points / runtime packages are missing from app.asar;
//   * a Windows binary imports the Visual C++ runtime without shipping it next to itself
//     (policy: static CRT or app-local DLLs; the installer never installs a VC++ redistributable).
// It also prunes native packages built for a foreign architecture (normally already excluded
// by electron-builder.yml) and prints a short inventory.
//
// Escape hatch for packaging experiments before the helper exists:
//   ORBITDROP_ALLOW_MISSING_HELPER=1  → a missing helper is a warning (package.mjs labels the
//   artifacts "-nohelper"). Everything else stays fatal.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };
const MACHO_CPU = { 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32', 12: 'armv7l' };
const PE_MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32', 0x1c4: 'armv7l' };
// C/C++ runtime DLLs that are NOT part of Windows (the UCRT, api-ms-win-crt-*, is): the Visual
// C++ redistributable and the MinGW runtime. They must be linked statically or shipped app-local.
const VC_RUNTIME_DLL =
  /^((vcruntime140(_1)?|msvcp140(_\d+|_atomic_wait|_codecvt_ids)?|concrt140|vcomp140|vccorlib140)d?|libstdc\+\+-6|libgcc_s_[a-z0-9]+-1|libwinpthread-1)\.dll$/i;
const VC_DEBUG_DLL = /^(ucrtbased|vcruntime140d|vcruntime140_1d|msvcp140d)\.dll$/i;

/** Architectures contained in a Mach-O file (thin or fat), or null when not Mach-O. */
function machOArchs(buf) {
  if (buf.length < 8) return null;
  const le = buf.readUInt32LE(0);
  if (le === 0xfeedfacf || le === 0xfeedface) return [MACHO_CPU[buf.readInt32LE(4) >>> 0] || `cpu:${buf.readInt32LE(4)}`];
  const be = buf.readUInt32BE(0);
  if (be === 0xcafebabe || be === 0xcafebabf) {
    const n = buf.readUInt32BE(4);
    if (n === 0 || n > 16) return null; // Java class files share the 0xcafebabe magic
    const entry = be === 0xcafebabf ? 32 : 20;
    const archs = [];
    for (let i = 0; i < n && 8 + (i + 1) * entry <= buf.length; i++) {
      const cpu = buf.readUInt32BE(8 + i * entry);
      archs.push(MACHO_CPU[cpu] || `cpu:${cpu}`);
    }
    return archs;
  }
  return null;
}

/** { arch, imports[] } for a PE file, or null when not PE. */
function peInfo(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null; // 'PE\0\0'
  const machine = buf.readUInt16LE(pe + 4);
  const sections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dataDir = opt + (magic === 0x20b ? 112 : 96);
  const imports = [];
  const secTable = opt + optSize;
  const rvaToOffset = (rva) => {
    for (let i = 0; i < sections; i++) {
      const s = secTable + i * 40;
      const va = buf.readUInt32LE(s + 12);
      const span = Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16));
      if (rva >= va && rva < va + span) return rva - va + buf.readUInt32LE(s + 20);
    }
    return -1;
  };
  if (dataDir + 16 <= buf.length) {
    const importRva = buf.readUInt32LE(dataDir + 8);
    let off = importRva ? rvaToOffset(importRva) : -1;
    for (let guard = 0; off >= 0 && off + 20 <= buf.length && guard < 512; guard++, off += 20) {
      const nameRva = buf.readUInt32LE(off + 12);
      if (nameRva === 0) break;
      const nameOff = rvaToOffset(nameRva);
      if (nameOff < 0) break;
      const end = buf.indexOf(0, nameOff);
      imports.push(buf.toString('latin1', nameOff, end < 0 ? nameOff + 64 : end));
    }
  }
  return { arch: PE_MACHINE[machine] || `machine:0x${machine.toString(16)}`, imports };
}

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function binaryInfo(file) {
  const head = readHead(file, 4096);
  const archs = machOArchs(head);
  if (archs) return { kind: 'mach-o', archs };
  if (head.length >= 2 && head.readUInt16LE(0) === 0x5a4d) {
    const info = peInfo(fs.readFileSync(file));
    if (info) return { kind: 'pe', archs: [info.arch], imports: info.imports };
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x7f454c46) return { kind: 'elf', archs: ['elf'] };
  return null;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const f of walk(dir)) total += fs.statSync(f).size;
  return total;
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/** Package directory (node_modules/<name> or node_modules/@scope/<name>) containing `file`. */
function packageDirOf(file) {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0 || i + 1 >= parts.length) return null;
  const len = parts[i + 1].startsWith('@') ? i + 3 : i + 2;
  return parts.slice(0, len).join(path.sep);
}

function listAsar(asarFile) {
  try {
    const asar = require('@electron/asar');
    return new Set(asar.listPackage(asarFile, { isPack: false }).map((p) => p.replace(/\\/g, '/').replace(/^\//, '')));
  } catch (err) {
    throw new Error(`cannot read ${asarFile}: ${err.message}`);
  }
}

async function afterPack(context) {
  const platform = context.electronPlatformName; // darwin | win32 | linux | mas
  const arch = ARCH_NAMES[context.arch] || String(context.arch);
  const os = platform === 'mas' ? 'darwin' : platform;
  const productFilename = context.packager.appInfo.productFilename;
  const resources =
    os === 'darwin'
      ? path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  const unpacked = path.join(resources, 'app.asar.unpacked');
  const nm = path.join(unpacked, 'node_modules');
  const errors = [];
  const warnings = [];
  const notes = [];
  const log = (msg) => console.log(`  • [after-pack] ${msg}`);

  log(`checking ${os}-${arch} package in ${path.relative(process.cwd(), context.appOutDir) || context.appOutDir}`);
  if (arch === 'universal') errors.push('universal builds are not supported; build arm64 and x64 separately');

  // ── 1. app.asar contents ────────────────────────────────────────────────────
  const asarFile = path.join(resources, 'app.asar');
  if (!fs.existsSync(asarFile)) {
    errors.push(`app.asar missing at ${asarFile}`);
  } else {
    const entries = listAsar(asarFile);
    const required = [
      'package.json',
      'out/main/index.js',
      'out/main/processor-host.js',
      'out/preload/index.js',
      'out/renderer/index.html',
      'node_modules/sharp/package.json',
      'node_modules/pdfjs-dist/package.json',
      'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
      'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
      'node_modules/pdfjs-dist/standard_fonts/FoxitSerif.pfb',
      'node_modules/pdfjs-dist/wasm/openjpeg.wasm',
      'node_modules/pdf-lib/package.json',
      'node_modules/@napi-rs/canvas/package.json',
      'node_modules/docx/package.json',
    ];
    for (const r of required) if (!entries.has(r)) errors.push(`app.asar is missing ${r}`);
    const leaked = [...entries].filter((e) => /^(src|test|e2e)\//.test(e) || /\.map$/.test(e) || /^node_modules\/(electron|electron-builder|typescript|vite|vitest)\//.test(e));
    if (leaked.length) errors.push(`app.asar contains development files, e.g. ${leaked.slice(0, 5).join(', ')}`);
    notes.push(`app.asar ${mb(fs.statSync(asarFile).size)}, ${entries.size} entries`);
  }

  // ── 2. native modules for the target os/arch ────────────────────────────────
  const expectNative = (label, relDir, fileRe) => {
    const dir = path.join(nm, relDir);
    if (!fs.existsSync(dir)) {
      errors.push(`${label}: ${path.join('app.asar.unpacked', 'node_modules', relDir)} is missing (is the ${os}-${arch} optional package installed?)`);
      return;
    }
    const hits = [...walk(dir)].filter((f) => fileRe.test(path.basename(f)));
    if (!hits.length) {
      errors.push(`${label}: no ${fileRe} under ${relDir}`);
      return;
    }
    for (const f of hits) {
      const info = binaryInfo(f);
      if (!info || !info.archs.includes(arch)) errors.push(`${label}: ${path.relative(unpacked, f)} is ${info ? info.archs.join('+') : 'not a native binary'}, expected ${arch}`);
    }
    notes.push(`${label}: ${hits.map((f) => path.basename(f)).join(', ')} (${arch})`);
  };
  if (os === 'darwin') {
    expectNative('sharp', `@img/sharp-darwin-${arch}`, /^sharp-darwin-.*\.node$/);
    expectNative('libvips', `@img/sharp-libvips-darwin-${arch}`, /^libvips-cpp\..*\.dylib$/);
    expectNative('@napi-rs/canvas', `@napi-rs/canvas-darwin-${arch}`, /\.node$/);
  } else if (os === 'win32') {
    expectNative('sharp', `@img/sharp-win32-${arch}`, /^sharp-win32-.*\.node$/);
    expectNative('libvips', `@img/sharp-win32-${arch}`, /^libvips-.*\.dll$/);
    expectNative('@napi-rs/canvas', `@napi-rs/canvas-win32-${arch}-msvc`, /\.node$/);
  } else {
    warnings.push(`no native checks for platform ${os}`);
  }

  // ── 3. native drag helper (extraResources → resources/helper) ───────────────
  const helperDir = path.join(resources, 'helper');
  const helperCandidates =
    os === 'darwin'
      ? [path.join(helperDir, 'OrbitDropHelper'), path.join(helperDir, 'OrbitDropHelper.app', 'Contents', 'MacOS', 'OrbitDropHelper')]
      : [path.join(helperDir, 'OrbitDropHelper.exe')];
  const helper = helperCandidates.find((p) => fs.existsSync(p));
  const allowMissingHelper = process.env.ORBITDROP_ALLOW_MISSING_HELPER === '1';
  if (!helper) {
    const staged = path.join('apps', 'desktop', 'resources', 'helper', `${os}-${arch}`);
    const msg = `native helper missing: expected ${path.relative(context.appOutDir, helperCandidates[0])} (staged from ${staged}; run "node scripts/build-native.mjs ${os === 'darwin' ? 'mac' : 'win'} --arch ${arch}")`;
    (allowMissingHelper ? warnings : errors).push(allowMissingHelper ? `${msg} — continuing because ORBITDROP_ALLOW_MISSING_HELPER=1` : msg);
  } else {
    const st = fs.statSync(helper);
    if (os === 'darwin' && (st.mode & 0o111) === 0) errors.push(`native helper is not executable: ${helper}`);
    const info = binaryInfo(helper);
    const expectKind = os === 'darwin' ? 'mach-o' : 'pe';
    if (!info || info.kind !== expectKind) errors.push(`native helper is not a ${expectKind} executable: ${helper}`);
    else if (!info.archs.includes(arch)) errors.push(`native helper is built for ${info.archs.join('+')}, expected ${arch}: ${helper}`);
    else notes.push(`helper: ${path.relative(resources, helper)} ${info.archs.join('+')} ${mb(st.size)}`);
  }

  // ── 4. foreign-architecture binaries + Windows C++ runtime policy ───────────
  const scanRoots = [unpacked, helperDir].filter((d) => fs.existsSync(d));
  const pruned = new Set();
  for (const root of scanRoots) {
    for (const file of walk(root)) {
      if (!fs.existsSync(file)) continue; // inside a pruned package
      const info = binaryInfo(file);
      if (!info) continue;
      const rel = path.relative(resources, file);
      const wrongOs = (os === 'darwin' && info.kind !== 'mach-o') || (os === 'win32' && info.kind !== 'pe');
      if (wrongOs || !info.archs.includes(arch)) {
        const pkg = packageDirOf(file);
        const pkgName = pkg ? path.relative(nm, pkg).split(path.sep).join('/') : '';
        // Only prune packages that are platform-specific by name (prebuilt binary packages).
        if (pkg && /^@img\/sharp-|^@napi-rs\/canvas-/.test(pkgName)) {
          fs.rmSync(pkg, { recursive: true, force: true });
          pruned.add(pkgName);
        } else {
          errors.push(`${rel} is a ${info.kind} binary for ${info.archs.join('+')}, not ${os}-${arch}`);
        }
        continue;
      }
      if (info.kind === 'pe') {
        const dir = path.dirname(file);
        for (const dll of info.imports || []) {
          if (VC_DEBUG_DLL.test(dll)) errors.push(`${rel} links the DEBUG C++ runtime (${dll}); build Release`);
          else if (VC_RUNTIME_DLL.test(dll) && !fs.existsSync(path.join(dir, dll))) {
            errors.push(`${rel} imports ${dll} but it is not shipped next to it; link the C/C++ runtime statically (MSVC /MT, MinGW -static) or stage the DLL app-local`);
          }
        }
      }
    }
  }
  if (pruned.size) warnings.push(`pruned foreign-architecture packages from app.asar.unpacked: ${[...pruned].join(', ')} (tighten the "files" exclusions in electron-builder.yml)`);
  notes.push(`app.asar.unpacked ${mb(dirSize(unpacked))}`);

  // ── 5. tray icons (main loads <resources>/tray/…) ───────────────────────────
  const trayIcons = os === 'darwin' ? ['trayTemplate.png', 'trayTemplate@2x.png'] : ['tray.ico', 'tray.png'];
  for (const f of trayIcons) if (!fs.existsSync(path.join(resources, 'tray', f))) errors.push(`tray icon missing: ${path.join('tray', f)} (run "node scripts/gen-icons.mjs")`);

  // ── 6. licence files shipped with the app ──────────────────────────────────
  if (!fs.existsSync(path.join(resources, 'THIRD_PARTY_LICENSES.md'))) errors.push('THIRD_PARTY_LICENSES.md is missing from resources (run "node scripts/licenses.mjs")');
  const runtimeLicenseDir = os === 'darwin' ? resources : context.appOutDir;
  for (const f of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
    if (!fs.existsSync(path.join(runtimeLicenseDir, f))) errors.push(`${f} (Electron/Chromium notices) is missing from ${path.relative(context.appOutDir, runtimeLicenseDir) || 'the app folder'}`);
  }

  for (const n of notes) log(n);
  for (const w of warnings) console.warn(`  ⚠ [after-pack] ${w}`);
  if (errors.length) {
    const msg = `OrbitDrop after-pack check failed for ${os}-${arch}:\n  - ${errors.join('\n  - ')}`;
    console.error(msg);
    throw new Error(msg);
  }
  log(`ok (${os}-${arch})`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.machOArchs = machOArchs;
module.exports.peInfo = peInfo;
module.exports.binaryInfo = binaryInfo;
