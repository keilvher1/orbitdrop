// Shared by scripts/package.mjs (update metadata), scripts/release-mac.mjs (the owner's Mac) and
// scripts/release-assets.mjs (the CI release job). Plain Node ESM, no shell features. Every
// command goes through an injected runner, so tests can replace git, gh and the Apple tools.
//
//   run(cmd, args, { input?, display? }) → { status, stdout, stderr }
//
// Nothing here publishes a release: drafts only (docs/RELEASING.md).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_DIR = join(ROOT, 'apps', 'desktop', 'release');
/** The public repository every release (and its update metadata) lives in. */
export const REPO = 'keilvher1/orbitdrop';
export const SUMS_FILE = 'SHA256SUMS.txt';
export const PRODUCT = 'OrbitDrop';

// ── commands ─────────────────────────────────────────────────────────────────

/**
 * The real runner: spawnSync without a shell. `display` replaces the arguments in the echoed
 * command line (secrets must never reach a terminal or a CI log); `quiet` echoes nothing.
 */
export function createRunner({ echo = true, cwd = ROOT, env = process.env } = {}) {
  return (cmd, args = [], options = {}) => {
    if (echo && !options.quiet) console.log(`  $ ${[cmd, ...(options.display ?? args)].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    const r = spawnSync(cmd, args, { cwd: options.cwd ?? cwd, env: options.env ?? env, input: options.input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { status: -1, stdout: '', stderr: r.error.message };
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/** Run and return stdout; throw with the command's own message when it fails. */
export function must(run, cmd, args, options = {}) {
  const r = run(cmd, args, options);
  if (r.status !== 0) {
    const shown = [cmd, ...(options.display ?? args)].join(' ');
    const detail = `${r.stderr || r.stdout}`.trim().split('\n').slice(-6).join('\n    ');
    throw new Error(`${shown} failed (exit ${r.status})${detail ? `:\n    ${detail}` : ''}`);
  }
  return r.stdout;
}

// ── tags, files, hashes ──────────────────────────────────────────────────────

/** vX.Y.Z or vX.Y.Z-pre.N → { tag, version, prerelease }. */
export function parseReleaseTag(tag) {
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag ?? ''));
  if (!m) throw new Error(`"${tag}" is not a release tag (expected vX.Y.Z, e.g. v0.2.0)`);
  return { tag, version: m[1], prerelease: m[1].includes('-') };
}

export function hashFile(file, algorithm = 'sha256', encoding = 'hex') {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest(encoding)))
      .on('error', reject);
  });
}
export const sha256File = (file) => hashFile(file, 'sha256', 'hex');
export const sha512File = (file) => hashFile(file, 'sha512', 'base64');

/** js-yaml, the copy electron-builder itself uses (no extra dependency). */
export function yaml() {
  const require = createRequire(import.meta.url);
  return createRequire(require.resolve('app-builder-lib/package.json'))('js-yaml');
}

/** `<sha256>  <name>` lines (what `shasum -a 256 -c SHA256SUMS.txt` reads), sorted by name. */
export function formatSums(entries) {
  return `${[...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${e.sha256}  ${e.name}`)
    .join('\n')}\n`;
}

export function parseSums(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

// ── update metadata (latest-mac.yml / latest.yml) ────────────────────────────

/**
 * scripts/package.mjs runs electron-builder once per macOS architecture, and every run writes
 * latest-mac.yml with its own zip only. Merged, it lists both; electron-updater on an Apple
 * silicon Mac picks the file whose name contains "arm64" (also under Rosetta), an Intel Mac the
 * other one. The legacy `path`/`sha512` fields (electron-updater < 2.15) point to the first file,
 * like electron-builder's own multi-arch output (x64 first).
 */
export function mergeUpdateInfo(infos) {
  const list = infos.filter(Boolean);
  if (list.length === 0) return null;
  const versions = new Set(list.map((i) => i.version));
  if (versions.size !== 1) throw new Error(`update metadata of different versions: ${[...versions].join(', ')}`);
  const files = [];
  for (const info of list) {
    for (const file of info.files ?? []) {
      const index = files.findIndex((f) => f.url === file.url);
      if (index >= 0) files[index] = file;
      else files.push(file);
    }
  }
  const archRank = (url) => (/arm64/.test(url) ? 1 : 0);
  files.sort((a, b) => archRank(a.url) - archRank(b.url) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const releaseDate = list.map((i) => i.releaseDate).filter(Boolean).sort().at(-1);
  const merged = { version: list[0].version, files, path: files[0]?.url, sha512: files[0]?.sha512 };
  if (releaseDate) merged.releaseDate = releaseDate;
  for (const key of ['releaseName', 'releaseNotes', 'minimumSystemVersion']) if (list[0][key] !== undefined) merged[key] = list[0][key];
  return merged;
}

/**
 * Problems of one update metadata file against the release files in `dir` (empty = consistent):
 * right version, every listed file present with the listed size and sha512, nothing outside the
 * folder; macOS lists exactly one zip per architecture (never a DMG: stapling changes DMG bytes
 * after the build), Windows exactly one setup.exe.
 */
export async function checkUpdateInfo(info, dir, { platform, version, archs = [] }) {
  const problems = [];
  if (!info || typeof info !== 'object') return ['not a YAML mapping'];
  if (info.version !== version) problems.push(`version is ${info.version}, expected ${version}`);
  const files = Array.isArray(info.files) ? info.files : [];
  if (files.length === 0) problems.push('lists no files');
  for (const file of files) {
    const url = String(file?.url ?? '');
    if (!url || url !== basename(url) || url.includes('..') || url.includes('\\')) {
      problems.push(`${JSON.stringify(url)} is not a plain file name`);
      continue;
    }
    const path = join(dir, url);
    if (!existsSync(path)) {
      problems.push(`${url} is listed but missing`);
      continue;
    }
    if (file.size !== undefined && statSync(path).size !== file.size) problems.push(`${url}: size ${statSync(path).size} ≠ listed ${file.size}`);
    if (!file.sha512 || (await sha512File(path)) !== file.sha512) problems.push(`${url}: sha512 does not match the file`);
  }
  const urls = files.map((f) => String(f?.url ?? ''));
  if (info.path !== undefined && !urls.includes(info.path)) problems.push(`legacy path ${info.path} is not one of the files`);
  if (platform === 'darwin') {
    for (const url of urls) if (!url.endsWith('.zip')) problems.push(`${url}: macOS updates must be zip files (a DMG changes when it is stapled)`);
    for (const arch of archs) {
      const matches = urls.filter((u) => u.endsWith('.zip') && (arch === 'arm64' ? /-arm64[.-]/.test(u) : !/arm64/.test(u) && u.includes(`-${arch}`)));
      if (matches.length !== 1) problems.push(`expected exactly one ${arch} zip, found ${matches.length}`);
    }
  } else if (platform === 'win32') {
    const installers = urls.filter((u) => u.endsWith('-setup.exe'));
    if (installers.length !== 1 || urls.length !== 1) problems.push(`expected exactly one -setup.exe, found ${urls.join(', ') || 'none'}`);
  }
  return problems;
}

// ── GitHub releases (gh CLI) ─────────────────────────────────────────────────

/** The release for `tag`, drafts included (needs push access), or null. */
export function findRelease({ tag, run, repo = REPO }) {
  const out = must(run, 'gh', ['api', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/releases?per_page=100`], { quiet: true });
  const releases = JSON.parse(out);
  if (!Array.isArray(releases)) throw new Error('unexpected answer from the GitHub API');
  return releases.find((r) => r.tag_name === tag) ?? null;
}

/**
 * The draft release for `tag`: created when missing. A release that is already published is
 * refused — its assets are what users download and what updates point to.
 */
export function ensureDraftRelease({ tag, title, notes, prerelease = false, run, repo = REPO, workDir }) {
  let release = findRelease({ tag, run, repo });
  if (!release) {
    const notesFile = join(workDir, 'release-notes.md');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(notesFile, notes);
    const args = ['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--title', title, '--notes-file', notesFile];
    if (prerelease) args.push('--prerelease');
    const created = run('gh', args);
    // Another job may have created it at the same moment: look again either way.
    release = findRelease({ tag, run, repo });
    if (!release) throw new Error(`could not create the draft release for ${tag}: ${`${created.stderr || created.stdout}`.trim()}`);
  }
  if (!release.draft) throw new Error(`the release for ${tag} is already published; its assets are not replaced (make a new version instead — docs/RELEASING.md)`);
  return release;
}

export function uploadAssets({ tag, files, run, repo = REPO }) {
  if (files.length === 0) return;
  must(run, 'gh', ['release', 'upload', tag, ...files, '--repo', repo, '--clobber']);
}

/**
 * SHA256SUMS.txt covering every asset of the draft (itself excepted). Hashes come from GitHub's
 * asset digests (sha256, computed by GitHub on upload); an asset without one is downloaded and
 * hashed. Files this run uploaded must match their local hash (a broken upload fails here).
 * Returns the entries; the caller uploads `<workDir>/SHA256SUMS.txt`.
 */
export async function refreshSha256Sums({ tag, run, repo = REPO, localHashes = new Map(), workDir }) {
  const release = findRelease({ tag, run, repo });
  if (!release) throw new Error(`no release for ${tag}`);
  if (!release.draft) throw new Error(`the release for ${tag} is already published; SHA256SUMS.txt is not replaced`);
  const entries = [];
  const problems = [];
  for (const asset of release.assets ?? []) {
    if (asset.name === SUMS_FILE) continue;
    let sha256 = /^sha256:([0-9a-f]{64})$/.exec(String(asset.digest ?? ''))?.[1] ?? null;
    if (!sha256) {
      const dir = join(workDir, 'assets');
      mkdirSync(dir, { recursive: true });
      must(run, 'gh', ['release', 'download', tag, '--repo', repo, '--pattern', asset.name, '--dir', dir, '--clobber']);
      sha256 = await sha256File(join(dir, asset.name));
    }
    const local = localHashes.get(asset.name);
    if (local && local !== sha256) problems.push(`${asset.name}: GitHub has sha256 ${sha256}, the uploaded file is ${local}`);
    entries.push({ name: asset.name, sha256 });
  }
  for (const name of localHashes.keys()) if (!entries.some((e) => e.name === name)) problems.push(`${name} was uploaded but is not on the release`);
  if (problems.length) throw new Error(`release assets do not match:\n  - ${problems.join('\n  - ')}`);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, SUMS_FILE), formatSums(entries));
  return entries;
}

export function releaseNotes(version) {
  return [
    `OrbitDrop ${version}.`,
    '',
    '- macOS 14+: `OrbitDrop-' + version + '-mac-arm64.dmg` (Apple silicon) or `…-mac-x64.dmg` (Intel). Signed with a Developer ID and notarized by Apple.',
    '- Windows 11 x64: `OrbitDrop-' + version + '-win-x64-…-setup.exe` (per-user installer). The file name says `-unsigned` while the installer is not Authenticode-signed.',
    '- `SHA256SUMS.txt` lists the SHA-256 of every file (`shasum -a 256 -c SHA256SUMS.txt`).',
    '',
    'Installed copies update themselves (Settings › General › Check for updates automatically).',
  ].join('\n');
}
