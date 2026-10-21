#!/usr/bin/env node
// Generates THIRD_PARTY_LICENSES.md for what OrbitDrop ships.
//
//   node scripts/licenses.mjs           # (re)write THIRD_PARTY_LICENSES.md
//   node scripts/licenses.mjs --check   # exit 1 if the committed file is out of date
//
// Scope:
//   * "node_modules": the production dependency tree of apps/desktop (copied into app.asar /
//     app.asar.unpacked by electron-builder);
//   * "bundled": third-party code compiled into apps/desktop/out by electron-vite — the
//     runtime libraries among apps/desktop devDependencies (React, icons, …) and the
//     dependencies of the @orbitdrop/* workspace packages;
//   * platform binary packages (sharp/libvips, @napi-rs/canvas) for every shipped target
//     (darwin-arm64, darwin-x64, win32-x64), listed once per family so the output is the same
//     on macOS and Windows;
//   * notable embedded components (Electron/Chromium, libvips and its libraries, pdf.js fonts,
//     cmaps and wasm decoders, Skia and the Rust crates inside @napi-rs/canvas).
// The output is deterministic (sorted, no timestamps).
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const OUTPUT = join(ROOT, 'THIRD_PARTY_LICENSES.md');

// Build tools among apps/desktop devDependencies: not shipped.
const BUILD_TOOLS = [/^electron$/, /^electron-builder$/, /^electron-vite$/, /^vite$/, /^@vitejs\//, /^typescript$/, /^vitest$/, /^jsdom$/, /^@testing-library\//, /^@playwright\//, /^@types\//, /^@orbitdrop\//];
// Removed from the package by electron-builder.yml "files" (type definitions only).
const PRUNED = new Set(['@types/node', 'undici-types']);
// Platform-specific prebuilt packages, reported per family for the shipped targets. The table is
// static so that the output is identical on macOS and Windows (each checkout only installs its own
// binaries); installed packages are checked against it.
const isPlatformPackage = (name) => (/^@img\/sharp-/.test(name) && name !== '@img/colour') || /^@napi-rs\/canvas-/.test(name);
const FAMILIES = [
  {
    family: '@img/sharp-{target}',
    repo: 'https://github.com/lovell/sharp',
    targets: {
      'darwin-arm64': ['@img/sharp-darwin-arm64', 'Apache-2.0'],
      'darwin-x64': ['@img/sharp-darwin-x64', 'Apache-2.0'],
      'win32-x64': ['@img/sharp-win32-x64', 'Apache-2.0 AND LGPL-3.0-or-later'],
    },
    note: 'sharp native addon. On Windows the package also contains the libvips DLLs.',
    texts: 'Apache-2.0: same text as the sharp package above. LGPL-3.0 (bundled libvips, Windows): text at the end of this file.',
  },
  {
    family: '@img/sharp-libvips-{target}',
    repo: 'https://github.com/lovell/sharp-libvips',
    targets: {
      'darwin-arm64': ['@img/sharp-libvips-darwin-arm64', 'LGPL-3.0-or-later'],
      'darwin-x64': ['@img/sharp-libvips-darwin-x64', 'LGPL-3.0-or-later'],
    },
    note: 'libvips and its libraries as one dynamic library (macOS). See "libvips" below.',
    texts: 'The published packages carry no licence file. LGPL-3.0 and GPL-3.0 texts are at the end of this file; the licences of the bundled libraries are listed in the libvips section.',
  },
  {
    family: '@napi-rs/canvas-{target}',
    repo: 'https://github.com/Brooooooklyn/canvas',
    targets: {
      'darwin-arm64': ['@napi-rs/canvas-darwin-arm64', 'MIT'],
      'darwin-x64': ['@napi-rs/canvas-darwin-x64', 'MIT'],
      'win32-x64': ['@napi-rs/canvas-win32-x64-msvc', 'MIT'],
    },
    note: 'Skia-based canvas used by pdf.js to rasterise pages. See "@napi-rs/canvas" below.',
    texts: 'MIT: same text as the @napi-rs/canvas package above. Statically linked components: see the @napi-rs/canvas section.',
  },
];
// Component lists of the native binaries (libvips + its libraries, @napi-rs/canvas SBOM), refreshed
// from the darwin packages when they are installed and committed so Windows produces the same file.
const NATIVE_SNAPSHOT = join(ROOT, 'docs', 'licenses', 'native-components.json');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const relRoot = (p) => relative(ROOT, p).split('\\').join('/');

function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

function repoUrl(pkg) {
  let url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!url) return pkg.homepage || '';
  url = url
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/');
  if (/^github:/.test(url)) url = `https://github.com/${url.slice(7)}`;
  else if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  if (pkg.repository?.directory) url += ` (${pkg.repository.directory})`;
  return url;
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type || l).join(' OR ');
  return 'UNKNOWN';
}

function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(f) && statSync(join(dir, f)).isFile())
    .sort();
}

// ── walk ─────────────────────────────────────────────────────────────────────
const entries = new Map(); // name@version → entry
const missing = [];
const familyVersions = new Map();

function visitDeps(pkg, dir, kind) {
  for (const name of Object.keys(pkg.dependencies ?? {})) visit(name, dir, kind, false, pkg);
  for (const name of Object.keys(pkg.optionalDependencies ?? {})) visit(name, dir, kind, true, pkg);
}

function visit(name, fromDir, kind, optional, parentPkg) {
  if (isPlatformPackage(name)) {
    const spec = parentPkg?.optionalDependencies?.[name] ?? parentPkg?.dependencies?.[name];
    if (spec && !familyVersions.has(name)) familyVersions.set(name, spec);
    return;
  }
  if (PRUNED.has(name)) return;
  const dir = resolvePackage(name, fromDir);
  if (!dir) {
    if (!optional) missing.push(`${name} (from ${parentPkg?.name ?? '?'})`);
    return;
  }
  const pkg = readJson(join(dir, 'package.json'));
  if (pkg.name?.startsWith('@orbitdrop/')) {
    const key = `workspace:${pkg.name}:${kind}`;
    if (entries.has(key)) return;
    entries.set(key, null);
    visitDeps(pkg, dir, 'bundled');
    return;
  }
  const key = `${pkg.name}@${pkg.version}`;
  const existing = entries.get(key);
  if (existing) {
    existing.kinds.add(kind);
    return;
  }
  entries.set(key, { name: pkg.name, version: pkg.version, license: licenseOf(pkg), repo: repoUrl(pkg), dir, kinds: new Set([kind]), files: licenseFiles(dir) });
  visitDeps(pkg, dir, kind);
}

const desktopPkg = readJson(join(DESKTOP, 'package.json'));
for (const name of Object.keys(desktopPkg.dependencies ?? {})) visit(name, DESKTOP, 'node_modules', false, desktopPkg);
for (const name of Object.keys(desktopPkg.devDependencies ?? {})) {
  if (BUILD_TOOLS.some((re) => re.test(name))) {
    if (name.startsWith('@orbitdrop/')) visit(name, DESKTOP, 'bundled', false, desktopPkg); // workspace code is bundled; walk its deps
    continue;
  }
  visit(name, DESKTOP, 'bundled', false, desktopPkg);
}
if (missing.length) {
  console.error(`missing packages (run pnpm install):\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
const list = [...entries.values()].filter(Boolean).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// ── platform families ────────────────────────────────────────────────────────
const checkMode = process.argv.includes('--check');
const problems = [];
const families = FAMILIES.map((f) => {
  const rows = Object.entries(f.targets).map(([target, [name, license]]) => {
    const dir = resolvePackage(name, ROOT);
    const pkg = dir ? readJson(join(dir, 'package.json')) : null;
    const version = familyVersions.get(name) ?? pkg?.version ?? '?';
    if (pkg && licenseOf(pkg) !== license) problems.push(`${name}: installed licence "${licenseOf(pkg)}" differs from the table ("${license}") in scripts/licenses.mjs`);
    if (pkg && pkg.version !== version) problems.push(`${name}: installed ${pkg.version} but sharp/canvas pin ${version}`);
    return { target, name, version, license };
  });
  return { ...f, rows };
});

// ── native component snapshot ────────────────────────────────────────────────
function readNativeComponents() {
  const libvipsDir = resolvePackage('@img/sharp-libvips-darwin-arm64', ROOT) ?? resolvePackage('@img/sharp-libvips-darwin-x64', ROOT);
  const canvasDir = resolvePackage('@napi-rs/canvas-darwin-arm64', ROOT) ?? resolvePackage('@napi-rs/canvas-darwin-x64', ROOT);
  if (!libvipsDir || !canvasDir || !existsSync(join(canvasDir, 'sbom.cdx.json'))) return null;
  const readme = readFileSync(join(libvipsDir, 'README.md'), 'utf8');
  const table = readme
    .split('\n')
    .filter((l) => /^\|\s*[a-z]/i.test(l) && !/Library\s*\|/.test(l))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  const sbom = readJson(join(canvasDir, 'sbom.cdx.json'));
  const components = (sbom.components ?? [])
    .filter((c) => c.type === 'library' && c.name !== 'canvas')
    .map((c) => ({ name: c.name, version: c.version ?? '', license: (c.licenses ?? []).map((l) => l.expression ?? l.license?.id ?? l.license?.name).filter(Boolean).join(' / ') || 'see upstream' }))
    .sort((x, y) => x.name.localeCompare(y.name) || x.version.localeCompare(y.version));
  return {
    $comment: 'Generated by scripts/licenses.mjs from the darwin packages; used as-is on other platforms.',
    libvips: {
      package: readJson(join(libvipsDir, 'package.json')).version,
      versions: existsSync(join(libvipsDir, 'versions.json')) ? readJson(join(libvipsDir, 'versions.json')) : {},
      table,
    },
    canvas: { package: readJson(join(canvasDir, 'package.json')).version, components },
  };
}
const snapshotText = (data) => `${JSON.stringify(data, null, 2)}\n`;
let native = readNativeComponents();
if (native) {
  const fresh = snapshotText(native);
  const committed = existsSync(NATIVE_SNAPSHOT) ? readFileSync(NATIVE_SNAPSHOT, 'utf8') : '';
  if (fresh !== committed) {
    if (checkMode) problems.push(`${relRoot(NATIVE_SNAPSHOT)} is out of date`);
    else writeFileSync(NATIVE_SNAPSHOT, fresh);
  }
} else if (existsSync(NATIVE_SNAPSHOT)) {
  native = readJson(NATIVE_SNAPSHOT);
} else {
  console.error(`${relRoot(NATIVE_SNAPSHOT)} is missing and the darwin native packages are not installed to create it`);
  process.exit(1);
}

// ── notable components ───────────────────────────────────────────────────────
const electronPkg = readJson(join(ROOT, 'node_modules', 'electron', 'package.json'));
const libvipsVersions = native.libvips.versions;
const libvipsVersion = libvipsVersions.vips ?? '?';
const libvipsPkgVersion = native.libvips.package;
const versionKey = { libultrahdr: 'uhdr', libimagequant: 'imagequant', libvips: 'vips' };
const libvipsTable = [
  '| Library | Version | Licence (per sharp-libvips) |',
  '|---|---|---|',
  ...native.libvips.table.map(([lib, lic]) => {
    const v = libvipsVersions[lib] ?? libvipsVersions[lib.replace(/^lib/, '')] ?? libvipsVersions[versionKey[lib]] ?? '';
    return `| ${lib} | ${v} | ${lic} |`;
  }),
].join('\n');

const comps = native.canvas.components;
const licenceKinds = [...new Set(comps.map((c) => c.license))].sort();
const canvasSbom = [
  `The macOS packages ship a CycloneDX SBOM (\`sbom.cdx.json\`) listing ${comps.length} statically linked components (the Windows binary is built from the same sources plus Windows system-binding crates):`,
  '',
  '<details><summary>Components inside the @napi-rs/canvas native binary</summary>',
  '',
  '| Component | Version | Licence |',
  '|---|---|---|',
  ...comps.map((c) => `| ${c.name} | ${c.version} | ${c.license} |`),
  '',
  '</details>',
  '',
  `Licence expressions present: ${licenceKinds.join('; ')}. Components under MPL-2.0 are used unmodified; their source is available from their upstream repositories (crates.io).`,
].join('\n');

const pdfjsDir = resolvePackage('pdfjs-dist', DESKTOP);
const pdfjsVersion = pdfjsDir ? readJson(join(pdfjsDir, 'package.json')).version : '?';

// ── render ───────────────────────────────────────────────────────────────────
// Production dependencies of apps/desktop stay external (node_modules) in the main/preload
// bundles, so a package reachable from both roots is reported as node_modules.
const kindLabel = (kinds) => (kinds.has('node_modules') ? 'node_modules' : 'bundled into app code');
const esc = (s) => String(s).replace(/\|/g, '\\|');
const fence = (text) => {
  const ticks = text.includes('```') ? '````' : '```';
  return `${ticks}text\n${text.replace(/\r\n/g, '\n').trimEnd()}\n${ticks}`;
};
const readText = (p) => readFileSync(p, 'utf8');

const out = [];
out.push(`# Third-party licences — OrbitDrop ${desktopPkg.version}

<!-- Generated by scripts/licenses.mjs — do not edit by hand. Regenerate: node scripts/licenses.mjs -->

OrbitDrop is built from open-source components. This file lists every third-party component
that is shipped inside the OrbitDrop installers for macOS (arm64, x64) and Windows (x64), with
its licence and where its source is published, followed by the licence texts. It is copied into
the installed app (\`Resources/THIRD_PARTY_LICENSES.md\` on macOS, \`resources\\THIRD_PARTY_LICENSES.md\`
on Windows). The licence of OrbitDrop's own code is set by the project owner (see README.md).

How components are shipped:

* **node_modules** — copied as-is into \`app.asar\` (native binaries into \`app.asar.unpacked\`),
  including each package's own LICENSE/NOTICE files.
* **bundled into app code** — compiled into the JavaScript under \`app.asar/out/\` by electron-vite.
* **runtime** — Electron (with Chromium and Node.js) is the application runtime.

## Summary

| Package | Version | Licence | Shipped as | Source |
|---|---|---|---|---|
| electron | ${electronPkg.version} | ${electronPkg.license} | runtime | https://github.com/electron/electron |
${list.map((e) => `| ${esc(e.name)} | ${e.version} | ${esc(e.license)} | ${kindLabel(e.kinds)} | ${esc(e.repo)} |`).join('\n')}
${families.map((f) => `| ${esc(f.family)} | ${[...new Set(f.rows.map((r) => r.version))].join(', ')} | ${[...new Set(f.rows.map((r) => r.license))].map(esc).join('; ')} | node_modules (native, per target) | ${esc(f.repo)} |`).join('\n')}

### Platform binary packages

${families
  .map(
    (f) => `**${f.family}** — ${f.note}

| Target | Package | Version | Licence |
|---|---|---|---|
${f.rows.map((r) => `| ${r.target} | ${r.name} | ${r.version} | ${esc(r.license)} |`).join('\n')}`,
  )
  .join('\n\n')}

## Notable embedded components

### Electron, Chromium and Node.js

Electron ${electronPkg.version} is MIT-licensed (text below). Electron embeds Chromium and Node.js
and their third-party components; their complete notices are in \`LICENSES.chromium.html\`, which
electron-builder ships with every build (macOS: \`OrbitDrop.app/Contents/Resources/\`; Windows: the
installation folder, next to \`LICENSE.electron.txt\`).

### libvips ${libvipsVersion} and its libraries (via sharp)

sharp is Apache-2.0. Its image engine libvips and several bundled libraries are licensed under the
**GNU LGPL** (used under LGPL-3.0-or-later), others under permissive licences:

${libvipsTable || '_(libvips package not installed on the generating machine)_'}

LGPL compliance notes for OrbitDrop:

* libvips and its LGPL libraries are **dynamically linked**: they are shipped as a separate shared
  library (\`app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-<arch>/lib/libvips-cpp.${libvipsVersion}.dylib\`
  on macOS, \`app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-*.dll\` on Windows) that is loaded
  at run time, unmodified, exactly as published in the \`@img/sharp-libvips-*\` ${libvipsPkgVersion} / \`@img/sharp-win32-x64\`
  npm packages.
* Users may replace that library with a modified, interface-compatible build. On macOS, replacing a
  file inside a signed app bundle invalidates its code signature; the modified copy can be re-signed
  ad hoc (\`codesign --force --deep --sign - OrbitDrop.app\`) to run it. OrbitDrop's terms do not
  restrict modification of these libraries or reverse engineering for debugging such modifications
  (LGPL-3.0 section 4).
* Corresponding source for these exact versions: libvips https://github.com/libvips/libvips
  (v${libvipsVersion}); build scripts and sources of every bundled library:
  https://github.com/lovell/sharp-libvips (v${libvipsPkgVersion}).
* The LGPL-3.0 text and the GPL-3.0 text it refers to are reproduced at the end of this file.

### pdf.js ${pdfjsVersion} (pdfjs-dist) data files

pdfjs-dist is Apache-2.0 (Mozilla). Files it ships alongside the code, each with its licence file
in the package:

| Files | Licence | Licence file |
|---|---|---|
| \`standard_fonts/Foxit*.pfb\` | BSD-3-Clause-style (PDFium Authors / Foxit) | \`standard_fonts/LICENSE_FOXIT\` |
| \`standard_fonts/LiberationSans-*.ttf\` | GPL-2.0 with font exception (Red Hat Liberation licence), distributed unmodified; source: https://github.com/liberationfonts/liberation-fonts | \`standard_fonts/LICENSE_LIBERATION\` |
| \`cmaps/*.bcmap\` | BSD-3-Clause (Adobe Systems) | \`cmaps/LICENSE\` |
| \`iccs/*.icc\` | CC0-1.0 | \`iccs/LICENSE\` |
| \`wasm/openjpeg.wasm\` (JPEG 2000) | BSD-2-Clause (OpenJPEG) + BSD-3-Clause wrapper (Mozilla) | \`wasm/LICENSE_OPENJPEG\`, \`wasm/LICENSE_PDFJS_OPENJPEG\` |
| \`wasm/jbig2.wasm\` (JBIG2) | BSD-3-Clause (PDFium) + Apache-2.0 wrapper (Mozilla) | \`wasm/LICENSE_JBIG2\`, \`wasm/LICENSE_PDFJS_JBIG2\` |
| \`wasm/qcms_bg.wasm\` (colour management) | MIT (qcms) | \`wasm/LICENSE_QCMS\`, \`wasm/LICENSE_PDFJS_QCMS\` |

Only the "legacy" build is shipped. The scripting sandbox (\`pdf.sandbox.*\`, \`wasm/quickjs-eval.*\`,
QuickJS, MIT), the web viewer and the modern build are not used and are excluded from the package.

### @napi-rs/canvas (Skia)

@napi-rs/canvas is MIT. Its native binary statically links Google's Skia graphics library
(BSD-3-Clause, https://skia.org/) and the Rust crates below.

${canvasSbom}

### Native drag helpers

* macOS helper (\`native/macos\`, Swift): links only Apple system frameworks provided by macOS
  (AppKit, ImageIO, UniformTypeIdentifiers, ApplicationServices) and the Swift runtime that ships
  with macOS. No third-party code.
* Windows helper (\`native/windows\`, C++): links only Windows system libraries (ole32, oleaut32,
  shell32, user32, gdi32, shcore, Direct2D, DirectWrite, WIC, wtsapi32, advapi32) and the statically
  linked Microsoft C/C++ runtime. No third-party code.

### Fonts and symbols provided by the operating system

The UI uses the operating system's fonts (Apple SD Gothic Neo / SF Pro on macOS, Segoe UI / Malgun
Gothic on Windows) and, where the native helper uses them, system symbol images (e.g. SF Symbols
on macOS). They are drawn by the operating system at run time under its own licence and are not
redistributed with OrbitDrop.

## Licence texts

Texts are copied from each package as published. Packages that do not include a licence file are
marked; their licence is the SPDX identifier from their package.json.
`);

out.push(`<details><summary>electron ${electronPkg.version} — ${electronPkg.license}</summary>\n\n${fence(readText(join(ROOT, 'node_modules', 'electron', 'LICENSE')))}\n\n</details>\n`);
for (const e of list) {
  const body = e.files.length ? e.files.map((f) => `\`${f}\`\n\n${fence(readText(join(e.dir, f)))}`).join('\n\n') : `_No licence file in the published package; licence: ${e.license}. Source: ${e.repo}_`;
  out.push(`<details><summary>${e.name} ${e.version} — ${esc(e.license)}</summary>\n\n${body}\n\n</details>\n`);
}
for (const f of families) {
  out.push(`<details><summary>${f.family} — ${[...new Set(f.rows.map((x) => x.license))].map(esc).join('; ')}</summary>\n\n_${f.texts}_\n\n</details>\n`);
}
out.push(`<details><summary>GNU Lesser General Public License v3.0 (libvips and LGPL libraries)</summary>\n\n${fence(readText(join(ROOT, 'docs', 'licenses', 'LGPL-3.0.txt')))}\n\n</details>\n`);
out.push(`<details><summary>GNU General Public License v3.0 (referenced by the LGPL-3.0)</summary>\n\n${fence(readText(join(ROOT, 'docs', 'licenses', 'GPL-3.0.txt')))}\n\n</details>\n`);

const text = `${out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;

// ── sanity: @license banners in the built bundles that the list does not cover ──
const outDir = join(DESKTOP, 'out');
if (existsSync(outDir)) {
  const names = new Set(list.map((e) => e.name.toLowerCase()));
  const unknown = new Set();
  const scan = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) scan(p);
      else if (/\.(c|m)?js$/.test(f.name)) {
        for (const m of readFileSync(p, 'utf8').matchAll(/@license\s+([@\w./-]+)/g)) {
          const n = m[1].toLowerCase();
          if (![...names].some((x) => n === x || n.startsWith(`${x}`) || x.endsWith(`/${n}`) || x === n.replace(/\.js$/, ''))) unknown.add(`${m[1]} (${relRoot(p)})`);
        }
      }
    }
  };
  scan(outDir);
  if (unknown.size) console.warn(`⚠ @license banners in apps/desktop/out not matched to a listed package:\n  ${[...unknown].join('\n  ')}`);
}

if (problems.length) {
  console.error(`licence data problems:\n  - ${problems.join('\n  - ')}`);
  if (checkMode || problems.some((x) => !x.includes('out of date'))) process.exit(1);
}
if (checkMode) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
  if (current !== text) {
    console.error('THIRD_PARTY_LICENSES.md is out of date: run node scripts/licenses.mjs');
    process.exit(1);
  }
  console.log(`THIRD_PARTY_LICENSES.md is up to date (${list.length} packages + ${families.length} platform families)`);
} else {
  writeFileSync(OUTPUT, text);
  console.log(`wrote ${relRoot(OUTPUT)}: ${list.length} packages + ${families.length} platform families (${(text.length / 1024).toFixed(0)} KiB)`);
}
