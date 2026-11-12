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
//     cmaps and wasm decoders, Skia and the Rust crates inside @napi-rs/canvas);
//   * npm packages compiled into shipped dependency files (docx's dist bundle, the core-js
//     polyfills of pdf.js's legacy build), found by their module markers.
// Licence texts the npm packages do not carry (libvips and its libraries, Skia and the canvas
// components, compiled-in packages) come from the committed snapshot docs/licenses/upstream,
// refreshed with `node scripts/licenses-fetch.mjs` (network); this script never uses the network.
// The output is deterministic (sorted, no timestamps).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DESKTOP, ISSUES_URL, LIBRSVG_CRATES, LIBVIPS_SOURCES, NATIVE_SNAPSHOT, RELEASES_URL, ROOT, UPSTREAM_DIR, coreJsVersion, readUpstreamIndex, scanInlinedModules, sourcesArchiveName } from './licenses-sources.mjs';

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
// Component lists of the native binaries (libvips + its libraries, @napi-rs/canvas SBOM) live in
// NATIVE_SNAPSHOT (docs/licenses/native-components.json), refreshed from the darwin packages when
// they are installed and committed so Windows produces the same file.

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
    const v = libvipsVersions[lib] ?? libvipsVersions[lib.replace(/^lib/, '')] ?? libvipsVersions[versionKey[lib]] ?? `(part of libvips ${libvipsVersions.vips ?? ''})`;
    return `| ${lib} | ${v} | ${lic} |`;
  }),
].join('\n');

const comps = native.canvas.components;
const licenceKinds = [...new Set(comps.map((c) => c.license))].sort();
const canvasSbom = [
  `Each platform package ships a CycloneDX SBOM (\`sbom.cdx.json\`). The macOS one lists the ${comps.length} statically linked components below (for ${native.canvas.package} the Windows package's SBOM lists the same components):`,
  '',
  '<details><summary>Components inside the @napi-rs/canvas native binary</summary>',
  '',
  '| Component | Version | Licence |',
  '|---|---|---|',
  ...comps.map((c) => `| ${c.name} | ${c.version} | ${c.license} |`),
  '',
  '</details>',
  '',
  `Licence expressions present: ${licenceKinds.join('; ')}. Components under MPL-2.0 are used unmodified; their source is in the release's sources archive (see "Source code of LGPL and MPL components") and on crates.io.`,
].join('\n');

const pdfjsDir = resolvePackage('pdfjs-dist', DESKTOP);
const pdfjsVersion = pdfjsDir ? readJson(join(pdfjsDir, 'package.json')).version : '?';

// ── licence texts from docs/licenses/upstream (libvips libraries, canvas components, compiled-in packages) ──
const upstream = readUpstreamIndex();
const upstreamByKey = new Map(upstream.components.map((c) => [`${c.group}/${c.name}@${c.version}`, c]));
const librsvgCrates = existsSync(LIBRSVG_CRATES) ? readJson(LIBRSVG_CRATES) : null;
if (!librsvgCrates) problems.push('docs/licenses/librsvg-crates.json is missing (run node scripts/licenses-fetch.mjs --librsvg-crates)');
else if (librsvgCrates.librsvg !== libvipsVersions.rsvg) problems.push(`docs/licenses/librsvg-crates.json lists librsvg ${librsvgCrates.librsvg}, libvips bundles ${libvipsVersions.rsvg} (run node scripts/licenses-fetch.mjs --librsvg-crates)`);
const upstreamNeeded = [
  ...Object.entries(libvipsVersions).map(([key, version]) => `libvips/${LIBVIPS_SOURCES[key]?.name ?? key}@${version}`),
  `libvips/libnsgif@libvips-${libvipsVersion}`,
  'canvas/skia@main',
  'rust/rust-std@stable',
  ...native.canvas.components.map((c) => `canvas/${c.name}@${c.version}`),
  ...(librsvgCrates?.crates ?? []).map((c) => `librsvg/${c.name}@${c.version}`),
];
for (const key of upstreamNeeded) if (!upstreamByKey.has(key)) problems.push(`docs/licenses/upstream has no licence text for ${key} (run node scripts/licenses-fetch.mjs)`);
// npm packages compiled into the shipped files of the node_modules packages (module markers)
const shippedPackages = list.filter((e) => e.kinds.has('node_modules')).map((e) => ({ name: e.name, version: e.version, dir: e.dir }));
const inlined = scanInlinedModules(shippedPackages).map((m) => {
  const entry = upstream.components.find((c) => c.group === 'bundled' && c.name === m.name && c.host === `${m.host}@${m.hostVersion}` && c.chain === m.chain);
  if (!entry) problems.push(`no licence text for ${m.chain} compiled into ${m.host} ${m.hostVersion} (run node scripts/licenses-fetch.mjs)`);
  if (entry && m.name === 'core-js') {
    const banner = coreJsVersion(join(resolvePackage(m.host, DESKTOP) ?? '', 'legacy', 'build', 'pdf.mjs'));
    if (banner && banner !== entry.version) problems.push(`core-js ${banner} is compiled into ${m.host} but docs/licenses/upstream has ${entry.version} (run node scripts/licenses-fetch.mjs)`);
  }
  return { ...m, entry };
});
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
for (const c of upstream.components) {
  for (const f of c.files) {
    const p = join(UPSTREAM_DIR, f.path);
    if (!existsSync(p) || sha256(readFileSync(p)) !== f.sha256) problems.push(`docs/licenses/upstream/${f.path} is missing or modified (run node scripts/licenses-fetch.mjs)`);
  }
}

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
* **compiled into <package>** — part of a file another package publishes already bundled (docx's
  \`dist\`, pdf.js's legacy build); their licence texts are reproduced below.
* **runtime** — Electron (with Chromium and Node.js) is the application runtime.

## Source code of LGPL and MPL components

The complete corresponding source of every component under the GNU LGPL or the Mozilla Public
License that OrbitDrop ships — libvips and its LGPL/MPL libraries with the patches and build
scripts used to build them, FFmpeg as built for Electron ${electronPkg.version}, and the MPL-2.0 Rust
crates — is published with each release at ${RELEASES_URL} — asset
\`${sourcesArchiveName(desktopPkg)}\`. Its \`MANIFEST.md\` lists every archive with its
upstream URL and SHA-256, and explains how to replace libvips or FFmpeg with a modified build.

Written offer: if that archive cannot be obtained there, we will provide the same sources — and the
source of the LGPL/MPL code in Electron's Chromium — to anyone who received OrbitDrop
${desktopPkg.version} in binary form, for three years after its release, at no charge as a download
or for no more than the cost of physically performing the distribution. Request it at
${ISSUES_URL}.

## Summary

| Package | Version | Licence | Shipped as | Source |
|---|---|---|---|---|
| electron | ${electronPkg.version} | ${electronPkg.license} | runtime | https://github.com/electron/electron |
${list.map((e) => `| ${esc(e.name)} | ${e.version} | ${esc(e.license)} | ${kindLabel(e.kinds)} | ${esc(e.repo)} |`).join('\n')}
${families.map((f) => `| ${esc(f.family)} | ${[...new Set(f.rows.map((r) => r.version))].join(', ')} | ${[...new Set(f.rows.map((r) => r.license))].map(esc).join('; ')} | node_modules (native, per target) | ${esc(f.repo)} |`).join('\n')}
${inlined
  .filter((m) => m.entry)
  .map((m) => `| ${esc(m.name)} | ${m.entry.version} | ${esc(m.entry.license)} | compiled into ${esc(m.host)} ${m.hostVersion} | https://www.npmjs.com/package/${m.name}/v/${m.entry.version} |`)
  .join('\n')}

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
and their third-party components; their complete notices are in \`LICENSES.chromium.html\`, which is
shipped with every build (macOS: \`OrbitDrop.app/Contents/Resources/LICENSES.chromium.html\`;
Windows: the installation folder, next to \`OrbitDrop.exe\` and \`LICENSE.electron.txt\`).

Among them is **FFmpeg**, which Chromium builds as a separate dynamic library
(\`Electron Framework.framework/Libraries/libffmpeg.dylib\` on macOS, \`ffmpeg.dll\` on Windows) under
the GNU LGPL 2.1 or later. OrbitDrop ships it unmodified, exactly as published in Electron
${electronPkg.version}, and does not call it directly; its notice is the "ffmpeg" entry of
\`LICENSES.chromium.html\`. Source: https://chromium.googlesource.com/chromium/third_party/ffmpeg
(the revision pinned by Electron ${electronPkg.version}'s Chromium; that revision and Electron's FFmpeg patch
are in the release's sources archive, see "Source code of LGPL and MPL components"); the LGPL notes
below apply to it too.

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
* Corresponding source for these exact versions, with the patches and build scripts used: the
  release's sources archive (see "Source code of LGPL and MPL components"). Upstream: libvips
  https://github.com/libvips/libvips (v${libvipsVersion}); build scripts and sources of every bundled
  library: https://github.com/lovell/sharp-libvips (v${libvipsPkgVersion}).
* cairo is used under the Mozilla Public License 1.1; its source is in the release's sources archive
  and at https://gitlab.freedesktop.org/cairo/cairo (tag ${libvipsVersions.cairo ?? '?'}).
* libvips also contains libnsgif (MIT, vendored in the libvips source tree), and librsvg is written
  in Rust: it statically links the ${librsvgCrates?.crates.length ?? '?'} crates listed under "Crates linked into librsvg"
  below and the Rust standard library.
* The licence text of every library above, as published upstream for the bundled version (the npm
  packages ship only the table), is reproduced under "Licence texts" below. The LGPL-3.0 text and
  the GPL-3.0 text it refers to are at the end of this file.

### pdf.js ${pdfjsVersion} (pdfjs-dist) data files

pdfjs-dist is Apache-2.0 (Mozilla). Files it ships alongside the code, each with its licence file
in the package:

| Files | Licence | Licence file |
|---|---|---|
| \`standard_fonts/Foxit*.pfb\` | BSD-3-Clause-style (PDFium Authors / Foxit) | \`standard_fonts/LICENSE_FOXIT\` |
| \`standard_fonts/LiberationSans-*.ttf\` (Liberation Sans 1.07.4) | GPL-2.0 with the font embedding exception (Red Hat Liberation Font licence), distributed unmodified; the same files are published in https://github.com/mozilla/pdf.js/tree/v${pdfjsVersion}/external/standard_fonts | \`standard_fonts/LICENSE_LIBERATION\` |
| \`cmaps/*.bcmap\` | BSD-3-Clause (Adobe Systems) | \`cmaps/LICENSE\` |
| \`iccs/*.icc\` | CC0-1.0 | \`iccs/LICENSE\` |
| \`wasm/openjpeg.wasm\` (JPEG 2000) | BSD-2-Clause (OpenJPEG) + BSD-3-Clause wrapper (Mozilla) | \`wasm/LICENSE_OPENJPEG\`, \`wasm/LICENSE_PDFJS_OPENJPEG\` |
| \`wasm/jbig2.wasm\` (JBIG2) | BSD-3-Clause (PDFium) + Apache-2.0 wrapper (Mozilla) | \`wasm/LICENSE_JBIG2\`, \`wasm/LICENSE_PDFJS_JBIG2\` |
| \`wasm/qcms_bg.wasm\` (colour management) | MIT (qcms) | \`wasm/LICENSE_QCMS\`, \`wasm/LICENSE_PDFJS_QCMS\` |

Only the "legacy" build is shipped. The scripting sandbox (\`pdf.sandbox.*\`, \`wasm/quickjs-eval.*\`,
QuickJS, MIT), the web viewer and the modern build are not used and are excluded from the package.
The legacy build (\`legacy/build/pdf.mjs\`, \`pdf.worker.mjs\`) compiles in the core-js polyfills
(MIT, listed under "Code compiled into dependency files").

### @napi-rs/canvas (Skia)

@napi-rs/canvas is MIT. Its native binary statically links Google's Skia graphics library
(BSD-3-Clause, https://skia.org/), the C/C++ libraries Skia pins, the Rust crates below and the
Rust standard library. Their licence texts are reproduced under "Licence texts" below.

${canvasSbom}

### Code compiled into dependency files

Some dependencies publish files that already contain other npm packages (found by the module
markers in the shipped files; versions from the publishing package's own lockfile, or from the
banner for core-js). They ship inside those files, not as separate packages:

| Package | Version | Licence | Compiled into | Shipped file(s) |
|---|---|---|---|---|
${inlined
  .filter((m) => m.entry)
  .map((m) => `| ${esc(m.name)} | ${m.entry.version} | ${esc(m.entry.license)} | ${esc(m.host)} ${m.hostVersion} | ${m.files.map((f) => `\`${f.replace(/^node_modules\//, '')}\``).join(', ')} |`)
  .join('\n')}

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
marked; their licence is the SPDX identifier from their package.json. A text that is identical
(ignoring white space) to one already reproduced is referenced instead of repeated.
`);

// Each distinct licence text once; later occurrences point to the first one.
const printedTexts = new Map();
const normKey = (text) => sha256(Buffer.from(text.replace(/\s+/g, ' ').trim(), 'utf8'));
function textBlock(owner, fileLabel, text, source) {
  const key = normKey(text);
  const from = source ? ` (source: ${source})` : '';
  if (printedTexts.has(key)) return `\`${fileLabel}\`${from}: same text as ${printedTexts.get(key)} above.`;
  printedTexts.set(key, `${owner}, \`${fileLabel}\``);
  return `\`${fileLabel}\`${from}\n\n${fence(text)}`;
}

out.push(`<details><summary>electron ${electronPkg.version} — ${electronPkg.license}</summary>\n\n${textBlock(`electron ${electronPkg.version}`, 'LICENSE', readText(join(ROOT, 'node_modules', 'electron', 'LICENSE')))}\n\n</details>\n`);
for (const e of list) {
  const body = e.files.length ? e.files.map((f) => textBlock(`${e.name} ${e.version}`, f, readText(join(e.dir, f)))).join('\n\n') : `_No licence file in the published package; licence: ${e.license}. Source: ${e.repo}_`;
  out.push(`<details><summary>${e.name} ${e.version} — ${esc(e.license)}</summary>\n\n${body}\n\n</details>\n`);
}
for (const f of families) {
  out.push(`<details><summary>${f.family} — ${[...new Set(f.rows.map((x) => x.license))].map(esc).join('; ')}</summary>\n\n_${f.texts}_\n\n</details>\n`);
}

// Texts the npm packages do not carry (docs/licenses/upstream, see scripts/licenses-fetch.mjs).
const shortVersion = (v) => (/^[0-9a-f]{40}$/.test(String(v)) ? `@${String(v).slice(0, 12)}` : String(v));
const UPSTREAM_GROUPS = [
  ['libvips', `libvips ${libvipsVersion} and the libraries bundled with it`, `As published upstream for the versions in \`@img/sharp-libvips-*\` ${libvipsPkgVersion} / \`@img/sharp-win32-x64\` (versions.json); the npm packages only list the licences.`],
  ['librsvg', `Crates linked into librsvg ${libvipsVersions.rsvg ?? '?'} (inside libvips)`, `The normal dependency closure of librsvg-c for ${(librsvgCrates?.targets ?? []).join(', ')} (\`cargo tree\` on librsvg's source, default features; see docs/licenses/librsvg-crates.json). Texts from each crate as published on crates.io.`],
  ['canvas', `Skia and the components linked into @napi-rs/canvas ${native.canvas.package}`, 'C/C++ libraries at the commits Skia pins (from the SBOM) and Rust crates as published on crates.io. Skia\'s text is from its main branch (unchanged for years).'],
  ['rust', 'Rust standard library', 'Linked into librsvg and @napi-rs/canvas. From the rust-lang/rust repository.'],
  ['bundled', 'npm packages compiled into dependency files', 'From each package as published on npm, at the version compiled in.'],
];
const declaredOnly = [];
for (const [group, title, intro] of UPSTREAM_GROUPS) {
  const comps = upstream.components.filter((c) => c.group === group);
  if (!comps.length) continue;
  out.push(`### ${title}\n\n${intro}\n`);
  for (const c of comps) {
    const owner = `${c.name} ${shortVersion(c.version)}`;
    const where = c.host ? ` — compiled into ${c.host.replace(/@([^@]+)$/, ' $1')}` : '';
    const blocks = c.files.map((f) => {
      const text = readText(join(UPSTREAM_DIR, f.path));
      if (f.name === 'NO-LICENCE-FILE.txt') {
        declaredOnly.push({ owner, license: c.license });
        return `_${text.trim()} The ${esc(c.license)} text is under "Licences declared without a published text" below._`;
      }
      return textBlock(owner, f.name, text, f.source);
    });
    out.push(`<details><summary>${owner} — ${esc(c.license)}${where}</summary>\n\n${blocks.join('\n\n')}\n\n</details>\n`);
  }
}
if (declaredOnly.length) {
  const mplKey = [...printedTexts.keys()].find((k) => printedTexts.get(k) && upstream.components.some((c) => c.license === 'MPL-2.0' && printedTexts.get(k).startsWith(`${c.name} `)));
  out.push(`### Licences declared without a published text

${declaredOnly.map((d) => `* ${d.owner} — ${esc(d.license)}`).join('\n')}

These components state their licence in their package metadata but publish no licence file. The
standard texts apply${mplKey ? `; the MPL-2.0 text is reproduced above (${printedTexts.get(mplKey)})` : ''}. MIT License (SPDX \`MIT\`), where the
copyright notice is the authors named in the component's metadata:
`);
  out.push(fence(`MIT License

Copyright (c) <the authors named above>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`));
  out.push('');
}
out.push('### GNU licences referenced above\n');
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
