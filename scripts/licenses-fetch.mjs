#!/usr/bin/env node
// Fetches the licence texts of shipped components whose npm packages do not carry them, into a
// committed snapshot that scripts/licenses.mjs reproduces in THIRD_PARTY_LICENSES.md (offline):
//
//   * libvips and every library bundled into @img/sharp-libvips-* / @img/sharp-win32-x64, at the
//     versions in versions.json (docs/licenses/native-components.json);
//   * Skia, the C/C++ libraries (pinned by commit) and the Rust crates statically linked into
//     @napi-rs/canvas, as listed by its SBOM;
//   * npm packages compiled into shipped files: docx's dist bundle (versions from docx's own
//     package-lock.json at the installed docx version) and the core-js polyfills of pdf.js's
//     legacy build (version from its banner).
//
//   node scripts/licenses-fetch.mjs                  # fetch what is missing or out of date
//   node scripts/licenses-fetch.mjs --refresh        # fetch everything again
//   node scripts/licenses-fetch.mjs --librsvg-crates # recompute docs/licenses/librsvg-crates.json
//                                                    # (needs cargo; then run without the flag)
//
// librsvg (inside libvips) is Rust: the crates it links are the normal dependency closure of
// librsvg-c for the shipped targets, computed with `cargo tree --locked` on librsvg's source at the
// bundled version (downloaded as data; cargo runs from the scratch folder with an isolated
// CARGO_HOME and only reads manifests — no build scripts run).
//
// Network (read-only): raw.githubusercontent.com, gitlab.*, *.googlesource.com, registry.npmjs.org,
// static.crates.io. Output: docs/licenses/upstream/<group>/<name>@<version>/<file> and
// docs/licenses/upstream/index.json (source URL and SHA-256 per file, no timestamps). Downloads are
// treated as data: tarballs are parsed in memory, only licence-like files are written, nothing is
// executed. `node scripts/licenses.mjs --check` fails while the snapshot does not match the
// installed versions.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  CANVAS_NATIVE_SOURCES,
  LIBNSGIF,
  LIBRSVG_CRATES,
  LIBRSVG_TARGETS,
  LIBVIPS_SOURCES,
  LICENCE_FILE,
  ROOT,
  RUST_STD,
  SKIA,
  UPSTREAM_DIR,
  UPSTREAM_INDEX,
  coreJsVersion,
  expandUrl,
  isCommit,
  readNativeSnapshot,
  readUpstreamIndex,
  scanInlinedModules,
} from './licenses-sources.mjs';

const refresh = process.argv.includes('--refresh');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const safe = (s) => String(s).replace(/[^A-Za-z0-9@._+-]/g, '_');
// File name for a fetched text: "README.md (licence section)" → "README.md.licence-section".
const fileSlug = (label) => safe(String(label).replace(/\s*\(([^)]+)\)$/, (m, note) => `.${note.trim().replace(/\s+/g, '-')}`).replace(/\s+/g, '-'));

// Placeholder written when neither the package nor its repository publishes a licence text.
const NO_LICENCE_FILE = 'NO-LICENCE-FILE.txt';
const crateUrl = (name, version) => `https://static.crates.io/crates/${name}/${encodeURIComponent(`${name}-${version}.crate`)}`;

// ── network ───────────────────────────────────────────────────────────────────
async function get(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000), headers: { 'user-agent': 'orbitdrop-licenses-fetch' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`${url}: ${lastError?.message}`);
}

/** First candidate URL that exists → { url, data } (googlesource ?format=TEXT is base64). */
async function fetchText(candidates, extra) {
  for (const template of candidates) {
    const [urlPart, transform] = template.split('#');
    const url = expandUrl(urlPart, extra.v, extra);
    const body = await get(url);
    if (!body) continue;
    let data = url.endsWith('?format=TEXT') ? Buffer.from(body.toString('latin1').trim(), 'base64') : body;
    if (transform === 'leading-comment') {
      const m = /^\s*(\/\*[\s\S]*?\*\/)/.exec(data.toString('utf8'));
      if (!m) continue;
      data = Buffer.from(`${m[1]}\n`, 'utf8');
    }
    return { url: transform ? `${url} (leading comment)` : url, data };
  }
  return null;
}

/** Entries of a .tgz/.crate in memory (ustar + GNU long names + pax path). */
function* tarEntries(gz) {
  const buf = gunzipSync(gz);
  let off = 0;
  let longName = null;
  let paxPath = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (s, e) => h.toString('utf8', s, e).replace(/\0[\s\S]*$/, '');
    let name = field(0, 100);
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = field(345, 500);
    if (prefix && h.toString('latin1', 257, 262) === 'ustar') name = `${prefix}/${name}`;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0[\s\S]*$/, '');
      continue;
    }
    if (type === 'x') {
      const m = /\d+ path=([^\n]+)\n/.exec(data.toString('utf8'));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue;
    if (longName) [name, longName] = [longName, null];
    if (paxPath) [name, paxPath] = [paxPath, null];
    if (type === '0' || type === '\0' || type === '7') yield { name, data };
  }
}

/** The "License" section of a README (heading to the next heading of the same or a higher level). */
function readmeLicenceSection(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s*licen[cs]e\b/i.test(l.trim()));
  if (start < 0) return null;
  const level = /^#+/.exec(lines[start].trim())[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i].trim());
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end).join('\n').trim();
  return section.length > 20 ? `${section}\n` : null;
}

/**
 * Licence-like files of a tarball, paths relative to its top folder. When the package has none,
 * the licence section of its top-level README stands in (e.g. hash.js keeps its MIT notice there).
 */
async function fetchTarballLicences(url, { maxDepth }) {
  const gz = await get(url);
  if (!gz) return null;
  const files = [];
  let readme = null;
  const meta = { license: null, repository: null, authors: null };
  for (const { name, data } of tarEntries(gz)) {
    const parts = name.split('/').slice(1); // drop "package/" or "<crate>-<version>/"
    if (parts.length === 1 && /^readme(\.(md|markdown|txt))?$/i.test(parts[0])) readme = { name: parts[0], data };
    if (parts.length === 1 && parts[0] === 'package.json') {
      try {
        const pkg = JSON.parse(data.toString('utf8'));
        meta.license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(' OR ') : null);
        meta.repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? null;
        meta.authors = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name ?? null;
      } catch {}
    }
    if (parts.length === 1 && parts[0] === 'Cargo.toml') {
      const pkgSection = (/^\[package\]([\s\S]*?)(?:^\[|(?![\s\S]))/m.exec(data.toString('utf8')) || [])[1] ?? '';
      meta.license = (/^license\s*=\s*"([^"]+)"/m.exec(pkgSection) || [])[1] ?? ((/^license-file\s*=\s*"([^"]+)"/m.exec(pkgSection) || [])[1] ? 'see licence file' : null);
      meta.repository = (/^repository\s*=\s*"([^"]+)"/m.exec(pkgSection) || [])[1] ?? null;
      const authors = (/^authors\s*=\s*\[([^\]]*)\]/m.exec(pkgSection) || [])[1];
      meta.authors = authors ? [...authors.matchAll(/"([^"]+)"/g)].map((m) => m[1].replace(/\s*<[^>]*>/, '')).join(', ') || null : null;
    }
    if (!parts.length || parts.length > maxDepth || !LICENCE_FILE.test(parts.at(-1))) continue;
    if (parts.some((p) => /^(tests?|testdata|examples?|fuzz|benches)$/i.test(p))) continue;
    files.push({ name: parts.join('/'), data, url });
  }
  if (!files.length && readme) {
    const section = readmeLicenceSection(readme.data.toString('utf8'));
    if (section) files.push({ name: `${readme.name} (licence section)`, data: Buffer.from(section, 'utf8'), url: `${url} (${readme.name})` });
  }
  return { tarballSha256: sha256(gz), files: files.sort((a, b) => a.name.localeCompare(b.name)), meta };
}

/** Licence file at the default branch of a GitHub repository (last resort for packages that ship none). */
async function fetchRepositoryLicence(repository) {
  const m = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/.exec(String(repository ?? ''));
  if (!m) return null;
  for (const file of ['LICENSE', 'LICENSE-MIT', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'license']) {
    const url = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/${file}`;
    const data = await get(url);
    if (data) return { name: `${file} (repository default branch)`, data, url };
  }
  return null;
}

/** Repository URL from the registry metadata of an npm package or crate version. */
async function repositoryOf(c) {
  const url = c.group === 'bundled' ? `https://registry.npmjs.org/${c.name}/${c.version}` : `https://crates.io/api/v1/crates/${c.name}/${encodeURIComponent(c.version)}`;
  const body = await get(url);
  if (!body) return null;
  const meta = JSON.parse(body.toString('utf8'));
  const repo = c.group === 'bundled' ? meta.repository : meta.version?.repository ?? meta.crate?.repository;
  return typeof repo === 'string' ? repo : repo?.url ?? null;
}

// ── component list ────────────────────────────────────────────────────────────
const native = readNativeSnapshot();
if (!native) {
  console.error('docs/licenses/native-components.json is missing: run node scripts/licenses.mjs on macOS first');
  process.exit(1);
}

/** --librsvg-crates: the crates librsvg-c links for the shipped targets, from `cargo tree`. */
async function computeLibrsvgCrates(version) {
  const cargoBin = join(homedir(), '.cargo', 'bin');
  const env = { ...process.env, PATH: `${cargoBin}${delimiter}${process.env.PATH ?? ''}` };
  if (spawnSync('cargo', ['--version'], { env, encoding: 'utf8' }).status !== 0) throw new Error('cargo is not installed (https://rustup.rs); it is only needed for --librsvg-crates');
  const work = mkdtempSync(join(tmpdir(), 'orbitdrop-librsvg-'));
  try {
    await librsvgCratesIn(work, version, env);
  } finally {
    rmSync(work, { recursive: true, force: true }); // this run's own temporary folder (source + cargo cache)
  }
}
async function librsvgCratesIn(work, version, env) {
  const archive = `https://gitlab.gnome.org/GNOME/librsvg/-/archive/${version}/librsvg-${version}.tar.gz`;
  const gz = await get(archive);
  if (!gz) throw new Error(`${archive} not found`);
  // Regular files only, no absolute or parent-relative paths (cargo needs the declared targets to exist).
  for (const { name, data } of tarEntries(gz)) {
    const parts = name.split('/').slice(1);
    if (!parts.length || name.startsWith('/') || parts.some((p) => p === '..' || p === '')) continue;
    const dest = join(work, 'src', ...parts);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  }
  const crates = new Map();
  for (const target of LIBRSVG_TARGETS) {
    const r = spawnSync('cargo', ['tree', '--manifest-path', join(work, 'src', 'Cargo.toml'), '-p', 'librsvg-c', '--target', target, '-e', 'normal', '--prefix', 'none', '--format', '{p}', '--locked'], {
      cwd: work,
      env: { ...env, CARGO_HOME: join(work, 'cargo-home') },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`cargo tree --target ${target} failed: ${r.stderr.split('\n').slice(-4).join(' | ')}`);
    for (const line of r.stdout.split('\n')) {
      const m = /^(\S+) v(\S+?)(?: \(proc-macro\))?(?: \(\*\))?$/.exec(line.trim());
      if (!m || line.includes('(/')) continue; // skip librsvg's own workspace crates (local paths)
      const key = `${m[1]}@${m[2]}`;
      if (!crates.has(key)) crates.set(key, { name: m[1], version: m[2], targets: [] });
      if (!crates.get(key).targets.includes(target)) crates.get(key).targets.push(target);
    }
  }
  const list = [...crates.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  writeFileSync(
    LIBRSVG_CRATES,
    `${JSON.stringify(
      {
        $comment: 'Generated by node scripts/licenses-fetch.mjs --librsvg-crates: cargo tree -p librsvg-c -e normal --locked per target, on librsvg\'s source at the version bundled in libvips (default features).',
        librsvg: version,
        source: archive,
        targets: LIBRSVG_TARGETS,
        crates: list,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`librsvg ${version}: ${list.length} crates for ${LIBRSVG_TARGETS.join(', ')} → ${LIBRSVG_CRATES.slice(ROOT.length + 1)}`);
}
if (process.argv.includes('--librsvg-crates')) {
  await computeLibrsvgCrates(native.libvips.versions.rsvg);
  process.exit(0);
}
const components = [];
const versions = native.libvips.versions;
for (const [key, version] of Object.entries(versions)) {
  const src = LIBVIPS_SOURCES[key];
  if (!src) {
    console.error(`no licence source for libvips component "${key}" ${version}: add it to LIBVIPS_SOURCES in scripts/licenses-sources.mjs`);
    process.exitCode = 1;
    continue;
  }
  components.push({ group: 'libvips', name: src.name, version, license: src.license, kind: 'files', files: src.files, extra: { v: version } });
}
components.push({ group: 'libvips', name: LIBNSGIF.name, version: `libvips-${versions.vips}`, license: LIBNSGIF.license, kind: 'files', files: LIBNSGIF.files, extra: { v: versions.vips, vips: versions.vips } });
components.push({ group: 'canvas', name: SKIA.name, version: 'main', license: SKIA.license, kind: 'files', files: SKIA.files, extra: { v: 'main' } });
for (const c of native.canvas.components) {
  if (isCommit(c.version)) {
    const src = CANVAS_NATIVE_SOURCES[c.name];
    if (!src) {
      console.error(`no licence source for @napi-rs/canvas component ${c.name}@${c.version}: add it to CANVAS_NATIVE_SOURCES`);
      process.exitCode = 1;
      continue;
    }
    components.push({ group: 'canvas', name: c.name, version: c.version, license: c.license, kind: 'files', files: src.files, extra: { v: c.version } });
  } else {
    components.push({ group: 'canvas', name: c.name, version: c.version, license: c.license, kind: 'tarball', url: crateUrl(c.name, c.version), maxDepth: 6 });
  }
}
// Rust's standard library (linked into librsvg and @napi-rs/canvas).
components.push({ group: 'rust', name: RUST_STD.name, version: 'stable', license: RUST_STD.license, kind: 'files', files: RUST_STD.files, extra: { v: 'stable' } });
// Crates linked into librsvg (docs/licenses/librsvg-crates.json, from --librsvg-crates).
if (!existsSync(LIBRSVG_CRATES)) {
  console.error('docs/licenses/librsvg-crates.json is missing: run node scripts/licenses-fetch.mjs --librsvg-crates (needs cargo)');
  process.exitCode = 1;
} else {
  const rsvg = JSON.parse(readFileSync(LIBRSVG_CRATES, 'utf8'));
  if (rsvg.librsvg !== versions.rsvg) {
    console.error(`docs/licenses/librsvg-crates.json lists librsvg ${rsvg.librsvg}, libvips bundles ${versions.rsvg}: run node scripts/licenses-fetch.mjs --librsvg-crates`);
    process.exitCode = 1;
  }
  for (const c of rsvg.crates) components.push({ group: 'librsvg', name: c.name, version: c.version, license: null, kind: 'tarball', url: crateUrl(c.name, c.version), maxDepth: 6 });
}

// npm packages compiled into shipped files
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pkgDir = (name) => join(ROOT, 'node_modules', ...name.split('/'));
const hosts = ['docx', 'pdfjs-dist'].filter((n) => existsSync(join(pkgDir(n), 'package.json'))).map((n) => ({ name: n, version: readJson(join(pkgDir(n), 'package.json')).version, dir: pkgDir(n) }));
const inlined = scanInlinedModules(hosts);
const lockfiles = new Map();
async function hostLock(host, version) {
  if (host !== 'docx') return null;
  const key = `${host}@${version}`;
  if (!lockfiles.has(key)) {
    const res = await fetchText([`https://raw.githubusercontent.com/dolanmiu/docx/{v}/package-lock.json`, `https://raw.githubusercontent.com/dolanmiu/docx/v{v}/package-lock.json`], { v: version });
    lockfiles.set(key, res ? { url: res.url, lock: JSON.parse(res.data.toString('utf8')) } : null);
  }
  return lockfiles.get(key);
}
for (const m of inlined) {
  let version = null;
  let versionSource = null;
  if (m.name === 'core-js') {
    version = coreJsVersion(join(pkgDir(m.host), 'legacy', 'build', 'pdf.mjs'));
    versionSource = 'core-js banner in pdfjs-dist/legacy/build/pdf.mjs';
  } else {
    const lock = await hostLock(m.host, m.hostVersion);
    const entry = lock?.lock.packages?.[`node_modules/${m.chain}`];
    version = entry?.version ?? null;
    versionSource = lock ? `${m.host} ${m.hostVersion} package-lock.json (${lock.url})` : null;
  }
  if (!version) {
    console.error(`cannot determine the version of ${m.chain} compiled into ${m.host} ${m.hostVersion}`);
    process.exitCode = 1;
    continue;
  }
  const base = m.name.split('/').pop();
  components.push({ group: 'bundled', name: m.name, version, license: null, kind: 'tarball', url: `https://registry.npmjs.org/${m.name}/-/${base}-${version}.tgz`, maxDepth: 1, host: `${m.host}@${m.hostVersion}`, chain: m.chain, versionSource, files: m.files });
}

// ── fetch ─────────────────────────────────────────────────────────────────────
const previous = new Map(readUpstreamIndex().components.map((c) => [`${c.group}/${c.name}@${c.version}`, c]));
const index = [];
let fetched = 0;
let reused = 0;
const failures = [];
const limit = 6;
const queue = [...components];
async function worker() {
  for (let c = queue.shift(); c; c = queue.shift()) {
    const key = `${c.group}/${c.name}@${c.version}`;
    const dir = join(UPSTREAM_DIR, c.group, safe(`${c.name}@${c.version}`));
    const old = previous.get(key);
    // (--refresh also retries components that only have the NO-LICENCE-FILE placeholder.)
    const intact = old && old.files.length && !old.files.some((f) => f.name.startsWith('(no licence')) && old.files.every((f) => existsSync(join(UPSTREAM_DIR, f.path)) && sha256(readFileSync(join(UPSTREAM_DIR, f.path))) === f.sha256);
    if (intact && !refresh) {
      index.push({ ...old, ...(c.host ? { host: c.host, chain: c.chain, versionSource: c.versionSource, shippedIn: c.files } : {}) });
      reused++;
      continue;
    }
    try {
      const files = [];
      let license = c.license;
      let tarball = null;
      if (c.kind === 'files') {
        for (const [label, candidates] of Object.entries(c.files)) {
          const res = await fetchText(candidates, c.extra);
          if (!res) throw new Error(`${label}: none of ${candidates.length} URL(s) exists`);
          files.push({ name: label, data: res.data, url: res.url });
        }
      } else {
        const res = await fetchTarballLicences(c.url, { maxDepth: c.maxDepth });
        if (!res) throw new Error(`${c.url} not found`);
        tarball = { url: c.url, sha256: res.tarballSha256 };
        files.push(...res.files);
        // Licence id: the SBOM's for canvas crates, otherwise the package's own package.json / Cargo.toml.
        if (!license) license = res.meta.license ?? 'see licence file';
        if (!files.length) {
          const fromRepo = await fetchRepositoryLicence(res.meta.repository ?? (await repositoryOf(c)));
          if (fromRepo) files.push(fromRepo);
        }
        if (!files.length) {
          const authors = res.meta.authors ? ` Authors named in its metadata: ${res.meta.authors}.` : '';
          files.push({ name: NO_LICENCE_FILE, data: Buffer.from(`No licence text is published with ${c.name} ${c.version} (${c.url}) or in its repository; its metadata declares the licence ${license}.${authors}\n`), url: c.url });
        }
      }
      mkdirSync(dir, { recursive: true });
      // Files this script wrote for the component before (e.g. a placeholder) that are now replaced.
      for (const f of old?.files ?? []) {
        const stalePath = join(UPSTREAM_DIR, f.path);
        if (!files.some((n) => join(dir, fileSlug(n.name)) === stalePath) && existsSync(stalePath)) unlinkSync(stalePath);
      }
      const entry = { group: c.group, name: c.name, version: c.version, license, ...(tarball ? { tarball } : {}), files: [] };
      if (c.host) Object.assign(entry, { host: c.host, chain: c.chain, versionSource: c.versionSource, shippedIn: c.files });
      for (const f of files) {
        // LF line endings, as git stores them (.gitattributes: text=auto eol=lf), so the recorded
        // SHA-256 still matches after a commit and a checkout on any OS.
        if (!f.data.includes(0)) f.data = Buffer.from(f.data.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
        const path = join(dir, fileSlug(f.name));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.data);
        entry.files.push({ name: f.name, path: `${c.group}/${safe(`${c.name}@${c.version}`)}/${fileSlug(f.name)}`, source: f.url, sha256: sha256(f.data) });
      }
      index.push(entry);
      fetched++;
      process.stdout.write(`  fetched ${key} (${files.length} file${files.length === 1 ? '' : 's'})\n`);
    } catch (err) {
      failures.push(`${key}: ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: limit }, worker));

index.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
writeFileSync(
  UPSTREAM_INDEX,
  `${JSON.stringify(
    {
      $comment: 'Generated by scripts/licenses-fetch.mjs; read by scripts/licenses.mjs. Licence texts of shipped components whose npm packages do not include them.',
      components: index,
    },
    null,
    2,
  )}\n`,
);
const live = new Set(index.flatMap((c) => c.files.map((f) => f.path.split('/').slice(0, 2).join('/'))));
const stale = [];
for (const group of existsSync(UPSTREAM_DIR) ? readdirSync(UPSTREAM_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()) : []) {
  for (const d of readdirSync(join(UPSTREAM_DIR, group.name))) if (!live.has(`${group.name}/${d}`)) stale.push(`${group.name}/${d}`);
}
console.log(`licence snapshot: ${index.length} components (${fetched} fetched, ${reused} unchanged) → ${UPSTREAM_INDEX.slice(ROOT.length + 1)}`);
if (stale.length) console.warn(`⚠ no longer referenced (delete them): ${stale.map((s) => `docs/licenses/upstream/${s}`).join(', ')}`);
if (failures.length) {
  console.error(`✖ could not fetch:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
}
