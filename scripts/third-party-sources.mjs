#!/usr/bin/env node
// Builds OrbitDrop-<version>-third-party-sources.tar.gz, the corresponding-source archive that is
// attached to every GitHub release: the exact upstream sources of every LGPL- or MPL-licensed
// component inside the shipped packages (macOS arm64/x64, Windows x64), the patches and build
// scripts used to build those binaries, a MANIFEST.md and the licence texts.
//
//   node scripts/third-party-sources.mjs              # → apps/desktop/release/
//   node scripts/third-party-sources.mjs --out <dir>  # → <dir>
//   node scripts/third-party-sources.mjs --list       # print the manifest; downloads no archive
//
// What ships is derived from the installed packages and the build inputs they name:
//   * targets: the mac/win targets and architectures in apps/desktop/electron-builder.yml;
//   * libvips: versions.json of the per-target sharp package that carries libvips (installed copy,
//     else its npm tarball, checked against pnpm-lock.yaml). The libraries, and the patches applied
//     to them, come from the sharp-libvips build scripts at the tag of that release: build/posix.sh
//     downloads them for macOS; build/win.sh takes the Windows DLL from libvips/build-win64-mxe,
//     whose MXE package pins must name the same archives (checked when building);
//   * librsvg's crates: docs/licenses/librsvg-crates.json (cargo tree), checksums from its Cargo.lock;
//   * @napi-rs/canvas: the CycloneDX SBOM of each per-target package;
//   * FFmpeg: Electron's DEPS (Chromium version) → Chromium's DEPS (FFmpeg revision); Electron's own
//     patches/ffmpeg and GN args come with the Electron source archive.
// Licences: the sharp-libvips licence table and scripts/licenses-sources.mjs (libvips libraries),
// the SBOM (canvas crates), docs/licenses/upstream/index.json (librsvg crates).
//
// Network: Node's fetch only. Archives are streamed into a temporary folder, hashed, checked against
// every published SHA-256 (checksum files, GitHub release digests, crates.io index, Cargo.lock,
// SBOM, npm integrity, the Windows build's pins) and copied into the cache
// apps/desktop/release/.third-party-cache (gitignored). Nothing downloaded is executed or unpacked
// to disk; archives are only read in memory (licence files, build pins, version checks).
// Exit status 1 when a shipped LGPL/MPL component cannot be matched to an exact upstream version or
// a download does not match a published SHA-256; no archive is written then. GITHUB_TOKEN, when
// set, is sent to api.github.com only (release digests; avoids the anonymous rate limit).
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, inflateRawSync } from 'node:zlib';
import { DESKTOP, ISSUES_URL, LIBRSVG_CRATES, LIBVIPS_SOURCES, NATIVE_SNAPSHOT, RELEASES_URL, ROOT, UPSTREAM_DIR, readUpstreamIndex, sourcesArchiveName } from './licenses-sources.mjs';

const USAGE = 'usage: node scripts/third-party-sources.mjs [--out <dir>] [--list]';
let listMode = false;
let outDir = join(DESKTOP, 'release');
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--list') listMode = true;
  else if (a === '--out' && process.argv[i + 1]) outDir = resolve(process.argv[++i]);
  else if (a === '--help' || a === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}
const CACHE = join(DESKTOP, 'release', '.third-party-cache');
const RELEASES = RELEASES_URL;
const ISSUES = ISSUES_URL;

// ── the few facts that cannot be derived ─────────────────────────────────────
const OS_LABEL = { darwin: 'macOS', win32: 'Windows' };
// Rust target triple per shipped target (librsvg-crates.json lists crates per triple; the Windows
// libvips is built with llvm-mingw, hence gnullvm).
const RUST_TRIPLE = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-gnullvm' };
// Where Electron's runtime keeps Chromium's FFmpeg (Electron's own layout; the runtime zip is not
// part of the npm package) and the matching folders of Chromium's FFmpeg configs.
const FFMPEG_BINARY = { darwin: 'Contents/Frameworks/Electron Framework.framework/Libraries/libffmpeg.dylib', win32: 'ffmpeg.dll (next to OrbitDrop.exe)' };
const FFMPEG_CONFIG_OS = { darwin: 'mac', win32: 'win' };
// libvips/build-win64-mxe plugin folders that its build.sh enables for the "web … static" build
// sharp uses (defaults: mozjpeg, zlib-ng, the web variant, proxy-libintl; not ffi-compat, hevc,
// jpegli, gtk4 or nightly), in build.sh's order. MXE reads its own src/ first, then build/, then
// these; a later definition of a package wins.
const MXE_PLUGINS = ['mozjpeg', 'zlib-ng', 'web-deps', 'proxy-libintl'];

// ── helpers ──────────────────────────────────────────────────────────────────
const problems = [];
const fail = (msg) => problems.push(msg);
const log = (msg) => process.stderr.write(`${msg}\n`);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const short = (sha) => String(sha).slice(0, 12);
const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
const safe = (s) => String(s).replace(/[^A-Za-z0-9@._+-]/g, '_');
const relRoot = (p) => relative(ROOT, p).split('\\').join('/');
const uniq = (xs) => [...new Set(xs)];
const targetLabel = (t) => `${OS_LABEL[t.split('-')[0]] ?? t.split('-')[0]} ${t.split('-').slice(1).join('-')}`;
const targetsLabel = (ts) => ts.map(targetLabel).join(', ');

function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}
function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), base) : [relative(base, join(dir, e.name)).split('\\').join('/')]));
}

/**
 * Licence class of an SPDX-like expression: 'permissive' when some alternative is free of copyleft,
 * 'weak' (LGPL/MPL — in scope) when every alternative is copyleft and one is weak, else 'strong'.
 */
function licenceClass(expr) {
  const alternatives = String(expr)
    .replace(/\(or ([^)]+)\)/gi, ' OR $1')
    .replace(/[()]/g, ' ')
    .split(/\s+OR\s+|\s*\/\s*(?=[A-Z])/i);
  const weak = /\bLGPL|Lesser General Public|Library General Public|\bMPL\b|MPL-|Mozilla Public License|\bEPL-|\bCDDL/i;
  const strong = /\b(A?GPL)(?:v?\d|-|\b)|GNU General Public License/i;
  if (alternatives.some((a) => !weak.test(a) && !strong.test(a.replace(/\bLGPL/gi, '')))) return 'permissive';
  return alternatives.some((a) => weak.test(a) && !strong.test(a.replace(/\bLGPL/gi, ''))) ? 'weak' : 'strong';
}

// ── network ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function headersFor(url) {
  const h = { 'user-agent': 'orbitdrop-third-party-sources' };
  if (process.env.GITHUB_TOKEN && url.startsWith('https://api.github.com/')) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}
/** GET with retries (network errors, 5xx, 429). Returns null for a 404 when `optional`. */
async function request(url, { optional = false, timeout = 120_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { redirect: 'follow', headers: headersFor(url), signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      lastError = err;
      await sleep(1500 * attempt);
      continue;
    }
    if (res.ok) return res;
    await res.body?.cancel();
    if (res.status === 404 && optional) return null;
    lastError = new Error(`HTTP ${res.status}`);
    if (res.status < 500 && res.status !== 429) break;
    await sleep(1500 * attempt);
  }
  throw new Error(`${url}: ${lastError?.message}`);
}
// Small, version-pinned metadata (raw files at a tag, checksum files, index entries) is cached too.
const META = join(CACHE, 'meta');
const MISSING = '\u0000missing\u0000';
async function getText(url, { optional = false, cache = true } = {}) {
  const file = join(META, `${sha256(url).slice(0, 32)}.txt`);
  if (cache && existsSync(file)) {
    const t = readFileSync(file, 'utf8');
    return t === MISSING ? null : t;
  }
  const res = await request(url, { optional });
  const text = res ? await res.text() : null;
  if (cache) {
    mkdirSync(META, { recursive: true });
    writeFileSync(file, text ?? MISSING);
  }
  return text;
}
const rawGitHub = (repo, ref, path) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
const githubRepo = (url) => /github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(String(url ?? ''))?.[1] ?? null;

/** Refs advertised by a git server (smart HTTP): Map(ref → commit). Not cached: branches move. */
async function gitRefs(repoUrl) {
  const res = await request(`${repoUrl}.git/info/refs?service=git-upload-pack`);
  const b = Buffer.from(await res.arrayBuffer());
  const refs = new Map();
  for (let off = 0; off + 4 <= b.length; ) {
    const len = parseInt(b.toString('latin1', off, off + 4), 16);
    if (Number.isNaN(len)) break;
    if (len < 4) {
      off += 4;
      continue;
    }
    const m = /^([0-9a-f]{40}) ([^\0\n]+)/.exec(b.toString('latin1', off + 4, off + len));
    if (m) refs.set(m[2], m[1]);
    off += len;
  }
  return refs;
}
const tagCommit = (refs, tag) => refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null;

async function githubReleaseAssets(repo, tag) {
  try {
    return JSON.parse(await getText(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)).assets ?? [];
  } catch (err) {
    log(`  ⚠ GitHub release ${repo} ${tag}: ${err.message} (its asset digests are not used)`);
    return null;
  }
}
function parseSums(text) {
  const sums = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^([0-9a-fA-F]{64})(?:\s+\*?(\S+))?\s*$/.exec(line.trim()) ?? /^SHA256 \(([^)]+)\) = ([0-9a-fA-F]{64})$/.exec(line.trim());
    if (!m) continue;
    if (/^[0-9a-fA-F]{64}$/.test(m[1])) sums.set(m[2] ? basename(m[2]) : '', m[1].toLowerCase());
    else sums.set(basename(m[1]), m[2].toLowerCase());
  }
  return sums;
}
/** SHA-256 values the upstream publishes for a download URL: [{ sha256, from }]. */
async function publishedHashes(url) {
  const out = [];
  const name = basename(new URL(url).pathname);
  let m;
  if ((m = /^https:\/\/download\.gnome\.org\/sources\/[^/]+\/[^/]+\//.exec(url))) {
    const sumUrl = `${m[0]}${name.replace(/\.tar\.(xz|gz|bz2)$/, '')}.sha256sum`;
    const h = parseSums(await getText(sumUrl, { optional: true })).get(name);
    if (h) out.push({ sha256: h, from: sumUrl });
  } else if (/^https:\/\/cairographics\.org\/releases\//.test(url)) {
    const sumUrl = `${url}.sha256sum`;
    const h = parseSums(await getText(sumUrl, { optional: true })).get(name);
    if (h) out.push({ sha256: h, from: sumUrl });
  } else if ((m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url))) {
    const assets = await githubReleaseAssets(m[1], decodeURIComponent(m[2]));
    const asset = assets?.find((a) => a.name === m[3]);
    if (asset?.digest?.startsWith('sha256:')) out.push({ sha256: asset.digest.slice(7), from: `GitHub release asset digest (${m[1]} ${decodeURIComponent(m[2])})` });
    for (const ext of ['.sha256sum', '.sha256']) {
      const sumAsset = assets?.find((a) => a.name === `${m[3]}${ext}`);
      if (!sumAsset) continue;
      const sums = parseSums(await getText(sumAsset.browser_download_url));
      const h = sums.get(m[3]) ?? sums.get('');
      if (h) out.push({ sha256: h, from: sumAsset.browser_download_url });
    }
  }
  return out;
}

// crates.io: the sparse index publishes each crate file's SHA-256 ("cksum").
const crateUrl = (name, version) => `https://static.crates.io/crates/${name}/${encodeURIComponent(`${name}-${version}.crate`)}`;
function crateIndexPath(name) {
  const n = name.toLowerCase();
  return n.length <= 2 ? `${n.length}/${n}` : n.length === 3 ? `3/${n[0]}/${n}` : `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}
async function crateIndexHash(name, version) {
  const url = `https://index.crates.io/${crateIndexPath(name)}`;
  const text = await getText(url, { optional: true });
  const entry = String(text ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((e) => e.vers === version);
  return entry?.cksum ? { sha256: entry.cksum, from: `crates.io index (${url})`, yanked: entry.yanked } : null;
}

const npmTarballUrl = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
async function npmMeta(name, version) {
  return JSON.parse(await getText(`https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`));
}
const lockText = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
function lockIntegrity(name, version) {
  const key = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`\\n  '?${key}'?:\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`).exec(lockText)?.[1] ?? null;
}

// ── archives (read in memory, never extracted) ───────────────────────────────
function paxRecords(buf) {
  const out = {};
  for (let off = 0; off < buf.length; ) {
    const sp = buf.indexOf(0x20, off);
    const len = parseInt(buf.toString('latin1', off, sp), 10);
    if (!(len > 0) || sp < 0) break;
    const rec = buf.toString('utf8', sp + 1, off + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    off += len;
  }
  return out;
}
/** Streams a .tar.gz: { comment (pax global, e.g. GitHub's commit id), names[], files: Map(name → Buffer) } for want(name). */
async function readTarGz(file, want = () => false) {
  const files = new Map();
  const names = [];
  let comment = null;
  let header = Buffer.alloc(0);
  let mode = 'header';
  let left = 0;
  let parts = [];
  let entry = null;
  let longName = null;
  let paxPath = null;
  for await (const chunk of createReadStream(file).pipe(createGunzip())) {
    let c = chunk;
    while (c.length) {
      if (mode !== 'header') {
        const n = Math.min(left, c.length);
        if (mode === 'data') parts.push(c.subarray(0, n));
        left -= n;
        c = c.subarray(n);
        if (left) continue;
        if (mode === 'data') {
          const data = Buffer.concat(parts).subarray(0, entry.size);
          if (entry.type === 'L') longName = data.toString('utf8').replace(/\0[\s\S]*$/, '');
          else if (entry.type === 'x') paxPath = paxRecords(data).path ?? null;
          else if (entry.type === 'g') comment = paxRecords(data).comment ?? comment;
          else files.set(entry.name, data);
        }
        mode = 'header';
        parts = [];
        continue;
      }
      const need = 512 - header.length;
      header = Buffer.concat([header, c.subarray(0, need)]);
      c = c.subarray(need);
      if (header.length < 512) break;
      const h = header;
      header = Buffer.alloc(0);
      if (h.every((b) => b === 0)) continue;
      const field = (s, e) => h.toString('utf8', s, e).replace(/\0[\s\S]*$/, '');
      let name = field(0, 100);
      const prefix = field(345, 500);
      if (prefix && h.toString('latin1', 257, 262) === 'ustar') name = `${prefix}/${name}`;
      const size = parseInt(field(124, 136).trim() || '0', 8);
      const type = String.fromCharCode(h[156] || 48);
      left = Math.ceil(size / 512) * 512;
      if (type === 'L' || type === 'x' || type === 'g') {
        entry = { type, size };
        mode = left ? 'data' : 'header';
        continue;
      }
      if (longName) [name, longName] = [longName, null];
      if (paxPath) [name, paxPath] = [paxPath, null];
      name = name.replace(/^\.\//, '');
      const regular = type === '0' || type === '\0' || type === '7';
      if (regular) names.push(name);
      entry = { type, name, size };
      mode = !left ? 'header' : regular && want(name) ? 'data' : 'skip';
      if (regular && !left && want(name)) files.set(name, Buffer.alloc(0));
    }
  }
  return { comment, names, files };
}
/** The pax global comment of a .tar.gz (GitHub writes the commit id there), reading only its start. */
async function tarComment(file) {
  const src = createReadStream(file);
  const gunzip = src.pipe(createGunzip());
  let buf = Buffer.alloc(0);
  for await (const chunk of gunzip) {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length >= 1024) break;
  }
  gunzip.destroy();
  src.destroy();
  if (buf.length < 1024 || String.fromCharCode(buf[156]) !== 'g') return null;
  const size = parseInt(buf.toString('latin1', 124, 136).replace(/\0[\s\S]*$/, '').trim() || '0', 8);
  return paxRecords(buf.subarray(512, 512 + Math.min(size, 512))).comment ?? null;
}
/** One entry of a .zip (central directory; stored or deflated). */
function zipEntry(buf, test) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (test(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      return { name, data: method === 0 ? raw : inflateRawSync(raw) };
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// ── downloads (temporary folder → verified → cache) ──────────────────────────
const CACHE_FILES = join(CACHE, 'files');
const CACHE_INDEX = join(CACHE, 'files.json');
const cacheIndex = existsSync(CACHE_INDEX) ? readJson(CACHE_INDEX) : {};
function saveCacheIndex() {
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(CACHE_INDEX, `${JSON.stringify(Object.fromEntries(Object.entries(cacheIndex).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
}
async function hashFile(file) {
  const h256 = createHash('sha256');
  const h512 = createHash('sha512');
  for await (const chunk of createReadStream(file)) {
    h256.update(chunk);
    h512.update(chunk);
  }
  return { sha256: h256.digest('hex'), sha512: `sha512-${h512.digest('base64')}` };
}
function checkDownload(f, got) {
  const bad = [];
  for (const p of f.published ?? []) if (p.sha256 !== got.sha256) bad.push(`SHA-256 ${got.sha256} ≠ ${p.sha256} published by ${p.from}`);
  if (f.integrity && f.integrity !== got.sha512) bad.push(`integrity ${got.sha512} ≠ ${f.integrity}`);
  if (bad.length) throw new Error(`${f.url}: ${bad.join('; ')}`);
}
/** Ensures `f.url` is in the cache and matches what is published for it; sets f.local, f.sha256, f.size. */
async function fetchFile(f) {
  const cached = cacheIndex[f.url];
  if (cached && existsSync(join(CACHE_FILES, cached.file))) {
    const local = join(CACHE_FILES, cached.file);
    const got = await hashFile(local);
    if (got.sha256 === cached.sha256) {
      checkDownload(f, got);
      Object.assign(f, { local, sha256: got.sha256, size: statSync(local).size, cached: true });
      return f;
    }
  }
  const tmp = mkdtempSync(join(tmpdir(), 'orbitdrop-sources-'));
  try {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const dest = join(tmp, `download-${attempt}`);
      try {
        const res = await request(f.url, { timeout: 30 * 60_000 });
        const h256 = createHash('sha256');
        const h512 = createHash('sha512');
        let size = 0;
        const out = createWriteStream(dest);
        for await (const chunk of Readable.fromWeb(res.body)) {
          h256.update(chunk);
          h512.update(chunk);
          size += chunk.length;
          if (!out.write(chunk)) await once(out, 'drain');
        }
        out.end();
        await finished(out);
        const got = { sha256: h256.digest('hex'), sha512: `sha512-${h512.digest('base64')}` };
        checkDownload(f, got);
        mkdirSync(CACHE_FILES, { recursive: true });
        const file = `${got.sha256.slice(0, 16)}-${safe(basename(f.path ?? f.url))}`;
        copyFileSync(dest, join(CACHE_FILES, file));
        cacheIndex[f.url] = { file, sha256: got.sha256, size };
        saveCacheIndex();
        Object.assign(f, { local: join(CACHE_FILES, file), sha256: got.sha256, size, cached: false });
        log(`  downloaded ${f.url} (${mb(size)})`);
        return f;
      } catch (err) {
        lastError = err;
        if (/published by|integrity/.test(err.message)) break; // a mismatch is not retried
        await sleep(2000 * attempt);
      }
    }
    throw lastError;
  } finally {
    rmSync(tmp, { recursive: true, force: true }); // this run's own temporary folder
  }
}
async function pool(items, limit, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await fn(item);
  }));
}

// ── model ────────────────────────────────────────────────────────────────────
// bundle: files under sources/ — { path, url, title, kind, published[], pins[], integrity, notes[] }.
// components: the LGPL/MPL components — { name, version, license, via, targets[], files[], note }.
const bundle = new Map();
function addFile(f) {
  if (!bundle.has(f.path)) bundle.set(f.path, { published: [], pins: [], notes: [], ...f });
  const existing = bundle.get(f.path);
  if (existing.url !== f.url) fail(`two sources for ${f.path}: ${existing.url} and ${f.url}`);
  return existing;
}
const components = [];
const notMirrored = { libvips: [], chromium: null };

const desktopPkg = readJson(join(DESKTOP, 'package.json'));
const productName = desktopPkg.productName ?? 'OrbitDrop';
const archiveBase = sourcesArchiveName(desktopPkg).replace(/\.tar\.gz$/, '');
const snapshot = existsSync(NATIVE_SNAPSHOT) ? readJson(NATIVE_SNAPSHOT) : null;
const upstreamIndex = readUpstreamIndex();
const upstreamByKey = new Map(upstreamIndex.components.map((c) => [`${c.group}/${c.name}@${c.version}`, c]));

// ── shipped targets (electron-builder.yml) ───────────────────────────────────
function builderConfig() {
  const abl = createRequire(join(ROOT, 'package.json')).resolve('app-builder-lib/package.json');
  return createRequire(abl)('js-yaml').load(readFileSync(join(DESKTOP, 'electron-builder.yml'), 'utf8'));
}
const targets = [];
{
  const cfg = builderConfig();
  for (const [key, platform] of [['mac', 'darwin'], ['win', 'win32']]) {
    const archs = new Set();
    for (const t of cfg[key]?.target ?? []) for (const a of [].concat(t?.arch ?? [])) archs.add(a);
    for (const a of [...archs].sort()) targets.push(`${platform}-${a}`);
  }
  if (!targets.length) {
    console.error('no mac/win targets in apps/desktop/electron-builder.yml');
    process.exit(1);
  }
}
log(`${archiveBase}: targets ${targets.join(', ')}${listMode ? ' (--list: no archive is downloaded)' : ''}`);

/**
 * Files of a shipped per-target npm package: the installed copy, else (when building) its npm
 * tarball checked against pnpm-lock.yaml. null in --list mode when the package is not installed.
 */
async function packageContents(name, version, want) {
  const dir = resolvePackage(name, ROOT);
  if (dir && readJson(join(dir, 'package.json')).version === version) {
    const names = listFiles(dir);
    return { from: `installed ${relRoot(dir)}`, names, files: new Map(names.filter(want).map((n) => [n, readFileSync(join(dir, n))])) };
  }
  const url = npmTarballUrl(name, version);
  if (listMode && !(cacheIndex[url] && existsSync(join(CACHE_FILES, cacheIndex[url].file)))) return null; // --list downloads nothing
  const integrity = lockIntegrity(name, version);
  if (!integrity) {
    fail(`${name}@${version} is not installed and pnpm-lock.yaml has no integrity for it`);
    return null;
  }
  const f = { url, path: `${name.replace('/', '-')}-${version}.tgz`, integrity };
  await fetchFile(f);
  const tar = await readTarGz(f.local, (n) => want(n.replace(/^package\//, '')));
  return {
    from: `npm tarball ${basename(f.url)} (integrity from pnpm-lock.yaml)`,
    names: tar.names.map((n) => n.replace(/^package\//, '')),
    files: new Map([...tar.files].map(([n, d]) => [n.replace(/^package\//, ''), d])),
  };
}

// ── libvips (sharp) ──────────────────────────────────────────────────────────
const sharpDir = resolvePackage('sharp', DESKTOP);
if (!sharpDir) {
  console.error('sharp is not installed: run pnpm install');
  process.exit(1);
}
const sharpPkg = readJson(join(sharpDir, 'package.json'));
const libvipsTargets = []; // { target, host, hostVersion, buildPkg, buildVersion, versions, binaries, from, contents }
for (const t of targets) {
  const opt = sharpPkg.optionalDependencies ?? {};
  const buildPkg = `@img/sharp-libvips-${t}`;
  const buildVersion = opt[buildPkg] ?? sharpPkg.devDependencies?.[buildPkg]; // the sharp-libvips release the binary comes from
  const host = opt[buildPkg] ? buildPkg : `@img/sharp-${t}`; // the package that ships it
  const hostVersion = opt[host];
  if (!buildVersion || !hostVersion) {
    fail(`sharp ${sharpPkg.version} names no libvips package for ${t}`);
    continue;
  }
  const contents = await packageContents(host, hostVersion, (n) => n === 'versions.json' || (t.startsWith('win32') && /^lib\/libvips[^/]*\.dll$/.test(n)));
  let versions;
  let from;
  if (contents?.files.has('versions.json')) {
    versions = JSON.parse(contents.files.get('versions.json').toString('utf8'));
    from = contents.from;
  } else if (!contents && listMode && snapshot) {
    versions = snapshot.libvips.versions;
    from = `${relRoot(NATIVE_SNAPSHOT)} (not installed; checked against the package when building)`;
  } else {
    fail(`${host}@${hostVersion}: no versions.json`);
    continue;
  }
  const binaries = contents ? contents.names.filter((n) => /^lib\/libvips[^/]*\.(dylib|dll|so[.\d]*)$/.test(n)).sort() : [t.startsWith('win32') ? 'lib/libvips-*.dll' : 'lib/libvips-cpp.*.dylib'];
  libvipsTargets.push({ target: t, host, hostVersion, buildPkg, buildVersion, versions, binaries, from, contents });
}

// Licence of each libvips component: the sharp-libvips licence table (README of the installed
// darwin package, else the committed snapshot) and scripts/licenses-sources.mjs.
const libvipsTable = (() => {
  for (const t of libvipsTargets) {
    const dir = resolvePackage(t.host, ROOT);
    if (dir && existsSync(join(dir, 'README.md'))) {
      const rows = readFileSync(join(dir, 'README.md'), 'utf8')
        .split('\n')
        .filter((l) => /^\|\s*[a-z]/i.test(l) && !/Library\s*\|/.test(l))
        .map((l) =>
          l
            .split('|')
            .slice(1, -1)
            .map((c) => c.trim()),
        );
      if (rows.length) return rows;
    }
  }
  return snapshot?.libvips.table ?? [];
})();
function libvipsLicence(key) {
  const src = LIBVIPS_SOURCES[key];
  const names = [key, `lib${key}`, src?.name].filter(Boolean).map((n) => n.toLowerCase());
  const row = libvipsTable.find(([lib]) => names.includes(lib.toLowerCase()));
  if (!src && !row) return null;
  const classes = [src && licenceClass(src.license), row && licenceClass(row[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'))].filter(Boolean);
  const cls = classes.includes('strong') ? 'strong' : classes.includes('weak') ? 'weak' : 'permissive';
  return { license: src?.license ?? row[1].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'), table: row?.[1], cls, name: src?.name ?? key };
}

/** sharp-libvips build/posix.sh: versions.json key ↔ VERSION_* variable, source downloads and patches. */
function parsePosixBuild(text) {
  const keyOfVar = new Map();
  for (const m of text.matchAll(/\\"([\w-]+)\\": \\"\$\{(VERSION_\w+)\}\\"/g)) keyOfVar.set(m[2], m[1]);
  const downloads = [];
  let current = null;
  for (const line of text.split('\n')) {
    const cd = /^\s*cd \$\{DEPS\}\/([\w.-]+)/.exec(line);
    if (cd) current = downloads.findLast((d) => d.dir === cd[1]) ?? current;
    const tar = /\$CURL\s+(.+?)\s*\|\s*tar\s+x\w*C\s+\$\{DEPS\}\/([\w.-]+)/.exec(line);
    if (tar) {
      const vars = uniq([...tar[1].matchAll(/VERSION_\w+/g)].map((v) => v[0].replace(/\W+$/, '')));
      current = downloads.find((d) => d.dir === tar[2] && d.template === tar[1]) ?? { dir: tar[2], template: tar[1], vars, patches: [] };
      if (!downloads.includes(current)) downloads.push(current);
      continue;
    }
    const patch = /\$CURL\s+(.+?)\s*\|\s*patch\b/.exec(line);
    if (patch && current && !current.patches.includes(patch[1])) current.patches.push(patch[1]);
  }
  return { keyOfVar, downloads };
}
/** Expands the shell forms build/posix.sh uses in URLs. */
function expandShell(template, props) {
  const v = (name) => {
    if (!(name in props)) throw new Error(`${name} is not set in versions.properties`);
    return props[name];
  };
  const out = template
    .replace(/\$\(without_patch \$\{?(VERSION_\w+?)\}?\)/g, (m, n) => v(n).replace(/\.\d+$/, ''))
    .replace(/\$\(without_prerelease \$\{?(VERSION_\w+?)\}?\)/g, (m, n) => v(n).replace(/-[A-Za-z0-9]+$/, ''))
    .replace(/\$\{(VERSION_\w+?)\/\/\.\/([^}]*)\}/g, (m, n, r) => v(n).replaceAll('.', r))
    .replace(/\$\{(VERSION_\w+?)\}/g, (m, n) => v(n))
    .replace(/\$(VERSION_\w+)/g, (m, n) => v(n));
  if (out.includes('$')) throw new Error(`cannot expand ${template}`);
  return out;
}
const parseProperties = (text) => Object.fromEntries([...String(text).matchAll(/^(VERSION_\w+)=(\S+)\s*$/gm)].map((m) => [m[1], m[2]]));
const archiveName = (url, fallback) => {
  const b = basename(new URL(url).pathname);
  return b.startsWith(fallback) || !/^v?[\d.]+(\.tar\.\w+|\.tgz|\.zip)$/.test(b) ? b : `${fallback}-${b}`;
};

const libvipsBuilds = []; // per sharp-libvips release: { version, repo, tag, commit, targets, posix, win, ... }
for (const version of uniq(libvipsTargets.map((t) => t.buildVersion))) {
  const group = libvipsTargets.filter((t) => t.buildVersion === version);
  const build = { version, targets: group.map((t) => t.target) };
  libvipsBuilds.push(build);
  // The repository and commit each per-target package was published from (npm metadata).
  const metas = await Promise.all(group.map((t) => npmMeta(t.buildPkg, version)));
  build.repo = uniq(metas.map((m) => githubRepo(m.repository?.url ?? m.repository)).filter(Boolean))[0];
  if (!build.repo) {
    fail(`@img/sharp-libvips-* ${version}: no GitHub repository in the npm metadata`);
    continue;
  }
  build.tag = `v${version}`;
  build.commit = tagCommit(await gitRefs(`https://github.com/${build.repo}`), build.tag);
  if (!build.commit) {
    fail(`${build.repo} has no tag ${build.tag} (sharp-libvips ${version})`);
    continue;
  }
  for (const [i, m] of metas.entries()) {
    if (m.gitHead && m.gitHead !== build.commit) fail(`${group[i].buildPkg}@${version} was published from ${m.gitHead}, not from ${build.repo} ${build.tag} (${build.commit})`);
  }
  const [props, posix, win] = await Promise.all(['versions.properties', 'build/posix.sh', 'build/win.sh'].map((p) => getText(rawGitHub(build.repo, build.tag, p))));
  build.props = parseProperties(props);
  build.posix = parsePosixBuild(posix);
  build.win = win;
  addFile({
    path: `sources/build-scripts/sharp-libvips-${build.tag}.tar.gz`,
    url: `https://github.com/${build.repo}/archive/refs/tags/${build.tag}.tar.gz`,
    kind: 'build',
    title: `sharp-libvips ${build.tag} — build scripts of the macOS libvips (build.sh, build/posix.sh, platforms/darwin-*) and of the Windows packaging (build/win.sh)`,
    expectCommit: build.commit,
  });
  // Every target's versions.json must equal the versions the build scripts used.
  for (const t of group) {
    for (const [varName, key] of build.posix.keyOfVar) {
      if (t.versions[key] !== undefined && t.versions[key] !== build.props[varName]) {
        fail(`${t.target}: ${t.host} ships ${key} ${t.versions[key]}, but sharp-libvips ${build.tag} builds ${build.props[varName]} (${varName})`);
      }
    }
    for (const key of Object.keys(t.versions)) if (![...build.posix.keyOfVar.values()].includes(key)) fail(`${t.target}: libvips component "${key}" is not built by sharp-libvips ${build.tag}/build/posix.sh`);
  }
}

// LGPL/MPL libraries inside libvips: archive + patches from build/posix.sh.
const libvipsComponents = new Map(); // key → component
for (const build of libvipsBuilds.filter((b) => b.posix)) {
  const group = libvipsTargets.filter((t) => t.buildVersion === build.version);
  const keys = uniq(group.flatMap((t) => Object.keys(t.versions))).sort();
  for (const key of keys) {
    const lic = libvipsLicence(key);
    if (!lic) {
      fail(`no licence known for libvips component "${key}": add it to LIBVIPS_SOURCES in scripts/licenses-sources.mjs`);
      continue;
    }
    const varName = [...build.posix.keyOfVar].find(([, k]) => k === key)?.[0];
    if (!varName) continue; // reported above
    const version = build.props[varName];
    const shippedBy = group.filter((t) => t.versions[key] === version).map((t) => t.target);
    const downloads = build.posix.downloads.filter((d) => d.vars.includes(varName));
    if (lic.cls === 'strong') fail(`libvips component ${key} ${version} is licensed ${lic.license} (GPL): not covered by this script`);
    if (lic.cls !== 'weak') {
      const urls = downloads.map((d) => {
        try {
          return expandShell(d.template, build.props);
        } catch {
          return d.template;
        }
      });
      notMirrored.libvips.push({ key, name: lic.name, version, license: lic.license, urls, patches: downloads.flatMap((d) => d.patches) });
      continue;
    }
    if (downloads.length !== 1) {
      fail(`sharp-libvips ${build.tag}/build/posix.sh has ${downloads.length} source downloads for ${key} (${varName}); expected exactly one`);
      continue;
    }
    let url;
    try {
      url = expandShell(downloads[0].template, build.props);
    } catch (err) {
      fail(`${key}: ${err.message}`);
      continue;
    }
    const file = addFile({ path: `sources/libvips/${archiveName(url, lic.name)}`, url, kind: 'source', title: `${lic.name} ${version}`, published: await publishedHashes(url) });
    const patchFiles = downloads[0].patches.map((p, i) =>
      addFile({
        path: `sources/libvips/patches/${lic.name}-${version}/${String(i + 1).padStart(2, '0')}-${safe(basename(new URL(p).pathname))}`,
        url: p,
        kind: 'patch',
        title: `patch applied to ${lic.name} ${version} by sharp-libvips ${build.tag}/build/posix.sh (patch -p1)`,
      }),
    );
    const c = {
      key,
      name: lic.name,
      version,
      license: lic.license,
      table: lic.table,
      via: 'libvips',
      targets: shippedBy,
      files: [file.path, ...patchFiles.map((p) => p.path)],
    };
    components.push(c);
    libvipsComponents.set(key, c);
  }
}

// Windows: build/win.sh unpacks libvips/build-win64-mxe's release; MXE built it.
const winBuild = libvipsBuilds.find((b) => b.win && b.targets.some((t) => t.startsWith('win32')));
if (winBuild) {
  const w = winBuild.win;
  const props = { ...winBuild.props };
  const rel = /github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/"]+)\/\$\{FILENAME\}/.exec(w);
  const fileTemplate = /FILENAME="([^"]+)"/.exec(w)?.[1];
  const archCases = [...w.matchAll(/^\s*([*\w-]+)\)\s*\n\s*ARCH=(\w+)/gm)].map((m) => ({ re: new RegExp(`^${m[1].replaceAll('*', '.*')}$`), arch: m[2] }));
  if (!rel || !fileTemplate) fail(`sharp-libvips ${winBuild.tag}/build/win.sh: cannot find the libvips release it downloads`);
  else {
    const tag = expandShell(rel[2], props);
    winBuild.mxe = { repo: rel[1], tag, targets: winBuild.targets.filter((t) => t.startsWith('win32')) };
    winBuild.mxe.assets = winBuild.mxe.targets.map((t) => {
      const arch = archCases.find((a) => a.re.test(t))?.arch;
      if (!arch) fail(`sharp-libvips ${winBuild.tag}/build/win.sh: no ARCH for ${t}`);
      const name = fileTemplate.replace('${ARCH}', arch ?? '?').replace(/\$\{VERSION_VIPS\}/g, props.VERSION_VIPS);
      return { target: t, name, url: `https://github.com/${rel[1]}/releases/download/${tag}/${name}` };
    });
    const refs = await gitRefs(`https://github.com/${rel[1]}`);
    winBuild.mxe.commit = tagCommit(refs, tag);
    if (!winBuild.mxe.commit) fail(`${rel[1]} has no tag ${tag}`);
    addFile({
      path: `sources/build-scripts/${rel[1].split('/')[1]}-${tag}.tar.gz`,
      url: `https://github.com/${rel[1]}/archive/refs/tags/${tag}.tar.gz`,
      kind: 'build',
      title: `${rel[1]} ${tag} — build scripts, MXE package definitions and patches of the Windows libvips (libvips-42.dll)`,
      expectCommit: winBuild.mxe.commit,
    });
    // The MXE tree its container image clones (container/base.Dockerfile).
    const dockerfile = await getText(rawGitHub(rel[1], tag, 'container/base.Dockerfile'));
    const clone = /git clone\s+-b\s+(\S+)\s+(?:--single-branch\s+)?(https:\/\/github\.com\/\S+?)(?:\.git)?\s/.exec(dockerfile ?? '');
    if (!clone) fail(`${rel[1]} ${tag}/container/base.Dockerfile: cannot find the MXE clone`);
    else {
      const mxeRepo = githubRepo(clone[2]);
      const commit = (await gitRefs(`https://github.com/${mxeRepo}`)).get(`refs/heads/${clone[1]}`);
      if (!commit) fail(`${mxeRepo} has no branch ${clone[1]}`);
      else {
        winBuild.mxe.mxe = { repo: mxeRepo, branch: clone[1], commit };
        addFile({
          path: `sources/build-scripts/${mxeRepo.split('/')[1]}-${short(commit)}.tar.gz`,
          url: `https://github.com/${mxeRepo}/archive/${commit}.tar.gz`,
          kind: 'build',
          title: `MXE (${mxeRepo}, branch ${clone[1]} = commit ${commit}) — the cross-build environment and package recipes ${rel[1]} ${tag} builds with`,
          expectCommit: commit,
        });
      }
    }
  }
  // libvips-cpp-<version>.dll is not part of that release: sharp compiles it (src/binding.gyp,
  // target libvips-cpp-<(vips_version), OS == "win") from @img/sharp-libvips-dev's C++ sources.
  const gyp = existsSync(join(sharpDir, 'src', 'binding.gyp')) ? readFileSync(join(sharpDir, 'src', 'binding.gyp'), 'utf8') : '';
  const devVersion = sharpPkg.devDependencies?.['@img/sharp-libvips-dev'];
  if (/'target_name': 'libvips-cpp-<\(vips_version\)'/.test(gyp) && /OS == "win"[\s\S]*?'type': 'shared_library'/.test(gyp) && devVersion) {
    const devMeta = await npmMeta('@img/sharp-libvips-dev', devVersion);
    winBuild.cpp = { sharp: sharpPkg.version, dev: devVersion, devGitHead: devMeta.gitHead ?? null };
    if (devMeta.gitHead && devVersion === winBuild.version && devMeta.gitHead !== winBuild.commit) fail(`@img/sharp-libvips-dev@${devVersion} was published from ${devMeta.gitHead}, not ${winBuild.repo} ${winBuild.tag}`);
    addFile({
      path: `sources/build-scripts/sharp-${sharpPkg.version}.tgz`,
      url: npmTarballUrl('sharp', sharpPkg.version),
      kind: 'build',
      title: `sharp ${sharpPkg.version} (npm package) — src/binding.gyp builds the Windows libvips C++ binding libvips-cpp-<version>.dll`,
      integrity: lockIntegrity('sharp', sharpPkg.version),
    });
    addFile({
      path: `sources/libvips/sharp-libvips-dev-${devVersion}.tgz`,
      url: npmTarballUrl('@img/sharp-libvips-dev', devVersion),
      kind: 'source',
      title: `@img/sharp-libvips-dev ${devVersion} (npm package) — the libvips C++ binding sources (cplusplus/) and headers sharp ${sharpPkg.version} compiles into libvips-cpp-<version>.dll`,
      integrity: devMeta.dist?.integrity,
    });
    const vips = libvipsComponents.get('vips');
    if (vips) vips.files.push(`sources/libvips/sharp-libvips-dev-${devVersion}.tgz`);
  }
}

// ── librsvg's crates (inside libvips) ────────────────────────────────────────
const crateComponents = new Map(); // name@version → component
async function addCrate({ name, version, license, via, targetsShipping, published }) {
  const key = `${name}@${version}`;
  const file = addFile({ path: `sources/crates/${name}-${version}.crate`, url: crateUrl(name, version), kind: 'crate', title: `${name} ${version} (crates.io)` });
  for (const p of published) if (!file.published.some((x) => x.from === p.from)) file.published.push(p);
  const c = crateComponents.get(key);
  if (c) {
    c.targets = uniq([...c.targets, ...targetsShipping]);
    c.via = uniq([...c.via.split(', '), via]).join(', ');
    return;
  }
  const index = await crateIndexHash(name, version);
  if (!index) fail(`crate ${name} ${version} is not in the crates.io index`);
  else {
    file.published.push(index);
    if (index.yanked) file.notes.push('yanked on crates.io after release (still downloadable)');
  }
  const comp = { name, version, license, via, targets: targetsShipping, files: [file.path] };
  crateComponents.set(key, comp);
  components.push(comp);
}
const rsvg = libvipsComponents.get('rsvg');
if (rsvg) {
  const crates = existsSync(LIBRSVG_CRATES) ? readJson(LIBRSVG_CRATES) : null;
  if (!crates) fail(`${relRoot(LIBRSVG_CRATES)} is missing (node scripts/licenses-fetch.mjs --librsvg-crates)`);
  else if (crates.librsvg !== rsvg.version) fail(`${relRoot(LIBRSVG_CRATES)} lists librsvg ${crates.librsvg}, libvips bundles ${rsvg.version} (node scripts/licenses-fetch.mjs --librsvg-crates)`);
  else {
    const repo = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/-\/archive\//.exec(crates.source)?.[1];
    const lock = repo ? await getText(`${repo}/-/raw/${rsvg.version}/Cargo.lock`, { optional: true }) : null;
    if (!lock) fail(`cannot read librsvg ${rsvg.version}'s Cargo.lock`);
    const locked = new Map([...String(lock).matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\n(?:source = "[^"]+"\n)?(?:checksum = "([0-9a-f]{64})")?/g)].map((m) => [`${m[1]}@${m[2]}`, m[3]]));
    for (const crate of crates.crates) {
      const entry = upstreamByKey.get(`librsvg/${crate.name}@${crate.version}`);
      if (!entry) {
        fail(`no licence recorded for librsvg crate ${crate.name} ${crate.version} (node scripts/licenses-fetch.mjs)`);
        continue;
      }
      const cls = licenceClass(entry.license);
      if (cls === 'strong') fail(`librsvg crate ${crate.name} ${crate.version} is ${entry.license}`);
      if (cls !== 'weak') continue;
      const shipping = rsvg.targets.filter((t) => crate.targets.includes(RUST_TRIPLE[t]));
      const checksum = locked.get(`${crate.name}@${crate.version}`);
      if (!checksum) fail(`librsvg ${rsvg.version}'s Cargo.lock has no checksum for ${crate.name} ${crate.version}`);
      await addCrate({ name: crate.name, version: crate.version, license: entry.license, via: `librsvg ${rsvg.version}`, targetsShipping: shipping, published: checksum ? [{ sha256: checksum, from: `librsvg ${rsvg.version} Cargo.lock` }] : [] });
    }
  }
}

// ── @napi-rs/canvas (Skia + Rust crates, statically linked) ──────────────────
const canvasDir = resolvePackage('@napi-rs/canvas', DESKTOP);
const canvasPkg = canvasDir ? readJson(join(canvasDir, 'package.json')) : null;
const canvasTargets = [];
if (!canvasPkg) fail('@napi-rs/canvas is not installed: run pnpm install');
for (const t of canvasPkg ? targets : []) {
  const name = [`@napi-rs/canvas-${t}`, `@napi-rs/canvas-${t}-msvc`].find((n) => canvasPkg.optionalDependencies?.[n]);
  if (!name) {
    fail(`@napi-rs/canvas ${canvasPkg.version} has no package for ${t}`);
    continue;
  }
  const version = canvasPkg.optionalDependencies[name];
  const contents = await packageContents(name, version, (n) => n === 'sbom.cdx.json' || n === 'package.json');
  let sbom;
  let from;
  if (contents?.files.has('sbom.cdx.json')) {
    sbom = JSON.parse(contents.files.get('sbom.cdx.json').toString('utf8'));
    from = contents.from;
  } else if (!contents && listMode && snapshot) {
    sbom = { components: snapshot.canvas.components.map((c) => ({ type: 'library', name: c.name, version: c.version, purl: /^[0-9a-f]{40}$/.test(c.version) ? '' : `pkg:cargo/${c.name}@${c.version}`, licenses: [{ expression: c.license }] })) };
    from = `${relRoot(NATIVE_SNAPSHOT)} (not installed; checked against the package when building)`;
  } else {
    fail(`${name}@${version}: no sbom.cdx.json`);
    continue;
  }
  const main = contents?.files.has('package.json') ? JSON.parse(contents.files.get('package.json').toString('utf8')).main : null;
  canvasTargets.push({ target: t, name, version, sbom, from, binary: main ?? '*.node' });
}
for (const ct of canvasTargets) {
  for (const c of ct.sbom.components ?? []) {
    if (c.type !== 'library') continue;
    const license = (c.licenses ?? []).map((l) => l.expression ?? l.license?.id ?? l.license?.name).filter(Boolean).join(' AND ') || 'unknown';
    const cls = licenceClass(license);
    if (cls === 'strong') fail(`${ct.name}: ${c.name} ${c.version} is ${license}`);
    if (cls !== 'weak') continue;
    if (!String(c.purl).startsWith('pkg:cargo/')) {
      fail(`${ct.name}: no source rule for ${c.name} ${c.version} (${license}, ${c.purl})`);
      continue;
    }
    const sbomHash = (c.hashes ?? []).find((h) => h.alg === 'SHA-256')?.content;
    await addCrate({ name: c.name, version: c.version, license, via: `@napi-rs/canvas ${ct.version}`, targetsShipping: [ct.target], published: sbomHash ? [{ sha256: sbomHash, from: `${ct.name} ${ct.version} sbom.cdx.json` }] : [] });
  }
}

// ── FFmpeg (Electron → Chromium) ─────────────────────────────────────────────
const electronDir = resolvePackage('electron', DESKTOP);
const electronPkg = electronDir ? readJson(join(electronDir, 'package.json')) : null;
let ffmpeg = null;
if (!electronPkg) fail('electron is not installed: run pnpm install');
else {
  const pinned = desktopPkg.devDependencies?.electron;
  if (pinned && pinned !== electronPkg.version) fail(`apps/desktop pins electron ${pinned}, ${electronPkg.version} is installed`);
  const repo = githubRepo(electronPkg.repository?.url ?? electronPkg.repository) ?? 'electron/electron';
  const tag = `v${electronPkg.version}`;
  const deps = await getText(rawGitHub(repo, tag, 'DEPS'));
  const chromiumVersion = /'chromium_version':\s*'([\d.]+)'/.exec(deps)?.[1];
  const chromiumGit = /'chromium_git':\s*'([^']+)'/.exec(deps)?.[1];
  const srcRepo = /'src':\s*\{\s*'url':\s*\(?Var\("chromium_git"\)\)?\s*\+\s*'([^'@]+?)(?:\.git)?@'/.exec(deps)?.[1];
  if (!chromiumVersion || !chromiumGit || !srcRepo) fail(`Electron ${electronPkg.version} DEPS: cannot find the Chromium version`);
  else {
    const chromiumDeps = Buffer.from(String(await getText(`${chromiumGit}${srcRepo}/+/refs/tags/${chromiumVersion}/DEPS?format=TEXT`)).trim(), 'base64').toString('utf8');
    const dep = /'src\/third_party\/ffmpeg':\s*Var\('chromium_git'\)\s*\+\s*'([^']+?)(?:\.git)?'\s*\+\s*'@'\s*\+\s*(?:Var\('(\w+)'\)|'([0-9a-f]{40})')/.exec(chromiumDeps);
    const revision = dep ? (dep[3] ?? new RegExp(`'${dep[2]}':\\s*'([0-9a-f]{40})'`).exec(chromiumDeps)?.[1]) : null;
    if (!dep || !revision) fail(`Chromium ${chromiumVersion} DEPS: cannot find the FFmpeg revision`);
    else {
      // Electron's own FFmpeg patches and build flags (also inside the Electron source archive).
      const patchConfig = JSON.parse(await getText(rawGitHub(repo, tag, 'patches/config.json')));
      const patchDir = patchConfig.find((p) => p.repo === 'src/third_party/ffmpeg')?.patch_dir?.replace(/^src\/electron\//, '');
      const patches = patchDir ? String(await getText(rawGitHub(repo, tag, `${patchDir}/.patches`), { optional: true }) ?? '').split('\n').map((l) => l.trim()).filter(Boolean) : [];
      const argsAll = await getText(rawGitHub(repo, tag, 'build/args/all.gn'));
      const argsRelease = await getText(rawGitHub(repo, tag, 'build/args/release.gn'));
      const branding = /^\s*ffmpeg_branding\s*=\s*"(\w+)"/m.exec(argsAll + argsRelease)?.[1] ?? 'Chromium';
      const component = /^\s*is_component_ffmpeg\s*=\s*true/m.test(argsRelease);
      if (!component) fail(`Electron ${electronPkg.version} build/args/release.gn does not set is_component_ffmpeg = true: FFmpeg would not be a separate, replaceable library`);
      ffmpeg = { chromiumVersion, chromiumGit, srcRepo, revision, repoPath: dep[1], patchDir, patches, branding, component, electron: electronPkg.version, electronRepo: repo, tag };
      const f = addFile({
        path: `sources/ffmpeg/chromium-ffmpeg-${short(revision)}.tar.gz`,
        url: `${chromiumGit}${dep[1]}/+archive/${revision}.tar.gz`,
        kind: 'source',
        title: `Chromium's FFmpeg at ${revision} (pinned by Chromium ${chromiumVersion}, Electron ${electronPkg.version})`,
      });
      const e = addFile({
        path: `sources/electron/electron-${tag}.tar.gz`,
        url: `https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`,
        kind: 'build',
        title: `Electron ${tag} source — DEPS, the patches it applies to FFmpeg (${patchDir}/) and the GN args it builds with (build/args/)`,
      });
      const c = { name: 'FFmpeg (Chromium)', version: `${short(revision)} (Chromium ${chromiumVersion})`, license: 'LGPL-2.1-or-later', via: `Electron ${electronPkg.version}`, targets, files: [f.path, e.path] };
      components.push(c);
      ffmpeg.component = c;
      notMirrored.chromium = { version: chromiumVersion, url: `${chromiumGit}${srcRepo}/+/refs/tags/${chromiumVersion}` };
    }
  }
}

// ── published checksums, downloads and checks ────────────────────────────────
const files = [...bundle.values()].sort((a, b) => a.path.localeCompare(b.path));
const licenceFiles = new Map(); // bundle path → Buffer

if (!listMode && !problems.length) {
  log(`downloading ${files.length} archives (cache: ${relRoot(CACHE)})`);
  await pool(files, 4, async (f) => {
    try {
      await fetchFile(f);
    } catch (err) {
      fail(err.message);
    }
  });
}

if (!listMode && !problems.length) {
  // GitHub tag/commit archives carry the commit id; it must be the one the tag/branch resolved to.
  for (const f of files) {
    if (!f.local || !/\.tar\.gz$/.test(f.path) || !f.url.startsWith('https://github.com/')) continue;
    const comment = await tarComment(f.local);
    f.commit = /^[0-9a-f]{40}$/.test(comment ?? '') ? comment : null;
    if (f.expectCommit && f.commit !== f.expectCommit) fail(`${f.path}: archive of commit ${f.commit ?? '?'}, expected ${f.expectCommit}`);
  }

  // Windows: the MXE package pins of the libvips release must name the archives in this bundle,
  // and the DLL sharp ships must be the one from that release.
  if (winBuild?.mxe) {
    const bw = bundle.get(`sources/build-scripts/${winBuild.mxe.repo.split('/')[1]}-${winBuild.mxe.tag}.tar.gz`);
    const mx = winBuild.mxe.mxe && bundle.get(`sources/build-scripts/${winBuild.mxe.mxe.repo.split('/')[1]}-${short(winBuild.mxe.mxe.commit)}.tar.gz`);
    const bwTar = await readTarGz(bw.local, (n) => /\/build\/.*\.mk$/.test(n));
    const mxTar = mx ? await readTarGz(mx.local, (n) => /^[^/]+\/src\/[^/]+\.mk$/.test(n)) : { files: new Map() };
    // Package definitions in MXE's load order: src/, build/, then the active plugins.
    const layers = [
      [...mxTar.files].filter(([n]) => /^[^/]+\/src\//.test(n)),
      [...bwTar.files].filter(([n]) => /^[^/]+\/build\/[^/]+\.mk$/.test(n)),
      ...MXE_PLUGINS.map((p) => [...bwTar.files].filter(([n]) => n.includes(`/build/plugins/${p}/`))),
    ];
    const pins = new Map(); // MXE package → { VERSION, CHECKSUM, where }
    for (const layer of layers) {
      for (const [name, data] of layer.sort(([a], [b]) => a.localeCompare(b))) {
        let pkg = null;
        for (const line of data.toString('utf8').split('\n')) {
          const p = /^PKG\s*:=\s*(\S+)/.exec(line);
          if (p) pkg = p[1];
          const m = /^(?:\$\(PKG\)|([\w+-]+))_(VERSION|CHECKSUM)\s*:?=\s*(\S+)\s*$/.exec(line);
          if (!m) continue;
          const which = m[1] ?? pkg;
          if (!which) continue;
          const pin = pins.get(which) ?? {};
          pin[m[2]] = m[3];
          pin.where = { ...(pin.where ?? {}), [m[2]]: name.replace(/^[^/]+\//, `${name.startsWith('mxe-') ? winBuild.mxe.mxe.repo : winBuild.mxe.repo}/`) };
          pins.set(which, pin);
        }
      }
    }
    // versions.json key → MXE package, from the generator of versions.json (vips-web.mk).
    const webMk = [...bwTar.files].find(([n]) => n.endsWith('/build/plugins/web-deps/vips-web.mk'))?.[1]?.toString('utf8') ?? '';
    const mxeName = new Map([...webMk.matchAll(/"([\w-]+)": "\$\(([\w+-]+)_VERSION\)"/g)].map((m) => [m[1], m[2]]));
    for (const c of libvipsComponents.values()) {
      if (!c.targets.some((t) => t.startsWith('win32'))) continue;
      const pkg = mxeName.get(c.key);
      const pin = pkg && pins.get(pkg);
      const archive = bundle.get(c.files[0]);
      if (!pin?.VERSION || !pin?.CHECKSUM) {
        fail(`${winBuild.mxe.repo} ${winBuild.mxe.tag}: no MXE pin for ${c.key} (package ${pkg ?? '?'})`);
        continue;
      }
      if (pin.VERSION !== c.version) fail(`${winBuild.mxe.repo} ${winBuild.mxe.tag} builds ${pkg} ${pin.VERSION}, the Windows package ships ${c.key} ${c.version}`);
      else if (pin.CHECKSUM !== archive.sha256) fail(`${winBuild.mxe.repo} ${winBuild.mxe.tag} pins ${pkg} ${pin.VERSION} to SHA-256 ${pin.CHECKSUM}, not to ${archive.path} (${archive.sha256}): the Windows build used another archive`);
      else archive.pins.push({ sha256: pin.CHECKSUM, from: `Windows build pin ${pin.where.CHECKSUM}` });
    }
    // The Windows libvips DLLs sharp ships come from that release unchanged.
    for (const asset of winBuild.mxe.assets) {
      const t = libvipsTargets.find((x) => x.target === asset.target);
      const f = { url: asset.url, path: asset.name, published: await publishedHashes(asset.url) };
      try {
        await fetchFile(f);
      } catch (err) {
        fail(err.message);
        continue;
      }
      const zip = readFileSync(f.local);
      asset.checked = [];
      for (const dll of t.binaries) {
        const shipped = t.contents?.files.get(dll);
        const inZip = zipEntry(zip, (n) => n.endsWith(`/bin/${basename(dll)}`));
        if (inZip && shipped && sha256(inZip.data) === sha256(shipped)) asset.checked.push({ dll, sha256: sha256(shipped), same: true });
        else if (inZip) fail(`${t.host}/${dll} differs from ${inZip.name} in ${asset.name}`);
        else if (/^lib\/libvips-cpp-[\d.]+\.dll$/.test(dll) && winBuild.cpp) asset.checked.push({ dll, sha256: shipped ? sha256(shipped) : null, same: false });
        else fail(`${t.host}/${dll} is not in ${asset.name} and is not built by sharp`);
      }
    }
  }

  // FFmpeg: licence files, and the shipped targets' configs must be built without GPL/nonfree parts.
  if (ffmpeg) {
    const f = bundle.get(ffmpeg.component.files[0]);
    const configs = targets.map((t) => `chromium/config/${ffmpeg.branding}/${FFMPEG_CONFIG_OS[t.split('-')[0]]}/${t.split('-')[1]}/config.h`);
    const keep = ['LICENSE.md', 'COPYING.LGPLv2.1', 'CREDITS.chromium', 'README.chromium'];
    const tar = await readTarGz(f.local, (n) => keep.includes(n) || configs.includes(n));
    for (const cfg of configs) {
      const text = tar.files.get(cfg)?.toString('utf8');
      if (!text) fail(`${f.path}: ${cfg} is missing`);
      else if (!/^#define CONFIG_GPL 0$/m.test(text) || !/^#define CONFIG_NONFREE 0$/m.test(text) || !/^#define CONFIG_VERSION3 0$/m.test(text)) fail(`${cfg}: FFmpeg is configured with GPL, version3 or nonfree parts`);
    }
    ffmpeg.configs = configs;
    for (const k of keep.filter((n) => n !== 'README.chromium')) {
      if (tar.files.has(k)) licenceFiles.set(`licenses/ffmpeg-${short(ffmpeg.revision)}/${k}`, tar.files.get(k));
      else fail(`${f.path}: ${k} is missing`);
    }
  }
}

// Licence texts: the committed snapshot (docs/licenses/upstream) for libvips libraries and crates.
for (const c of components) {
  if (c.via === 'libvips' || crateComponents.get(`${c.name}@${c.version}`) === c) {
    const groups = c.via === 'libvips' ? ['libvips'] : ['canvas', 'librsvg'];
    const entry = groups.map((g) => upstreamByKey.get(`${g}/${c.name}@${c.version}`)).find(Boolean);
    if (!entry) {
      fail(`docs/licenses/upstream has no licence text for ${c.name} ${c.version} (node scripts/licenses-fetch.mjs)`);
      continue;
    }
    for (const f of entry.files) licenceFiles.set(`licenses/${safe(`${c.name}-${c.version}`)}/${basename(f.path)}`, readFileSync(join(UPSTREAM_DIR, f.path)));
    c.licenceDir = `licenses/${safe(`${c.name}-${c.version}`)}/`;
  }
}
if (ffmpeg?.component) ffmpeg.component.licenceDir = `licenses/ffmpeg-${short(ffmpeg.revision)}/`;
for (const t of ['LGPL-3.0.txt', 'GPL-3.0.txt']) licenceFiles.set(`licenses/${t}`, readFileSync(join(ROOT, 'docs', 'licenses', t)));
// Crates that publish no licence file (e.g. selectors) are MPL-2.0 by their metadata: ship the text once.
const mplText = [...licenceFiles].find(([p, d]) => /\/LICENSE[^/]*$/.test(p) && /^\s*Mozilla Public License Version 2\.0\b/.test(d.toString('utf8')))?.[1];
if (mplText) licenceFiles.set('licenses/MPL-2.0.txt', mplText);
for (const c of components) {
  if (c === ffmpeg?.component) continue; // texts come from its archive (checked above when building)
  if (c.licenceDir && ![...licenceFiles.keys()].some((p) => p.startsWith(c.licenceDir) && !p.endsWith('/NO-LICENCE-FILE.txt'))) {
    if (/^MPL-2\.0$/.test(c.license) && mplText) c.licenceNote = ' (no licence file upstream; text: `licenses/MPL-2.0.txt`)';
    else fail(`no licence text for ${c.name} ${c.version} (${c.license})`);
  }
}

// ── MANIFEST.md ──────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/\|/g, '\\|');
const code = (s) => `\`${s}\``;
function verification(f) {
  const lines = [];
  for (const p of [...f.published].sort((a, b) => a.from.localeCompare(b.from))) lines.push(`${listMode ? 'published' : 'matches'} ${p.from}`);
  for (const p of f.pins) lines.push(`matches ${p.from}`);
  if (f.integrity) lines.push(`${listMode ? 'npm integrity' : 'matches npm integrity'} ${f.integrity.slice(0, 19)}…`);
  if (f.commit) lines.push(`commit ${f.commit}`);
  else if (f.expectCommit) lines.push(`commit ${f.expectCommit}`);
  if (!f.published.length && !f.pins.length && !f.integrity) lines.push(listMode ? 'no published SHA-256' : 'no published SHA-256; recorded at download');
  return [...lines, ...f.notes].join('; ');
}
function renderManifest() {
  const out = [];
  const totalSize = files.reduce((n, f) => n + (f.size ?? 0), 0);
  out.push(`# ${productName} ${desktopPkg.version} — third-party sources (LGPL, MPL)

This archive is published with ${productName} ${desktopPkg.version} at ${RELEASES} (asset \`${archiveBase}.tar.gz\`).

It holds the complete corresponding source of every component under the GNU Lesser General Public License (LGPL) or the Mozilla Public License (MPL) inside the ${productName} packages for ${targetsLabel(targets)}: the upstream source archives of exactly the versions those packages ship, the patches applied when the shipped binaries were built, and the build scripts that built them. ${productName} uses these components unmodified, as published in the npm packages and the Electron runtime named below. ${productName}'s own code is MIT-licensed (${RELEASES.replace(/\/releases$/, '')}).

* \`sources/\` — the archives, byte for byte as downloaded from the upstream URLs below; \`SHA256SUMS\` lists every file.
* \`licenses/\` — the licence texts of these components, and the GNU LGPL-3.0 and GPL-3.0 texts.
* Generated by \`scripts/third-party-sources.mjs\` in the ${productName} repository.
`);
  out.push('## LGPL and MPL components\n');
  out.push('| Component | Version | Licence | Shipped in | Via | Source in this archive |');
  out.push('|---|---|---|---|---|---|');
  const rank = (c) => (c.via === 'libvips' ? 0 : c === ffmpeg?.component ? 1 : 2);
  for (const c of [...components].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
    out.push(`| ${esc(c.name)} | ${esc(c.version)} | ${esc(c.license)}${c.table && c.via === 'libvips' ? ` (sharp-libvips: ${esc(c.table)})` : ''} | ${targetsLabel(c.targets)} | ${esc(c.via === 'libvips' ? 'libvips (sharp)' : c.via)} | ${c.files.map(code).join(', ')}${c.licenceDir ? `; licence: ${code(c.licenceDir)}${c.licenceNote ?? ''}` : ''} |`);
  }
  out.push(`\n${components.length} components. The libvips binaries are distributed under LGPL-3.0-or-later as a whole (npm metadata of the \`@img/sharp-libvips-*\` and \`@img/sharp-win32-*\` packages); each library keeps its own licence above.\n`);

  out.push('## Where they are in the packages\n');
  out.push('| Package | File (inside the app) | Contains |');
  out.push('|---|---|---|');
  // Paths inside the installed app (macOS bundle / Windows installation folder).
  const unpacked = (t, rest) => (t.startsWith('darwin') ? `${productName}.app/Contents/Resources/app.asar.unpacked/node_modules/${rest}` : `resources\\app.asar.unpacked\\node_modules\\${rest.replaceAll('/', '\\')}`);
  const scopeLibs = [...libvipsComponents.values()].filter((c) => c.key !== 'vips').map((c) => c.name).join(', ');
  for (const t of libvipsTargets) {
    for (const b of t.binaries) {
      const what = /libvips-cpp-[\d.]+\.dll$/.test(b) ? 'the libvips C++ binding (compiled by sharp, see below)' : `libvips and, statically linked, ${scopeLibs} and the permissive libraries listed at the end`;
      out.push(`| ${targetLabel(t.target)} | ${code(unpacked(t.target, `${t.host}/${b}`))} | ${what} |`);
    }
  }
  for (const ct of canvasTargets) {
    const mpl = [...crateComponents.values()].filter((c) => c.targets.includes(ct.target) && c.via.includes('@napi-rs/canvas')).map((c) => `${c.name} ${c.version}`);
    if (mpl.length) out.push(`| ${targetLabel(ct.target)} | ${code(unpacked(ct.target, `${ct.name}/${ct.binary}`))} | Skia and Rust crates, statically linked; MPL-2.0: ${mpl.join(', ')} |`);
  }
  if (ffmpeg) for (const t of targets) out.push(`| ${targetLabel(t)} | ${code(t.startsWith('darwin') ? `${productName}.app/${FFMPEG_BINARY.darwin}` : FFMPEG_BINARY.win32)} | FFmpeg (Electron ${ffmpeg.electron}) |`);

  out.push('\n## Files\n');
  out.push('| File | Size | SHA-256 | Upstream URL | Verification |');
  out.push('|---|---|---|---|---|');
  for (const f of files) {
    const hash = f.sha256 ?? f.published[0]?.sha256 ?? '—';
    out.push(`| ${code(f.path)}<br>${esc(f.title)} | ${f.size ? mb(f.size) : '—'} | ${code(hash)} | ${f.url} | ${esc(verification(f))} |`);
  }
  if (!listMode) out.push(`\n${files.length} files, ${mb(totalSize)}.`);

  out.push('\n## How the shipped binaries were built\n');
  for (const b of libvipsBuilds.filter((x) => x.posix)) {
    const mac = b.targets.filter((t) => t.startsWith('darwin'));
    if (mac.length) {
      out.push(`* **libvips for ${targetsLabel(mac)}** — \`@img/sharp-libvips-darwin-*\` ${b.version}, published from ${b.repo} ${b.tag} (commit ${b.commit}). Its \`build.sh\` runs \`build/posix.sh\`, which downloads each library at the version in \`versions.properties\`, applies the patches listed above (\`patch -p1\`) and a few \`sed\` edits written in the script itself, and links them statically into \`libvips-cpp.<version>.dylib\`. librsvg's Rust crates are fetched by cargo from crates.io as pinned by librsvg's \`Cargo.lock\`.`);
    }
    if (b === winBuild && winBuild.mxe) {
      const m = winBuild.mxe;
      const checked = (m.assets ?? []).flatMap((a) => a.checked ?? []);
      const same = checked.filter((c) => c.same).map((c) => code(basename(c.dll)));
      out.push(`* **libvips for ${targetsLabel(m.targets)}** — \`@img/sharp-win32-*\` ships the DLLs that ${b.repo} ${b.tag}/build/win.sh takes from ${m.repo} ${m.tag} (${(m.assets ?? []).map((a) => code(a.name)).join(', ')})${same.length ? `; ${same.join(', ')} ${same.length === 1 ? 'is' : 'are'} byte-identical to the release (checked)` : ''}. ${m.repo} builds with MXE${m.mxe ? ` (${m.mxe.repo}, branch ${m.mxe.branch}, commit ${m.mxe.commit} — the branch head when this archive was made; its container image clones that branch)` : ''}, using the same library archives as macOS: each LGPL/MPL archive above matches the SHA-256 pinned in its MXE package definition.`);
      if (winBuild.cpp) out.push(`* **libvips C++ binding for ${targetsLabel(m.targets)}** — \`libvips-cpp-<version>.dll\` is compiled by sharp ${winBuild.cpp.sharp} (\`src/binding.gyp\`, target \`libvips-cpp-<(vips_version)\`) from the C++ sources and headers in \`@img/sharp-libvips-dev\` ${winBuild.cpp.dev}${winBuild.cpp.devGitHead ? ` (published from commit ${winBuild.cpp.devGitHead})` : ''}; both npm packages are included.`);
    }
  }
  if (ffmpeg) {
    out.push(`* **FFmpeg** — Electron ${ffmpeg.electron} is built from Chromium ${ffmpeg.chromiumVersion} (Electron's \`DEPS\`), whose \`DEPS\` pins \`src/third_party/ffmpeg\` to ${ffmpeg.chromiumGit}${ffmpeg.repoPath} at ${ffmpeg.revision}. Electron applies ${ffmpeg.patches.length ? ffmpeg.patches.map(code).join(', ') : 'no patches'} (\`${ffmpeg.patchDir}/\`) and builds with \`ffmpeg_branding = "${ffmpeg.branding}"\` and \`is_component_ffmpeg = ${ffmpeg.component ? 'true' : 'false'}\` (\`build/args/\`), i.e. FFmpeg as a separate dynamic library; the configurations used (${(ffmpeg.configs ?? targets.map((t) => `chromium/config/${ffmpeg.branding}/${FFMPEG_CONFIG_OS[t.split('-')[0]]}/${t.split('-')[1]}`)).map(code).join(', ')}) enable no GPL, version-3 or nonfree parts${ffmpeg.configs ? ' (checked)' : ''}.`);
  }
  out.push('* **Rust crates** — the `.crate` files are the ones cargo downloads; each matches the SHA-256 in the crates.io index and in the `Cargo.lock` / SBOM of the binary that links it.');

  out.push(`
## Replacing libvips or FFmpeg

libvips (with the libraries linked into it) and FFmpeg are dynamically linked, separate files, so you can replace them with modified, interface-compatible builds made from these sources:

* libvips — macOS: \`${productName}.app/Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-<arch>/lib/\`; Windows: \`resources\\app.asar.unpacked\\node_modules\\@img\\sharp-win32-x64\\lib\\\` in the installation folder.
* FFmpeg — macOS: \`${productName}.app/${FFMPEG_BINARY.darwin}\`; Windows: \`ffmpeg.dll\` in the installation folder.${ffmpeg ? ` Electron also publishes interface-compatible builds without proprietary codecs (\`ffmpeg-${ffmpeg.tag}-<platform>-<arch>.zip\`) with each release.` : ''}
* On macOS, replacing a file inside the signed app invalidates its signature: re-sign the modified copy ad hoc before running it — \`codesign --force --deep --sign - ${productName}.app\`.

${productName}'s terms do not restrict modifying these libraries or reverse engineering for debugging such modifications.

## Not in this archive
`);
  if (notMirrored.chromium) {
    out.push(`* **The rest of Chromium inside Electron.** Electron Framework (statically linked, not a separate library) also contains code under the LGPL or MPL — for example the WebKit-derived parts of Blink (LGPL-2.0/2.1), hunspell and url_parse (MPL-1.1/GPL-2.0/LGPL-2.1); \`LICENSES.chromium.html\`, shipped in the app, lists every component with its notice. Its corresponding source is the Chromium source tree at ${notMirrored.chromium.url} (Chromium ${notMirrored.chromium.version}) with Electron's patches (\`patches/\` in the Electron source archive above). That tree is several gigabytes and is not mirrored here; the written offer below covers it.`);
  }
  if (notMirrored.libvips.length) {
    out.push('* **Permissively licensed libraries statically linked into libvips** (no source obligation; the build scripts above download them from these URLs):');
    for (const l of notMirrored.libvips) out.push(`  * ${l.name} ${l.version} (${l.license}) — ${l.urls.join(', ') || 'see build/posix.sh'}${l.patches.length ? `; patches: ${l.patches.join(', ')}` : ''}`);
  }
  out.push(`* The other Rust crates in librsvg and @napi-rs/canvas, Skia and the C/C++ libraries in @napi-rs/canvas, and the npm packages are under permissive licences; \`THIRD_PARTY_LICENSES.md\` in the app lists them with their licence texts.

## Written offer

If any source listed here is unavailable from ${RELEASES}, we will provide it — and the corresponding source of the LGPL/MPL code in Electron's Chromium — to anyone who received ${productName} ${desktopPkg.version} in binary form, for at least three years after its release, at no charge for a download or for no more than the cost of physically performing the distribution. Ask at ${ISSUES}.
`);
  return `${out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// ── output ───────────────────────────────────────────────────────────────────
if (listMode) {
  process.stdout.write(renderManifest());
  if (problems.length) {
    console.error(`\n✖ ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  log(`\n${components.length} LGPL/MPL components, ${files.length} source files would be included (run without --list to build the archive)`);
  process.exit(0);
}
if (problems.length) {
  console.error(`✖ cannot build ${archiveBase}.tar.gz:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

const manifest = Buffer.from(renderManifest(), 'utf8');
// Entries: MANIFEST.md, SHA256SUMS, licences, sources. Fixed metadata so equal inputs give an equal tar.
const entries = [
  { path: 'MANIFEST.md', data: manifest },
  ...[...licenceFiles].sort(([a], [b]) => a.localeCompare(b)).map(([path, data]) => ({ path, data })),
  ...files.map((f) => ({ path: f.path, file: f.local, size: f.size, sha256: f.sha256 })),
];
const sums = entries.map((e) => `${e.sha256 ?? sha256(e.data)}  ${e.path}`).sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
entries.splice(1, 0, { path: 'SHA256SUMS', data: Buffer.from(`${sums.join('\n')}\n`, 'utf8') });

const MTIME = Number(process.env.SOURCE_DATE_EPOCH) || 499162500; // 1985-10-26, as npm does
function octal(n, width) {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}
function tarHeader(path, size, type = '0') {
  const blocks = [];
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(path) > 100) {
    // ustar: split into prefix (≤ 155) + name (≤ 100) at a "/"; otherwise a pax header carries the path.
    const cut = [...path.matchAll(/\//g)].map((m) => m.index).find((i) => Buffer.byteLength(path.slice(0, i)) <= 155 && Buffer.byteLength(path.slice(i + 1)) <= 100);
    if (cut !== undefined) [prefix, name] = [path.slice(0, cut), path.slice(cut + 1)];
    else {
      const rec = ` path=${path}\n`;
      let len = Buffer.byteLength(rec) + 2;
      while (String(len).length + Buffer.byteLength(rec) !== len) len = String(len).length + Buffer.byteLength(rec);
      const body = Buffer.from(`${len}${rec}`, 'utf8');
      blocks.push(tarHeader(`PaxHeaders/${basename(path)}`.slice(0, 100), body.length, 'x'), body, Buffer.alloc((512 - (body.length % 512)) % 512));
      name = path.slice(-100);
    }
  }
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  h.write(octal(0o644, 8), 100, 'latin1');
  h.write(octal(0, 8), 108, 'latin1');
  h.write(octal(0, 8), 116, 'latin1');
  h.write(octal(size, 12), 124, 'latin1');
  h.write(octal(MTIME, 12), 136, 'latin1');
  h.fill(0x20, 148, 156);
  h.write(type, 156, 'latin1');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return blocks.length ? Buffer.concat([...blocks, h]) : h;
}
async function* tarStream() {
  for (const e of entries) {
    const path = `${archiveBase}/${e.path}`;
    const size = e.data ? e.data.length : e.size;
    yield tarHeader(path, size);
    if (e.data) yield e.data;
    else yield* createReadStream(e.file);
    if (size % 512) yield Buffer.alloc(512 - (size % 512));
  }
  yield Buffer.alloc(1024);
}
mkdirSync(outDir, { recursive: true });
const target = join(outDir, `${archiveBase}.tar.gz`);
const partial = `${target}.partial`;
await pipeline(Readable.from(tarStream()), createGzip({ level: 6 }), createWriteStream(partial));
renameSync(partial, target);
const { sha256: archiveSha } = await hashFile(target);
const size = statSync(target).size;
log(`\n${files.filter((f) => f.cached).length} of ${files.length} archives from the cache`);
const shown = relative(process.cwd(), target);
console.log(`wrote ${shown.startsWith('..') ? target : shown} — ${mb(size)}, SHA-256 ${archiveSha}`);
console.log(`  ${components.length} LGPL/MPL components; ${files.length} source archives (${mb(files.reduce((n, f) => n + f.size, 0))}), ${licenceFiles.size} licence files`);
