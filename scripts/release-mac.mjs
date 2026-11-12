#!/usr/bin/env node
// macOS release packages, built on the owner's Mac (the Developer ID private key stays in the
// login keychain and is never uploaded anywhere) and added to the DRAFT release of a tag:
//
//   node scripts/release-mac.mjs v0.2.0 [--skip-build] [--dry-run]
//
// 1. Refuses a dirty working tree, a HEAD that is not exactly the tag (also on origin), a
//    version that does not match the tag, missing signing/notarization settings, gh not logged in.
// 2. node scripts/package.mjs mac --arch all --require-signing --require-notarization
//    (apps signed + notarized + stapled by electron-builder; DMGs by scripts/mac-dmg.mjs).
// 3. Verifies what users get: build reports, latest-mac.yml against the zips, every DMG with
//    spctl (open, primary signature) and stapler, the app from each DMG — as a quarantined copy,
//    like a download — with spctl, stapler and syspolicy_check distribution.
// 4. Uploads the DMGs, zips, zip blockmaps and latest-mac.yml to the draft release (created when
//    CI has not made it yet) with `gh release upload --clobber`, then rewrites SHA256SUMS.txt so it
//    covers every asset of the release. A published release is never touched.
// It never publishes: that is a human step (docs/RELEASING.md).
//
// Settings, all from the environment (never written to the repository):
//   CSC_NAME="Your Name (TEAMID)"   the Developer ID Application identity in your keychain
//   APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_<key id>.p8
//   APPLE_API_KEY_ID=<key id>  APPLE_API_ISSUER=<issuer uuid>
//   — or — APPLE_KEYCHAIN_PROFILE=<profile stored with `xcrun notarytool store-credentials`>
// The key file is passed to notarytool by path; this script never reads or prints it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { notaryCredentials } from './mac-dmg.mjs';
import {
  PRODUCT,
  RELEASE_DIR,
  REPO,
  ROOT,
  SUMS_FILE,
  checkUpdateInfo,
  createRunner,
  ensureDraftRelease,
  must,
  parseReleaseTag,
  refreshSha256Sums,
  releaseNotes,
  sha256File,
  uploadAssets,
  yaml,
} from './release-lib.mjs';

export const MAC_ARCHS = ['arm64', 'x64'];

/** `~/…` in an environment value (APPLE_API_KEY is often written that way). */
export function expandHome(path) {
  return typeof path === 'string' && path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** Everything that must be true before building; throws one error listing every problem. */
export function preflight({ tag, env, run, root = ROOT, platform = process.platform, fileExists = existsSync }) {
  const problems = [];
  let parsed = null;
  try {
    parsed = parseReleaseTag(tag);
  } catch (err) {
    problems.push(err.message);
  }
  if (platform !== 'darwin') problems.push('macOS packages are built on a Mac');

  const git = (args) => run('git', args, { quiet: true, cwd: root });
  const status = git(['status', '--porcelain']);
  if (status.status !== 0) problems.push(`not a git checkout: ${status.stderr.trim()}`);
  else if (status.stdout.trim() !== '') problems.push(`the working tree has changes (commit or stash them first):\n    ${status.stdout.trim().split('\n').slice(0, 10).join('\n    ')}`);

  let commit = null;
  if (parsed) {
    const head = git(['rev-parse', 'HEAD']).stdout.trim();
    const tagged = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]);
    if (tagged.status !== 0) problems.push(`there is no tag ${tag} (create it on the release commit: git tag -a ${tag} -m "OrbitDrop ${parsed.version}")`);
    else if (tagged.stdout.trim() !== head) problems.push(`HEAD (${head.slice(0, 12)}) is not ${tag} (${tagged.stdout.trim().slice(0, 12)}): git checkout ${tag}`);
    else {
      commit = head;
      // The draft release is made for the tag on GitHub: it must be there, on the same commit.
      const remote = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
      const lines = remote.stdout.trim().split('\n').filter(Boolean);
      const peeled = lines.find((l) => l.endsWith('^{}')) ?? lines[0];
      if (remote.status !== 0) problems.push(`cannot read the tags on origin: ${remote.stderr.trim()}`);
      else if (!peeled) problems.push(`${tag} is not on GitHub yet: git push origin ${tag}`);
      else if (!peeled.startsWith(head)) problems.push(`${tag} on origin points to ${peeled.slice(0, 12)}, not ${head.slice(0, 12)}`);
    }
    const pkg = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'));
    if (pkg.version !== parsed.version) problems.push(`apps/desktop/package.json says version ${pkg.version}, the tag says ${parsed.version}`);
  }

  if (!env.CSC_NAME) problems.push('CSC_NAME is not set: export CSC_NAME="Your Name (TEAMID)" (your Developer ID Application identity, in the login keychain)');
  if (env.CSC_LINK) problems.push('CSC_LINK is set: this script signs with the identity in your keychain (CSC_NAME); unset CSC_LINK');
  const credentials = notaryCredentials({ ...env, APPLE_API_KEY: expandHome(env.APPLE_API_KEY) });
  if (!credentials) problems.push('no notarization credentials: APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_KEYCHAIN_PROFILE');
  else if (credentials.kind === 'App Store Connect API key' && !fileExists(expandHome(env.APPLE_API_KEY))) problems.push('APPLE_API_KEY does not name an existing .p8 file');

  const auth = run('gh', ['auth', 'status'], { quiet: true });
  if (auth.status !== 0) problems.push('gh is not logged in (gh auth login)');

  if (problems.length) throw new Error(`cannot release:\n  - ${problems.join('\n  - ')}`);
  return { ...parsed, commit };
}

/** The files of a macOS release in the release folder. */
export function macReleaseFiles(version) {
  const files = [];
  for (const arch of MAC_ARCHS) {
    const base = `${PRODUCT}-${version}-mac-${arch}`;
    files.push(`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`);
  }
  files.push('latest-mac.yml');
  return files;
}

/** spctl/stapler/syspolicy_check on a quarantined copy of the app in a DMG (what a download gets). */
function checkAppFromDmg({ dmg, run, problems, arch }) {
  const work = mkdtempSync(join(tmpdir(), 'orbitdrop-release-check-'));
  const mount = join(work, 'mnt');
  mkdirSync(mount);
  const attach = run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]);
  if (attach.status !== 0) {
    problems.push(`${arch}: cannot mount the DMG: ${attach.stderr.trim()}`);
    rmSync(work, { recursive: true, force: true });
    return;
  }
  try {
    const copy = join(work, `${PRODUCT}.app`);
    must(run, 'ditto', [join(mount, `${PRODUCT}.app`), copy]);
    const stamp = Math.floor(Date.now() / 1000).toString(16);
    must(run, 'xattr', ['-w', 'com.apple.quarantine', `0081;${stamp};OrbitDrop release check;`, copy]);
    const spctl = run('spctl', ['--assess', '--type', 'execute', '-vv', copy]);
    if (spctl.status !== 0 || !/source=Notarized Developer ID/.test(`${spctl.stderr}${spctl.stdout}`)) problems.push(`${arch}: app from the DMG: spctl ${`${spctl.stderr}${spctl.stdout}`.trim()}`);
    if (run('xcrun', ['stapler', 'validate', copy]).status !== 0) problems.push(`${arch}: app from the DMG: no valid stapled ticket`);
    const policy = run('syspolicy_check', ['distribution', copy]);
    if (policy.status === -1) console.warn(`  ⚠ syspolicy_check is not available on this macOS; skipped (${arch})`);
    else if (policy.status !== 0) problems.push(`${arch}: syspolicy_check distribution: ${`${policy.stdout}${policy.stderr}`.trim().split('\n').slice(-4).join(' | ')}`);
  } finally {
    if (run('hdiutil', ['detach', mount]).status !== 0) run('hdiutil', ['detach', '-force', mount]);
    try {
      rmSync(work, { recursive: true, force: true });
    } catch (err) {
      console.warn(`  ⚠ could not remove ${work}: ${err.message}`);
    }
  }
}

/**
 * Checks the built release before anything is uploaded. Returns the problems (empty = ready).
 * `appChecks: false` skips mounting the DMGs (tests).
 */
export async function verifyMacRelease({ dir = RELEASE_DIR, version, commit, run, appChecks = true }) {
  const problems = [];
  for (const name of macReleaseFiles(version)) if (!existsSync(join(dir, name))) problems.push(`${name} is missing`);
  if (problems.length) return problems;

  for (const arch of MAC_ARCHS) {
    const reportFile = join(dir, `build-report-darwin-${arch}.json`);
    if (!existsSync(reportFile)) {
      problems.push(`${arch}: no build report`);
      continue;
    }
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    if (report.version !== version) problems.push(`${arch}: the build report is for version ${report.version}`);
    if (commit && (report.source?.commit !== commit || report.source?.dirty)) problems.push(`${arch}: built from ${report.source?.commit?.slice(0, 12) ?? 'an unknown commit'}${report.source?.dirty ? ' with uncommitted changes' : ''}, not ${commit.slice(0, 12)}`);
    if (report.signing?.mode !== 'Developer ID') problems.push(`${arch}: signing is "${report.signing?.mode}", not Developer ID`);
    if (report.signing?.notarize !== true) problems.push(`${arch}: the app was not notarized`);
    if (report.dmgNotarization?.ok !== true) problems.push(`${arch}: the DMG was not signed, notarized and stapled`);
    if (report.smoke?.ok !== true) problems.push(`${arch}: the smoke test did not pass`);
    if (report.nativeCheck?.ran && report.nativeCheck.ok !== true) problems.push(`${arch}: the native-module check failed`);
    if (report.inspection?.buildInfo?.signing !== 'developer-id') problems.push(`${arch}: build-info.json does not say developer-id`);
  }

  const info = yaml().load(readFileSync(join(dir, 'latest-mac.yml'), 'utf8'));
  for (const p of await checkUpdateInfo(info, dir, { platform: 'darwin', version, archs: MAC_ARCHS })) problems.push(`latest-mac.yml: ${p}`);

  for (const arch of MAC_ARCHS) {
    const dmg = join(dir, `${PRODUCT}-${version}-mac-${arch}.dmg`);
    const spctl = run('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-v', dmg]);
    if (spctl.status !== 0 || !/source=Notarized Developer ID/.test(`${spctl.stderr}${spctl.stdout}`)) problems.push(`${arch}: DMG: spctl ${`${spctl.stderr}${spctl.stdout}`.trim()}`);
    if (run('xcrun', ['stapler', 'validate', dmg]).status !== 0) problems.push(`${arch}: DMG: no valid stapled ticket`);
    if (appChecks) checkAppFromDmg({ dmg, run, problems, arch });
  }
  return problems;
}

/** Adds the macOS files to the draft release and rewrites SHA256SUMS.txt over all its assets. */
export async function uploadMacRelease({ tag, version, prerelease, dir = RELEASE_DIR, run, workDir }) {
  const release = ensureDraftRelease({ tag, title: `${PRODUCT} ${version}`, notes: releaseNotes(version), prerelease, run, workDir });
  const names = macReleaseFiles(version);
  const files = names.map((name) => join(dir, name));
  const localHashes = new Map();
  for (const [i, name] of names.entries()) localHashes.set(name, await sha256File(files[i]));
  uploadAssets({ tag, files, run });
  const entries = await refreshSha256Sums({ tag, run, localHashes, workDir });
  uploadAssets({ tag, files: [join(workDir, SUMS_FILE)], run });
  return { release, uploaded: names, sums: entries.length };
}

async function main() {
  const argv = process.argv.slice(2);
  const tag = argv.find((a) => !a.startsWith('--'));
  const skipBuild = argv.includes('--skip-build');
  const dryRun = argv.includes('--dry-run');
  const run = createRunner();
  const env = { ...process.env };
  if (env.APPLE_API_KEY) env.APPLE_API_KEY = expandHome(env.APPLE_API_KEY);

  console.log(`\n▶ OrbitDrop macOS release ${tag ?? '(no tag)'}${dryRun ? ' (dry run: nothing is uploaded)' : ''}`);
  const plan = preflight({ tag, env, run });
  console.log(`  ${plan.tag} = ${plan.commit.slice(0, 12)}, version ${plan.version}${plan.prerelease ? ' (prerelease)' : ''}; repository ${REPO}`);

  if (!skipBuild) {
    console.log('\n▶ node scripts/package.mjs mac --arch all --require-signing --require-notarization');
    const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'package.mjs'), 'mac', '--arch', 'all', '--require-signing', '--require-notarization'], { cwd: ROOT, env, stdio: 'inherit' });
    if (build.status !== 0) throw new Error(`packaging failed (exit ${build.status}); nothing was uploaded`);
  }

  console.log('\n▶ verify the packages (build reports, latest-mac.yml, spctl, stapler, syspolicy_check)');
  const problems = await verifyMacRelease({ version: plan.version, commit: plan.commit, run });
  if (problems.length) throw new Error(`the packages are not ready; nothing was uploaded:\n  - ${problems.join('\n  - ')}`);
  console.log('  all checks passed');
  if (dryRun) {
    console.log('\n✔ dry run finished: the packages are ready; nothing was uploaded');
    return;
  }

  console.log(`\n▶ upload to the draft release ${plan.tag}`);
  const workDir = mkdtempSync(join(tmpdir(), 'orbitdrop-release-'));
  try {
    const result = await uploadMacRelease({ tag: plan.tag, version: plan.version, prerelease: plan.prerelease, run, workDir });
    console.log(`  uploaded ${result.uploaded.join(', ')}; ${SUMS_FILE} covers ${result.sums} assets`);
    console.log(`\n✔ ${result.release.html_url ?? plan.tag} has the macOS packages. It is still a DRAFT: check it and publish it by hand (docs/RELEASING.md).`);
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
