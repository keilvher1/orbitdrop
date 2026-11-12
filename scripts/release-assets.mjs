#!/usr/bin/env node
// The CI release job (.github/workflows/release.yml): adds what CI built for a tag to the tag's
// DRAFT release and rewrites SHA256SUMS.txt so it covers every asset of the release.
//
//   node scripts/release-assets.mjs v0.2.0 <folder with the downloaded workflow artifacts>
//
// Before anything is uploaded:
//   - the version in every update metadata file and build report matches the tag;
//   - latest.yml (Windows) and latest-mac.yml (macOS, both architectures) name files that are
//     there, with the listed sha512 and size;
//   - macOS files are refused unless their build reports say Developer ID, notarized app and
//     notarized + stapled DMG (CI builds macOS only with signing secrets; unsigned macOS packages
//     never reach a release — they are built locally, scripts/release-mac.mjs).
// The draft is created when it does not exist yet (scripts/release-mac.mjs may have made it); a
// published release is refused. Nothing is ever published (docs/RELEASING.md).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCT, SUMS_FILE, checkUpdateInfo, createRunner, ensureDraftRelease, parseReleaseTag, refreshSha256Sums, releaseNotes, sha256File, uploadAssets, yaml } from './release-lib.mjs';

/** Release files and build reports found (recursively: one folder per workflow artifact). */
export function collectAssets(dir) {
  const found = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(dmg|zip|exe|blockmap)$/.test(name) || /^latest(-mac)?\.yml$/.test(name) || /^build-report-.*\.json$/.test(name)) {
        if (found.has(name)) throw new Error(`${name} appears twice in ${dir}`);
        found.set(name, path);
      }
    }
  };
  walk(dir);
  return found;
}

/** Problems that stop the upload (empty = the files may go to the draft). */
export async function checkAssets(found, version) {
  const problems = [];
  const names = [...found.keys()];
  const dirOf = (name) => found.get(name).slice(0, -name.length - 1);
  for (const name of names) {
    if (/\.(dmg|zip|exe|blockmap)$/.test(name) && !name.startsWith(`${PRODUCT}-${version}-`)) problems.push(`${name} is not a ${version} package`);
  }

  const mac = names.filter((n) => /-mac-/.test(n) || n === 'latest-mac.yml');
  if (mac.length) {
    for (const arch of ['arm64', 'x64']) {
      const reportName = `build-report-darwin-${arch}.json`;
      if (!found.has(reportName)) {
        problems.push(`macOS ${arch}: no build report — unsigned or unverified macOS packages are never uploaded`);
        continue;
      }
      const report = JSON.parse(readFileSync(found.get(reportName), 'utf8'));
      if (report.version !== version) problems.push(`${reportName}: version ${report.version}`);
      if (report.signing?.mode !== 'Developer ID' || report.signing?.notarize !== true) problems.push(`macOS ${arch}: not signed with a Developer ID and notarized ("${report.signing?.mode}")`);
      if (report.dmgNotarization?.ok !== true) problems.push(`macOS ${arch}: the DMG is not notarized and stapled`);
      if (report.smoke?.ok !== true) problems.push(`macOS ${arch}: the smoke test did not pass`);
      for (const ext of ['dmg', 'zip']) if (!found.has(`${PRODUCT}-${version}-mac-${arch}.${ext}`)) problems.push(`macOS ${arch}: ${PRODUCT}-${version}-mac-${arch}.${ext} is missing`);
    }
    if (!found.has('latest-mac.yml')) problems.push('latest-mac.yml is missing');
    else {
      const info = yaml().load(readFileSync(found.get('latest-mac.yml'), 'utf8'));
      for (const p of await checkUpdateInfo(info, dirOf('latest-mac.yml'), { platform: 'darwin', version, archs: ['arm64', 'x64'] })) problems.push(`latest-mac.yml: ${p}`);
    }
  }

  const win = names.filter((n) => /-win-/.test(n) || n === 'latest.yml');
  if (win.length) {
    if (!found.has('latest.yml')) problems.push('latest.yml is missing');
    else {
      const info = yaml().load(readFileSync(found.get('latest.yml'), 'utf8'));
      for (const p of await checkUpdateInfo(info, dirOf('latest.yml'), { platform: 'win32', version })) problems.push(`latest.yml: ${p}`);
    }
    const report = found.has('build-report-win32-x64.json') ? JSON.parse(readFileSync(found.get('build-report-win32-x64.json'), 'utf8')) : null;
    if (!report) problems.push('Windows: no build report');
    else if (report.version !== version) problems.push(`build-report-win32-x64.json: version ${report.version}`);
  }
  if (!mac.length && !win.length) problems.push('no packages to upload');
  return problems;
}

export async function publishDraftAssets({ tag, dir, run, workDir }) {
  const { version, prerelease } = parseReleaseTag(tag);
  const found = collectAssets(dir);
  const problems = await checkAssets(found, version);
  if (problems.length) throw new Error(`not uploading:\n  - ${problems.join('\n  - ')}`);
  const release = ensureDraftRelease({ tag, title: `${PRODUCT} ${version}`, notes: releaseNotes(version), prerelease, run, workDir });
  const localHashes = new Map();
  for (const [name, path] of found) localHashes.set(name, await sha256File(path));
  uploadAssets({ tag, files: [...found.values()], run });
  const entries = await refreshSha256Sums({ tag, run, localHashes, workDir });
  uploadAssets({ tag, files: [join(workDir, SUMS_FILE)], run });
  return { release, uploaded: [...found.keys()].sort(), sums: entries.length };
}

async function main() {
  const [tag, dir] = process.argv.slice(2);
  if (!tag || !dir || !existsSync(dir)) throw new Error('usage: node scripts/release-assets.mjs <tag> <folder>');
  const workDir = mkdtempSync(join(tmpdir(), 'orbitdrop-release-'));
  try {
    const result = await publishDraftAssets({ tag, dir, run: createRunner(), workDir });
    const lines = [`### Draft release ${tag}`, '', `Uploaded: ${result.uploaded.map((n) => `\`${n}\``).join(', ')}`, '', `${SUMS_FILE} covers ${result.sums} assets. The release is a **draft**: publish it by hand after the checks in docs/RELEASING.md.`];
    console.log(`\n${lines.join('\n')}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
