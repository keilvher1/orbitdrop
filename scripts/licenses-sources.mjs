// Shared by scripts/licenses.mjs (offline generator) and scripts/licenses-fetch.mjs (network):
// where the licence texts of components that ship WITHOUT their own notices come from, and how to
// find code that third-party bundles compiled in.
//
//   * libvips and the libraries bundled into @img/sharp-libvips-* / @img/sharp-win32-x64 (the npm
//     packages carry only a licence table, no texts): LIBVIPS_SOURCES, keyed like versions.json;
//   * Skia and the C/C++ libraries statically linked into @napi-rs/canvas (its SBOM names them by
//     the commit Skia pins): CANVAS_NATIVE_SOURCES; the Rust crates of that SBOM come from
//     static.crates.io;
//   * npm packages compiled into shipped files (docx's dist bundle, the core-js polyfills of
//     pdf.js's legacy build): found by scanInlinedModules(), fetched from registry.npmjs.org.
// URL templates: {v} = version, {v_} = dots → underscores, {v-} = dots → dashes. A URL ending in
// "?format=TEXT" is a googlesource file (base64 body).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DESKTOP = join(ROOT, 'apps', 'desktop');
export const UPSTREAM_DIR = join(ROOT, 'docs', 'licenses', 'upstream');
export const UPSTREAM_INDEX = join(UPSTREAM_DIR, 'index.json');
export const NATIVE_SNAPSHOT = join(ROOT, 'docs', 'licenses', 'native-components.json');

const GH = 'https://raw.githubusercontent.com';

export const LIBVIPS_SOURCES = {
  aom: { name: 'aom', license: 'BSD-2-Clause + AOMedia Patent License 1.0', files: { LICENSE: ['https://aomedia.googlesource.com/aom/+/refs/tags/v{v}/LICENSE?format=TEXT'], PATENTS: ['https://aomedia.googlesource.com/aom/+/refs/tags/v{v}/PATENTS?format=TEXT'] } },
  archive: { name: 'libarchive', license: 'BSD-2-Clause', files: { COPYING: [`${GH}/libarchive/libarchive/v{v}/COPYING`] } },
  cairo: { name: 'cairo', license: 'MPL-1.1 (or LGPL-2.1)', files: { COPYING: ['https://gitlab.freedesktop.org/cairo/cairo/-/raw/{v}/COPYING'], 'COPYING-MPL-1.1': ['https://gitlab.freedesktop.org/cairo/cairo/-/raw/{v}/COPYING-MPL-1.1'] } },
  cgif: { name: 'cgif', license: 'MIT', files: { LICENSE: [`${GH}/dloebl/cgif/v{v}/LICENSE`, `${GH}/dloebl/cgif/V{v}/LICENSE`] } },
  exif: { name: 'libexif', license: 'LGPL-2.1-or-later', files: { COPYING: [`${GH}/libexif/libexif/v{v}/COPYING`] } },
  expat: { name: 'expat', license: 'MIT', files: { COPYING: [`${GH}/libexpat/libexpat/R_{v_}/expat/COPYING`] } },
  ffi: { name: 'libffi', license: 'MIT', files: { LICENSE: [`${GH}/libffi/libffi/v{v}/LICENSE`] } },
  fontconfig: { name: 'fontconfig', license: 'MIT-style (fontconfig licence)', files: { COPYING: ['https://gitlab.freedesktop.org/fontconfig/fontconfig/-/raw/{v}/COPYING'] } },
  freetype: { name: 'freetype', license: 'FTL (or GPL-2.0-or-later)', files: { 'LICENSE.TXT': ['https://gitlab.freedesktop.org/freetype/freetype/-/raw/VER-{v-}/LICENSE.TXT'], 'FTL.TXT': ['https://gitlab.freedesktop.org/freetype/freetype/-/raw/VER-{v-}/docs/FTL.TXT'] } },
  fribidi: { name: 'fribidi', license: 'LGPL-2.1-or-later', files: { COPYING: [`${GH}/fribidi/fribidi/v{v}/COPYING`] } },
  glib: { name: 'glib', license: 'LGPL-2.1-or-later', files: { 'LGPL-2.1-or-later.txt': ['https://gitlab.gnome.org/GNOME/glib/-/raw/{v}/LICENSES/LGPL-2.1-or-later.txt'] } },
  harfbuzz: { name: 'harfbuzz', license: 'MIT ("Old MIT")', files: { COPYING: [`${GH}/harfbuzz/harfbuzz/{v}/COPYING`] } },
  heif: { name: 'libheif', license: 'LGPL-3.0-or-later', files: { COPYING: [`${GH}/strukturag/libheif/v{v}/COPYING`] } },
  highway: { name: 'highway', license: 'Apache-2.0 OR BSD-3-Clause', files: { LICENSE: [`${GH}/google/highway/{v}/LICENSE`] } },
  imagequant: { name: 'libimagequant', license: 'BSD-2-Clause', files: { COPYRIGHT: [`${GH}/lovell/libimagequant/v{v}/COPYRIGHT`] } },
  lcms: { name: 'lcms2', license: 'MIT', files: { LICENSE: [`${GH}/mm2/Little-CMS/lcms{v}/LICENSE`] } },
  mozjpeg: { name: 'mozjpeg', license: 'IJG AND BSD-3-Clause AND Zlib', files: { 'LICENSE.md': [`${GH}/mozilla/mozjpeg/{v}/LICENSE.md`], 'README.ijg': [`${GH}/mozilla/mozjpeg/{v}/README.ijg`] } },
  pango: { name: 'pango', license: 'LGPL-2.0-or-later', files: { COPYING: ['https://gitlab.gnome.org/GNOME/pango/-/raw/{v}/COPYING'] } },
  pixman: { name: 'pixman', license: 'MIT', files: { COPYING: ['https://gitlab.freedesktop.org/pixman/pixman/-/raw/pixman-{v}/COPYING'] } },
  png: { name: 'libpng', license: 'libpng-2.0', files: { LICENSE: [`${GH}/pnggroup/libpng/v{v}/LICENSE`] } },
  'proxy-libintl': { name: 'proxy-libintl', license: 'LGPL-2.0-or-later', files: { COPYING: [`${GH}/frida/proxy-libintl/{v}/COPYING`] } },
  rsvg: { name: 'librsvg', license: 'LGPL-2.1-or-later', files: { 'COPYING.LIB': ['https://gitlab.gnome.org/GNOME/librsvg/-/raw/{v}/COPYING.LIB'] } },
  tiff: { name: 'libtiff', license: 'libtiff', files: { 'LICENSE.md': ['https://gitlab.com/libtiff/libtiff/-/raw/v{v}/LICENSE.md'] } },
  uhdr: { name: 'libultrahdr', license: 'MIT AND Apache-2.0 (both, per its LICENSE)', files: { LICENSE: [`${GH}/google/libultrahdr/v{v}/LICENSE`] } },
  vips: { name: 'libvips', license: 'LGPL-2.1-or-later', files: { LICENSE: [`${GH}/libvips/libvips/v{v}/LICENSE`] } },
  webp: { name: 'libwebp', license: 'BSD-3-Clause + patent grant', files: { COPYING: [`${GH}/webmproject/libwebp/v{v}/COPYING`], PATENTS: [`${GH}/webmproject/libwebp/v{v}/PATENTS`] } },
  xml2: { name: 'libxml2', license: 'MIT', files: { Copyright: ['https://gitlab.gnome.org/GNOME/libxml2/-/raw/v{v}/Copyright'] } },
  'zlib-ng': { name: 'zlib-ng', license: 'Zlib', files: { 'LICENSE.md': [`${GH}/zlib-ng/zlib-ng/{v}/LICENSE.md`] } },
};
// libnsgif is vendored inside libvips (no version of its own, no licence file in the libvips tree):
// the MIT text from upstream plus the copyright headers of the vendored sources at the libvips tag.
export const LIBNSGIF = {
  name: 'libnsgif',
  license: 'MIT',
  files: {
    COPYING: [`${GH}/netsurf-browser/libnsgif/master/COPYING`],
    'gif.c (header)': [`${GH}/libvips/libvips/v{vips}/libvips/foreign/libnsgif/gif.c#leading-comment`],
    'lzw.c (header)': [`${GH}/libvips/libvips/v{vips}/libvips/foreign/libnsgif/lzw.c#leading-comment`],
  },
};
export const SKIA = { name: 'skia', license: 'BSD-3-Clause', files: { LICENSE: [`${GH}/google/skia/main/LICENSE`] } };
// Rust's standard library is linked into every Rust binary we ship (librsvg inside libvips,
// @napi-rs/canvas); its notices: the rust-lang/rust COPYRIGHT file and the two licence texts.
export const RUST_STD = {
  name: 'rust-std',
  license: 'MIT OR Apache-2.0 (see COPYRIGHT)',
  files: { COPYRIGHT: [`${GH}/rust-lang/rust/HEAD/COPYRIGHT`], 'LICENSE-MIT': [`${GH}/rust-lang/rust/HEAD/LICENSE-MIT`], 'LICENSE-APACHE': [`${GH}/rust-lang/rust/HEAD/LICENSE-APACHE`] },
};
// librsvg (inside libvips) is written in Rust and links crates the sharp-libvips licence table
// does not list. Their list — the normal dependency closure of librsvg-c for the shipped targets —
// is computed with `cargo tree` by `node scripts/licenses-fetch.mjs --librsvg-crates`.
export const LIBRSVG_CRATES = join(ROOT, 'docs', 'licenses', 'librsvg-crates.json');
export const LIBRSVG_TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-gnullvm'];
// @napi-rs/canvas SBOM components pinned by commit (Skia's DEPS), keyed by SBOM name.
export const CANVAS_NATIVE_SOURCES = {
  brotli: { license: 'MIT', files: { LICENSE: [`${GH}/google/brotli/{v}/LICENSE`] } },
  expat: { license: 'MIT', files: { COPYING: [`${GH}/libexpat/libexpat/{v}/expat/COPYING`] } },
  freetype: { license: 'FTL', files: { 'LICENSE.TXT': [`${GH}/freetype/freetype/{v}/LICENSE.TXT`], 'FTL.TXT': [`${GH}/freetype/freetype/{v}/docs/FTL.TXT`] } },
  harfbuzz: { license: 'MIT ("Old MIT")', files: { COPYING: [`${GH}/harfbuzz/harfbuzz/{v}/COPYING`] } },
  highway: { license: 'Apache-2.0', files: { LICENSE: [`${GH}/google/highway/{v}/LICENSE`] } },
  icu: { license: 'Unicode-3.0 (ICU)', files: { LICENSE: ['https://chromium.googlesource.com/chromium/deps/icu/+/{v}/LICENSE?format=TEXT'] } },
  'libjpeg-turbo': { license: 'BSD-3-Clause AND IJG AND Zlib', files: { 'LICENSE.md': ['https://chromium.googlesource.com/chromium/deps/libjpeg_turbo/+/{v}/LICENSE.md?format=TEXT'] } },
  libjxl: { license: 'BSD-3-Clause + patent grant', files: { LICENSE: [`${GH}/libjxl/libjxl/{v}/LICENSE`], PATENTS: [`${GH}/libjxl/libjxl/{v}/PATENTS`] } },
  libpng: { license: 'libpng-2.0', files: { LICENSE: [`${GH}/pnggroup/libpng/{v}/LICENSE`] } },
  libwebp: { license: 'BSD-3-Clause + patent grant', files: { COPYING: [`${GH}/webmproject/libwebp/{v}/COPYING`], PATENTS: [`${GH}/webmproject/libwebp/{v}/PATENTS`] } },
  wuffs: { license: 'Apache-2.0', files: { LICENSE: [`${GH}/google/wuffs-mirror-release-c/{v}/LICENSE`] } },
  zlib: { license: 'Zlib', files: { LICENSE: ['https://chromium.googlesource.com/chromium/src/third_party/zlib/+/{v}/LICENSE?format=TEXT'] } },
};
// Corresponding sources of the LGPL/MPL components: built by scripts/third-party-sources.mjs and
// attached to every GitHub release; THIRD_PARTY_LICENSES.md (scripts/licenses.mjs) points to them.
export const RELEASES_URL = 'https://github.com/keilvher1/orbitdrop/releases';
export const ISSUES_URL = 'https://github.com/keilvher1/orbitdrop/issues';
/** Release asset name of the sources archive, from apps/desktop/package.json. */
export const sourcesArchiveName = (desktopPkg) => `${desktopPkg.productName ?? 'OrbitDrop'}-${desktopPkg.version}-third-party-sources.tar.gz`;
export const isCommit = (v) => /^[0-9a-f]{40}$/.test(String(v));
export const expandUrl = (template, version, extra = {}) =>
  template
    .replaceAll('{v}', version)
    .replaceAll('{v_}', String(version).replaceAll('.', '_'))
    .replaceAll('{v-}', String(version).replaceAll('.', '-'))
    .replace(/\{(\w+)\}/g, (m, k) => extra[k] ?? m);
/** Licence-like files in source/tarball trees. */
export const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice|patents|unlicense)([._-][^/]*)?$/i;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** The committed snapshot of @img/sharp-libvips-* versions and the @napi-rs/canvas SBOM. */
export function readNativeSnapshot() {
  return existsSync(NATIVE_SNAPSHOT) ? readJson(NATIVE_SNAPSHOT) : null;
}

/**
 * Exclusions that electron-builder.yml "files" applies inside node_modules, as a predicate on
 * "node_modules/<package>/<path>" (same minimatch semantics as electron-builder: dot: true).
 */
export function shippedFilter() {
  const abl = createRequire(join(ROOT, 'package.json')).resolve('app-builder-lib/package.json');
  const req = createRequire(abl);
  const yaml = req('js-yaml');
  const { Minimatch } = req('minimatch');
  const files = yaml.load(readFileSync(join(DESKTOP, 'electron-builder.yml'), 'utf8')).files ?? [];
  const excluded = files.filter((p) => typeof p === 'string' && p.startsWith('!**/node_modules/') && !p.includes('${')).map((p) => new Minimatch(p.slice(1), { dot: true }));
  return (relPath) => !excluded.some((m) => m.match(relPath));
}

const MARKERS = [
  // rolldown/rollup (docx's dist): //#region node_modules/<chain>/file.js
  /#region (?:\.{0,2}\/)*node_modules\/((?:(?:@[^/\s]+\/)?[^/\s@][^/\s]*\/node_modules\/)*(?:@[^/\s]+\/)?[^/\s@][^/\s]*)\//g,
  // pdf.js's legacy build: // MODULE: ./node_modules/<chain>/file.js
  /\/\/ MODULE: (?:\.\/)?node_modules\/((?:(?:@[^/\s]+\/)?[^/\s@][^/\s]*\/node_modules\/)*(?:@[^/\s]+\/)?[^/\s@][^/\s]*)\//g,
];

/**
 * Third-party npm packages compiled into the shipped files of `packages` ([{ name, version, dir }]).
 * Returns [{ name, chain, host, hostVersion, files[] }] sorted by host and name; `chain` keeps the
 * nesting (e.g. "stream-browserify/node_modules/readable-stream") so versions can be looked up in
 * the host's lockfile. Files excluded by electron-builder.yml are not scanned.
 */
export function scanInlinedModules(packages) {
  const shipped = shippedFilter();
  const found = new Map();
  for (const pkg of packages) {
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(p);
        } else if (/\.(c|m)?js$/.test(e.name)) {
          const rel = `node_modules/${pkg.name}/${relative(pkg.dir, p).split('\\').join('/')}`;
          if (!shipped(rel) || statSync(p).size < 64) continue;
          const text = readFileSync(p, 'utf8');
          for (const re of MARKERS) {
            for (const m of text.matchAll(re)) {
              const chain = m[1];
              const name = chain.split('/node_modules/').pop();
              if (name === pkg.name) continue;
              const key = `${pkg.name}\0${chain}`;
              if (!found.has(key)) found.set(key, { name, chain, host: pkg.name, hostVersion: pkg.version, files: new Set() });
              found.get(key).files.add(rel);
            }
          }
        }
      }
    };
    walk(pkg.dir);
  }
  return [...found.values()]
    .map((x) => ({ ...x, files: [...x.files].sort() }))
    .sort((a, b) => a.host.localeCompare(b.host) || a.chain.localeCompare(b.chain));
}

/** Version of core-js compiled into a file, from its shared-store banner (`version: '3.50.0', mode: …, copyright: '… core-js …'`), or null. */
export function coreJsVersion(file) {
  if (!existsSync(file)) return null;
  const m = /version:\s*'(\d+\.\d+\.\d+)',\s*mode:[^\n]*\n\s*copyright:\s*'[^']*(?:core-js|zloirock)/.exec(readFileSync(file, 'utf8'));
  return m?.[1] ?? null;
}

export function readUpstreamIndex() {
  return existsSync(UPSTREAM_INDEX) ? readJson(UPSTREAM_INDEX) : { components: [] };
}
