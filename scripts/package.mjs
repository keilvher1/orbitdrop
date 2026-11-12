#!/usr/bin/env node
// OrbitDrop packaging driver (cross-platform Node ESM, no shell features).
//
//   node scripts/package.mjs mac [--arch arm64|x64|all]     (run on macOS)
//   node scripts/package.mjs win [--arch x64]               (run on Windows)
//
// Steps: preflight → third-party license list → icon check → native helper
// (scripts/build-native.mjs) → electron-vite build → product id check (appId = the AppUserModelID
// in the main bundle) → electron-builder per arch (before-pack hook fixes the pnpm node_modules
// collection, after-pack hook verifies the package and its dependency tree) → inspection (macOS:
// Info.plist, codesign, DMG layout; both: Electron fuses read back) → the packaged app's
// `--smoke-test` (x64 via `arch -x86_64` on Apple Silicon) → native-module check of the packaged
// sharp/libvips(+librsvg)/@napi-rs/canvas files and the pdf-lib/docx writers → report.
//
// Every package gets Resources/build-info.json {version, commit, dirty, signing, builtAt} (handed
// to the after-pack hook in ORBITDROP_BUILD_INFO; the app shows the commit in About and decides
// whether it can update itself) and Resources/app-update.yml (electron-builder.yml `publish`).
// The update metadata (latest-mac.yml: both architectures' zips merged into one file; latest.yml)
// is checked against the files it names. Developer ID builds with notarization credentials also
// get signed, notarized and stapled DMGs (scripts/mac-dmg.mjs).
//
// Signing: real signing happens only when credentials are provided through the environment
// (macOS: CSC_LINK/CSC_NAME [+ APPLE_* for notarization]; Windows: WIN_CSC_LINK/CSC_LINK +
// CSC_KEY_PASSWORD), or — Windows releases — through SignPath (--signpath, below). Otherwise the build
// is explicitly UNSIGNED: macOS apps get an ad-hoc signature (hardened runtime,
// build/entitlements.mac.adhoc.plist), notarization is disabled, and every artifact name carries
// "-unsigned". Nothing is ever published.
//
// Windows: every package's own executables (OrbitDrop.exe, OrbitDropHelper.exe, the installer and its
// uninstaller) must carry ProductName "OrbitDrop" and ProductVersion = apps/desktop/package.json's
// version (scripts/win-files.mjs); their Authenticode status must match the signing mode. The signing hook
// scripts/win-sign.cjs (electron-builder.yml win.signtoolOptions.sign) fixes OrbitDrop.exe's ProductVersion
// string and keeps a copy of the uninstaller for these checks.
//
// SignPath (Windows releases, .github/workflows/release.yml; docs/packaging.md §5): the signing happens
// between three runs of this script in the same job, each followed by a SignPath signing request:
//   --signpath prepare    full build (app folder + an installer that is thrown away), checks, smoke test;
//                         stages OrbitDrop.exe, OrbitDropHelper.exe and the uninstaller in
//                         release/signpath/request-1/ (request 1)
//   --signpath installer --signed <dir>   the signed request-1 files (each checked to be the staged file
//                         plus a signature) go into the app folder; electron-builder builds the installer
//                         from it (--prepackaged) and puts the signed uninstaller in (scripts/win-sign.cjs);
//                         the installer is staged in release/signpath/request-2/ (request 2)
//   --signpath finish --signed <dir>      the signed installer replaces the unsigned one, latest.yml gets its
//                         new sha512 and size, then every check, the smoke test, the native-module check, the
//                         install test (--install-test) and the build report, with Valid signatures required.
// ORBITDROP_SIGNPATH_REHEARSAL=1 marks a rehearsal of that flow (a self-signed stand-in instead of SignPath,
// release.yml): the artifacts are labelled "-rehearsal" and never go to a release.
//
// Options:
//   --arch <a>          arm64 | x64 | all (mac); x64 (win). Default: host architecture.
//   --dir               only produce the unpacked app (no dmg/zip/nsis)
//   --unsigned          ignore signing credentials even if present
//   --require-signing   fail unless signing credentials are present
//   --require-notarization  (macOS) also fail unless the apps and the DMGs end up notarized and
//                       stapled (needs CSC_NAME — the identity in a keychain — and APPLE_* credentials)
//   --skip-native       use the helper already staged in apps/desktop/resources/helper/
//   --skip-build        reuse apps/desktop/out (skip electron-vite build)
//   --skip-smoke        do not launch the packaged app (also skips the native-module check)
//   --allow-incomplete  continue when the native helper or the --smoke-test mode is missing
//                       (artifacts are labelled "-incomplete"); for pipeline testing only
//   --smoke-timeout <s> seconds before the smoke test is killed (default 180: more than the app's own
//                       120 s limit for the engine probe, so a stuck probe still prints its report)
//   --rosetta-smoke <m> strict (default) | best-effort: how a failed smoke test of the x64 package
//                       under Rosetta 2 counts (it is tried twice, the second time with the translation
//                       cache warm). best-effort reports it without failing the build — for CI runners
//                       whose Rosetta 2 is unreliable (GitHub's macOS VM, docs/verification.md)
//   --install-test      Windows: silently install the NSIS package per-user into a temp folder,
//                       check the HKCU uninstall entry, installer-preferences.json (update check on), the
//                       installed executables' version information and signatures, smoke-test the installed
//                       exe, uninstall (the file goes too); then once more with /NOUPDATECHECK (the file says off)
//   --signpath <stage>  Windows release builds signed through SignPath: prepare | installer | finish (above)
//   --signed <dir>      the files SignPath returned for the previous request (installer and finish stages)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSigningIdentity, notaryCredentials, signAndNotarizeDmg } from './mac-dmg.mjs';
import { checkUpdateInfo, createRunner, mergeUpdateInfo, refreshUpdateInfo, yaml } from './release-lib.mjs';
import { readWindowsFileFacts, signatureAddedOnly, signatureProblems, versionInfoProblems } from './win-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const RELEASE = join(DESKTOP, 'release');
const require = createRequire(import.meta.url);
const isWin = process.platform === 'win32';
const rel = (p) => {
  const r = relative(ROOT, p).split('\\').join('/');
  return r.startsWith('../') ? p : r || '.';
};

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const target = argv[0] && !argv[0].startsWith('--') ? argv[0] : process.platform === 'win32' ? 'win' : 'mac';
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const opts = {
  dir: flag('dir'),
  unsigned: flag('unsigned'),
  requireSigning: flag('require-signing') || flag('require-notarization'),
  requireNotarization: flag('require-notarization'),
  skipNative: flag('skip-native'),
  skipBuild: flag('skip-build'),
  skipSmoke: flag('skip-smoke'),
  allowIncomplete: flag('allow-incomplete'),
  installTest: flag('install-test'),
  smokeTimeoutMs: Number(option('smoke-timeout', '180')) * 1000,
  rosettaSmoke: option('rosetta-smoke', 'strict'),
  signpath: option('signpath', null),
  // Absolute: the signing hook reads files from it with electron-builder's working directory (apps/desktop).
  signedDir: option('signed', null) === null ? null : resolve(option('signed', null)),
};

const errors = []; // always fatal
const incomplete = []; // fatal unless --allow-incomplete (missing helper / smoke-test mode)
const fatal = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n▶ ${msg}`);

if (!['mac', 'win'].includes(target)) fatal(`unknown target "${target}" (expected mac or win)`);
if (!['strict', 'best-effort'].includes(opts.rosettaSmoke)) fatal(`--rosetta-smoke must be strict or best-effort, not "${opts.rosettaSmoke}"`);
if (target === 'mac' && process.platform !== 'darwin') fatal('macOS packages are built on macOS (codesign, hdiutil, the Swift helper). Use the macOS CI job.');
if (target === 'win' && process.platform !== 'win32') fatal('Windows packages are built on Windows (MSVC helper, win32 sharp/canvas binaries). Use the Windows CI job.');
if (opts.signpath !== null) {
  if (!['prepare', 'installer', 'finish'].includes(opts.signpath)) fatal(`--signpath must be prepare, installer or finish, not "${opts.signpath}"`);
  if (target !== 'win') fatal('--signpath is for Windows packages (macOS packages are signed with the Developer ID: docs/RELEASING.md)');
  if (opts.unsigned || opts.dir) fatal('--signpath cannot be combined with --unsigned or --dir');
  if (opts.signpath !== 'prepare' && !(opts.signedDir && existsSync(opts.signedDir))) fatal(`--signpath ${opts.signpath} needs --signed <folder with the files SignPath returned>`);
}
/** The second and third SignPath runs reuse what the first one built in this job (helper, bundles, licences). */
const signpathLater = opts.signpath === 'installer' || opts.signpath === 'finish';
const rehearsal = opts.signpath !== null && process.env.ORBITDROP_SIGNPATH_REHEARSAL === '1';

const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const archArg = option('arch', hostArch);
const archs = target === 'mac' ? (archArg === 'all' ? ['arm64', 'x64'] : [archArg]) : [archArg];
for (const a of archs) {
  if (target === 'mac' && !['arm64', 'x64'].includes(a)) fatal(`unsupported macOS arch "${a}" (arm64, x64 or all)`);
  if (target === 'win' && a !== 'x64') fatal(`unsupported Windows arch "${a}" (only x64 is in scope)`);
}
const os = target === 'mac' ? 'darwin' : 'win32';

// ── helpers ──────────────────────────────────────────────────────────────────
function run(cmd, args, { cwd = ROOT, env = process.env, allowFail = false } = {}) {
  console.log(`  $ ${[cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (r.error) {
    if (allowFail) return { status: -1, error: r.error };
    fatal(`${cmd} failed to start: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) fatal(`${cmd} ${args[0] ?? ''} exited with ${r.status}`);
  return r;
}
function capture(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), error: r.error };
}
function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
function duBytes(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    total += duBytes(join(p, e.name));
  }
  return total;
}
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const nodeScript = (script, args, extra) => run(process.execPath, [join(ROOT, 'scripts', script), ...args], extra);
const packageDir = (name) => join(ROOT, 'node_modules', ...name.split('/'));

// ── 1. preflight ─────────────────────────────────────────────────────────────
step(`OrbitDrop package: ${target} [${archs.join(', ')}]${opts.dir ? ' (dir only)' : ''}`);
const desktopPkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'));
console.log(`  version ${desktopPkg.version}, node ${process.version}, host ${process.platform}-${process.arch}`);
// electron-builder.yml, parsed with electron-builder's own YAML reader (appId, fuses).
const builderYml = createRequire(require.resolve('app-builder-lib/package.json'))('js-yaml').load(readFileSync(join(DESKTOP, 'electron-builder.yml'), 'utf8'));

for (const a of archs) {
  const needed =
    target === 'mac'
      ? [`@img/sharp-darwin-${a}`, `@img/sharp-libvips-darwin-${a}`, `@napi-rs/canvas-darwin-${a}`]
      : [`@img/sharp-win32-${a}`, `@napi-rs/canvas-win32-${a}-msvc`];
  const missing = needed.filter((n) => !existsSync(join(packageDir(n), 'package.json')));
  if (missing.length) fatal(`native packages for ${os}-${a} are not installed: ${missing.join(', ')}\n  (pnpm-workspace.yaml supportedArchitectures must include ${a}; then run pnpm install)`);
}

let rosetta = true;
if (target === 'mac' && hostArch === 'arm64' && archs.includes('x64')) {
  rosetta = capture('arch', ['-x86_64', '/usr/bin/true']).status === 0;
  if (!rosetta) console.warn('  ⚠ Rosetta 2 is not available: the x64 smoke test will be skipped');
}

// ── 2. signing plan ──────────────────────────────────────────────────────────
const env = { ...process.env };
const credentialVars =
  target === 'mac'
    ? ['CSC_LINK', 'CSC_NAME', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE']
    : ['CSC_LINK', 'WIN_CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_KEY_PASSWORD'];
// GitHub passes unset secrets as empty strings; treat them as absent.
for (const v of credentialVars) if (env[v] === '') delete env[v];
const hasSigningCreds = target === 'mac' ? Boolean(env.CSC_LINK || env.CSC_NAME) : Boolean(env.WIN_CSC_LINK || env.CSC_LINK);
const canNotarize =
  target === 'mac' &&
  Boolean((env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) || (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) || env.APPLE_KEYCHAIN_PROFILE);
if (opts.requireSigning && opts.signpath === null && (!hasSigningCreds || opts.unsigned)) fatal('--require-signing: no signing credentials in the environment (see docs/packaging.md)');
// SignPath builds are signed (by SignPath, between the stages), never by a local certificate.
const signed = opts.signpath !== null || (hasSigningCreds && !opts.unsigned);
const signing =
  opts.signpath !== null
    ? { mode: rehearsal ? 'Authenticode (SignPath rehearsal: self-signed stand-in, never released)' : 'Authenticode (SignPath)', notarize: null, signpath: opts.signpath }
    : signed
      ? { mode: target === 'mac' ? 'Developer ID' : 'Authenticode', notarize: target === 'mac' ? canNotarize : null }
      : { mode: target === 'mac' ? 'unsigned (ad-hoc signature)' : 'unsigned', notarize: target === 'mac' ? false : null };
console.log(`  signing: ${signing.mode}${target === 'mac' ? `, notarization: ${signing.notarize ? 'yes' : 'no'}` : ''}${opts.signpath ? `, SignPath stage: ${opts.signpath}` : ''}`);
if (opts.signpath !== null && hasSigningCreds) console.warn('  ⚠ WIN_CSC_LINK/CSC_LINK is set but ignored: this build is signed through SignPath');
if (signed && target === 'mac' && !canNotarize) console.warn('  ⚠ signed but NOT notarized (no APPLE_* credentials): Gatekeeper will still block downloaded copies');
if (opts.requireNotarization && target === 'mac' && !canNotarize) fatal('--require-notarization: no notarization credentials (APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_KEYCHAIN_PROFILE; see docs/RELEASING.md)');

// DMGs: signed, notarized and stapled by this script (scripts/mac-dmg.mjs) for Developer ID builds
// with notarization credentials. Their identity must be on the keychain search list (CSC_NAME):
// a CSC_LINK certificate only exists in electron-builder's temporary keychain during its run.
const runner = createRunner();
let dmgPlan = { mode: 'none', reason: target === 'mac' ? 'no DMG (--dir)' : 'not macOS' };
if (target === 'mac' && !opts.dir) {
  if (!signed) dmgPlan = { mode: 'unsigned', reason: 'unsigned build: the DMG is not signed' };
  else if (!canNotarize) dmgPlan = { mode: 'skipped', reason: 'no notarization credentials' };
  else if (!env.CSC_NAME) dmgPlan = { mode: 'skipped', reason: 'CSC_NAME is not set: a CSC_LINK certificate is gone once electron-builder exits, so the DMG cannot be signed' };
  else {
    const credentials = notaryCredentials(env);
    let identity;
    try {
      identity = findSigningIdentity({ name: env.CSC_NAME, run: runner });
    } catch (err) {
      fatal(`DMG signing: ${err.message}`);
    }
    dmgPlan = { mode: 'notarize', identity, credentials };
    console.log(`  DMGs: signed with the same Developer ID, notarized (${credentials.kind}) and stapled`);
  }
  if (dmgPlan.mode !== 'notarize') console.log(`  DMGs: not notarized (${dmgPlan.reason})`);
  if (opts.requireNotarization && dmgPlan.mode !== 'notarize') fatal(`--require-notarization: ${dmgPlan.reason}`);
}

// electron-builder detects the package manager from apps/desktop (no lockfile there) and
// otherwise from npm_config_user_agent. Advertise pnpm when not launched through pnpm so the
// pnpm node_modules collector is used.
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (!/\bpnpm\//.test(env.npm_config_user_agent ?? '') && String(rootPkg.packageManager).startsWith('pnpm@')) {
  env.npm_config_user_agent = `pnpm/${rootPkg.packageManager.slice(5)} node/${process.version} ${process.platform} ${process.arch}`;
}

const builderConfig = [];
if (!signed || opts.signpath !== null) {
  for (const v of credentialVars) delete env[v];
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  if (target === 'mac' && !signed) {
    // Ad-hoc signing involves no credentials, so it is safe on pull-request CI too
    // (electron-builder otherwise skips all signing when GITHUB_BASE_REF is set).
    env.CSC_FOR_PULL_REQUEST = 'true';
    builderConfig.push(
      '-c.mac.identity=-',
      '-c.mac.notarize=false',
      '-c.mac.entitlements=build/entitlements.mac.adhoc.plist',
      '-c.mac.entitlementsInherit=build/entitlements.mac.adhoc.plist',
    );
  }
}

// Windows: the signing hook (scripts/win-sign.cjs) records what electron-builder signs and copies the
// uninstaller it generated, for the checks below (and for SignPath request 1).
const UNINSTALLER_NAME = `Uninstall ${desktopPkg.productName}.exe`;
const uninstallerCopy = join(RELEASE, 'uninstaller', UNINSTALLER_NAME);
const signLog = join(RELEASE, 'sign-requests.jsonl');
if (target === 'win') {
  env.ORBITDROP_UNINSTALLER_COPY = uninstallerCopy;
  env.ORBITDROP_SIGN_LOG = signLog;
  delete env.ORBITDROP_SIGNED_UNINSTALLER;
}

// ── 3. license list + icons ──────────────────────────────────────────────────
if (signpathLater) {
  step(`SignPath ${opts.signpath} stage: licences, icons, helper and bundles come from the prepare stage of this job`);
} else {
  step('third-party license list');
  if (!existsSync(join(ROOT, 'scripts', 'licenses.mjs'))) fatal('scripts/licenses.mjs is missing');
  nodeScript('licenses.mjs', []);
  step('icons');
  nodeScript('gen-icons.mjs', ['--verify']);
}

// ── 4. native helper ─────────────────────────────────────────────────────────
const helperName = target === 'mac' ? 'OrbitDropHelper' : 'OrbitDropHelper.exe';
const stagedHelper = (a) => join(DESKTOP, 'resources', 'helper', `${os}-${a}`, helperName);
if (!signpathLater) step('native helper');
const nativeScript = join(ROOT, 'scripts', target === 'mac' ? 'build-native-mac.mjs' : 'build-native-win.mjs');
for (const a of signpathLater ? [] : archs) {
  if (!opts.skipNative) {
    if (!existsSync(nativeScript)) {
      incomplete.push(`native helper build script ${rel(nativeScript)} does not exist yet (owned by the ${target === 'mac' ? 'macos' : 'windows'}-helper workstream)`);
    } else {
      const r = nodeScript('build-native.mjs', [target, '--arch', a], { allowFail: true });
      if (r.status !== 0) incomplete.push(`native helper build failed for ${os}-${a} (exit ${r.status})`);
    }
  }
  if (existsSync(stagedHelper(a))) console.log(`  helper staged: ${rel(stagedHelper(a))} (${mb(statSync(stagedHelper(a)).size)})`);
  else incomplete.push(`native helper not staged at ${rel(stagedHelper(a))}`);
  // A MinGW cross-build from macOS is a compile check only; never package it as a real installer.
  const buildInfo = join(dirname(stagedHelper(a)), 'BUILD_INFO.txt');
  if (target === 'win' && existsSync(buildInfo) && readFileSync(buildInfo, 'utf8').includes('CROSS-COMPILED')) {
    if (process.env.ORBITDROP_ALLOW_CROSS_HELPER === '1') console.log(`  WARNING: ${rel(buildInfo)} says CROSS-COMPILED (allowed by ORBITDROP_ALLOW_CROSS_HELPER=1; not for release)`);
    else fatal(`${rel(buildInfo)} says CROSS-COMPILED / NOT VERIFIED ON WINDOWS. Build the helper on Windows (node scripts/build-native-win.mjs), or set ORBITDROP_ALLOW_CROSS_HELPER=1 for a config-only test build.`);
  }
}
const helperMissing = !signpathLater && archs.some((a) => !existsSync(stagedHelper(a)));
if (incomplete.length && !opts.allowIncomplete) fatal(`cannot package:\n  - ${incomplete.join('\n  - ')}\n  (use --allow-incomplete to test the pipeline anyway; artifacts will be labelled "-incomplete")`);

// ── 5. bundles ───────────────────────────────────────────────────────────────
step('electron-vite build');
if (!opts.skipBuild && !signpathLater) {
  const viteCli = join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
  run(process.execPath, [viteCli, 'build'], { cwd: DESKTOP });
}
for (const f of ['out/main/index.js', 'out/main/processor-host.js', 'out/preload/index.js', 'out/renderer/index.html']) {
  if (!existsSync(join(DESKTOP, f))) fatal(`bundle missing: apps/desktop/${f}`);
}
// The product id lives in electron-builder.yml and, as the Windows AppUserModelID (notifications,
// taskbar grouping, the NSIS shortcut), in apps/desktop/src/main/index.ts. They must agree.
const mainBundle = readFileSync(join(DESKTOP, 'out', 'main', 'index.js'), 'utf8');
const aumid = (mainBundle.match(/setAppUserModelId\(\s*["'`]([^"'`]+)["'`]\s*\)/) || [])[1];
if (!aumid) console.warn('  ⚠ no literal setAppUserModelId("…") in out/main/index.js; cannot compare it with appId');
else if (aumid !== builderYml.appId) fatal(`appId mismatch: electron-builder.yml says "${builderYml.appId}", apps/desktop/src/main/index.ts sets AppUserModelID "${aumid}" (change both; docs/packaging.md "제품 ID")`);
// The windows load the UI from file:// inside app.asar (loadFile), which needs this fuse enabled.
const uiFromFile = /\.loadFile\(/.test(mainBundle);

// ── 6a. SignPath stages (Windows releases: .github/workflows/release.yml, docs/packaging.md §5) ──
const SIGNPATH_DIR = join(RELEASE, 'signpath');
const SIGNPATH_STATE = join(SIGNPATH_DIR, 'state.json');
const winExe = `${desktopPkg.productName}.exe`;
/** Request 1: our executables inside the app folder, and the uninstaller (which goes into the installer). */
const REQUEST_1 = [
  { name: winExe, inApp: [winExe] },
  { name: 'OrbitDropHelper.exe', inApp: ['resources', 'helper', 'OrbitDropHelper.exe'] },
  { name: UNINSTALLER_NAME, inApp: null },
];

function readSignpathState() {
  if (!existsSync(SIGNPATH_STATE)) fatal(`${rel(SIGNPATH_STATE)} is missing: run --signpath prepare first, in the same job`);
  const state = JSON.parse(readFileSync(SIGNPATH_STATE, 'utf8'));
  if (state.version !== desktopPkg.version || state.commit !== (source?.commit ?? null)) {
    fatal(`${rel(SIGNPATH_STATE)} belongs to ${state.version} (${state.commit}), not to this ${desktopPkg.version} checkout (${source?.commit ?? 'no commit'})`);
  }
  return state;
}

/**
 * A file SignPath returned must be the file that was sent plus a signature (scripts/win-files.mjs), with a
 * Valid signature and the right version information. Returns the problems.
 */
function checkSignedFile(sent, returned) {
  if (!existsSync(returned)) return [`${basename(returned)} is not among the files SignPath returned (${rel(dirname(returned))})`];
  const match = signatureAddedOnly(readFileSync(sent), readFileSync(returned));
  if (!match.ok) return [`${basename(returned)}: not the file sent for signing plus a signature (${match.reason})`];
  const facts = readWindowsFileFacts([returned]);
  return [...signatureProblems(facts, { expected: 'signed' }), ...versionInfoProblems(facts, { productName: desktopPkg.productName, version: desktopPkg.version })];
}

/** prepare, after every check passed: request 1 in release/signpath/request-1/ and the state for the next stages. */
function stageRequest1(result) {
  step('SignPath request 1: stage OrbitDrop.exe, OrbitDropHelper.exe and the uninstaller');
  const dir = join(SIGNPATH_DIR, 'request-1');
  rmSync(SIGNPATH_DIR, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const item of REQUEST_1) {
    const from = item.inApp ? join(ROOT, result.app.path, ...item.inApp) : uninstallerCopy;
    if (!existsSync(from)) {
      errors.push(`SignPath request 1: ${rel(from)} is missing`);
      continue;
    }
    copyFileSync(from, join(dir, item.name));
    files.push({ name: item.name, bytes: statSync(from).size });
    console.log(`  ${item.name} (${mb(statSync(from).size)})`);
  }
  writeFileSync(SIGNPATH_STATE, `${JSON.stringify({ version: desktopPkg.version, commit: source?.commit ?? null, request1: files }, null, 2)}\n`);
  // The installer built in this stage contains the unsigned executables: the installer stage builds the real one.
  for (const x of result.artifacts) rmSync(join(ROOT, x.path), { force: true });
  rmSync(join(RELEASE, 'latest.yml'), { force: true });
  result.artifacts = [];
  console.log(`  → upload ${rel(dir)} as the artifact of SignPath request 1 (artifact configuration apps/desktop/build/signpath/windows-binaries.xml)`);
}

/** installer, before electron-builder: the signed request-1 files go into the app folder (each one checked). */
function useSignedRequest1(appDir) {
  step(`SignPath installer: the signed executables from ${rel(opts.signedDir)}`);
  readSignpathState();
  const problems = [];
  for (const item of REQUEST_1) problems.push(...checkSignedFile(join(SIGNPATH_DIR, 'request-1', item.name), join(opts.signedDir, item.name)));
  if (problems.length) fatal(`SignPath request 1 did not return what was sent, signed:\n  - ${problems.join('\n  - ')}`);
  for (const item of REQUEST_1) {
    if (!item.inApp) continue;
    copyFileSync(join(opts.signedDir, item.name), join(appDir, ...item.inApp));
    console.log(`  ${item.name}: signed copy in ${rel(join(appDir, ...item.inApp))}`);
  }
  // scripts/win-sign.cjs puts this signed uninstaller into the installer instead of the one NSIS generates now.
  env.ORBITDROP_SIGNED_UNINSTALLER = join(opts.signedDir, UNINSTALLER_NAME);
}

/** installer, after every check passed: request 2 (the installer) in release/signpath/request-2/. */
function stageRequest2(result) {
  step('SignPath request 2: stage the installer');
  const state = readSignpathState();
  const setup = result.artifacts.find((x) => x.path.endsWith('-setup.exe'));
  if (!setup) {
    errors.push('SignPath request 2: electron-builder built no installer');
    return;
  }
  const dir = join(SIGNPATH_DIR, 'request-2');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const name = basename(setup.path);
  copyFileSync(join(ROOT, setup.path), join(dir, name));
  writeFileSync(SIGNPATH_STATE, `${JSON.stringify({ ...state, request2: { name, bytes: setup.bytes, sha256: setup.sha256 } }, null, 2)}\n`);
  console.log(`  ${name} (${mb(setup.bytes)}) → upload ${rel(dir)} as the artifact of SignPath request 2 (apps/desktop/build/signpath/windows-installer.xml)`);
}

/** finish: the signed installer replaces the unsigned one, latest.yml follows it. False when it cannot. */
async function useSignedInstaller() {
  const state = readSignpathState();
  if (!state.request2?.name) fatal(`${rel(SIGNPATH_STATE)} names no installer: run --signpath installer first`);
  const name = state.request2.name;
  const problems = checkSignedFile(join(SIGNPATH_DIR, 'request-2', name), join(opts.signedDir, name));
  if (problems.length) {
    for (const problem of problems) errors.push(`SignPath request 2: ${problem}`);
    return false;
  }
  copyFileSync(join(opts.signedDir, name), join(RELEASE, name));
  const file = join(RELEASE, 'latest.yml');
  if (!existsSync(file)) {
    errors.push(`${rel(file)} is missing (written by the installer stage)`);
    return false;
  }
  const info = await refreshUpdateInfo(yaml().load(readFileSync(file, 'utf8')), RELEASE);
  writeFileSync(file, yaml().dump(info, { lineWidth: 8000, noRefs: true }));
  console.log(`  ${name}: signed (${mb(statSync(join(RELEASE, name)).size)}); latest.yml: new sha512 and size`);
  return true;
}

// ── 6. electron-builder per arch ─────────────────────────────────────────────
const labels = [];
if (!signed) labels.push('unsigned');
if (rehearsal) labels.push('rehearsal');
if (helperMissing) labels.push('incomplete');
const suffix = labels.map((l) => `-${l}`).join('');
if (suffix) {
  builderConfig.push(`-c.artifactName=\${productName}-\${version}-\${os}-\${arch}${suffix}.\${ext}`);
  if (target === 'mac') builderConfig.push(`-c.dmg.title=\${productName} \${version}${labels.length ? ` (${labels.join(', ')})` : ''}`);
  if (target === 'win') builderConfig.push(`-c.nsis.artifactName=\${productName}-\${version}-win-\${arch}${suffix}-setup.\${ext}`);
}
if (helperMissing) env.ORBITDROP_ALLOW_MISSING_HELPER = '1';

// Snapshot of apps/desktop/out (paths, sizes, mtimes): if another process rebuilds the bundles
// while electron-builder copies them, the package could mix two builds — detect and fail.
function outManifest() {
  const list = [];
  const walkOut = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkOut(p);
      else {
        const st = statSync(p);
        list.push(`${relative(DESKTOP, p)}:${st.size}:${Math.round(st.mtimeMs)}`);
      }
    }
  };
  walkOut(join(DESKTOP, 'out'));
  return list.sort().join('\n');
}

/** Source the packages were built from, so a recorded artifact can be traced to a commit. */
function sourceRevision() {
  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0) return null;
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout.trim() !== '';
  return { commit: head.stdout.trim(), dirty };
}
const source = sourceRevision();
// Resources/build-info.json, written by the after-pack hook before signing (scripts/after-pack.cjs).
env.ORBITDROP_BUILD_INFO = JSON.stringify({
  version: desktopPkg.version,
  commit: source?.commit ?? null,
  dirty: source?.dirty ?? false,
  signing: target === 'mac' ? (signed ? 'developer-id' : 'adhoc') : signed ? 'authenticode' : 'none',
  builtAt: new Date().toISOString(),
});

const builderCli = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const results = [];
/** latest-mac.yml of every macOS arch run (each run writes only its own zip; merged below). */
const macUpdateInfos = [];
for (const a of archs) {
  const started = Date.now() - 2000;
  const outBefore = outManifest();
  const targets = opts.dir ? ['dir'] : target === 'mac' ? ['dmg', 'zip'] : ['nsis'];
  const winAppDir = join(RELEASE, 'win-unpacked');
  let status;
  if (opts.signpath === 'finish') {
    // No electron-builder run: the installer SignPath signed replaces the one the installer stage built.
    step(`SignPath finish: the signed installer from ${rel(opts.signedDir)}`);
    status = (await useSignedInstaller()) ? 0 : 1;
  } else {
    if (target === 'win') {
      rmSync(signLog, { force: true });
      rmSync(dirname(uninstallerCopy), { recursive: true, force: true });
    }
    // SignPath installer stage: the signed executables go into the app folder, which electron-builder packs as it is.
    const prepackaged = opts.signpath === 'installer' ? ['--prepackaged', winAppDir] : [];
    if (opts.signpath === 'installer') useSignedRequest1(winAppDir);
    step(`electron-builder ${target} ${a}${prepackaged.length ? ' (installer from the signed app folder)' : ''}`);
    const r = run(process.execPath, [builderCli, `--${target}`, ...targets, `--${a}`, '--publish', 'never', '--projectDir', '.', ...prepackaged, ...builderConfig], {
      cwd: DESKTOP,
      env,
      allowFail: true,
    });
    status = r.status;
  }
  const result = { os, arch: a, ok: status === 0, signing, labels, artifacts: [], app: null, inspection: {}, smoke: null };
  results.push(result);
  if (outManifest() !== outBefore) {
    result.ok = false;
    errors.push(`apps/desktop/out changed while packaging ${os}-${a} (another build ran concurrently); re-run the packaging`);
    continue;
  }
  if (!result.ok) {
    console.error(`  ✖ electron-builder failed for ${os}-${a} (exit ${status}); see the after-pack messages above`);
    continue;
  }
  // unpacked app produced by electron-builder
  const appDir = target === 'mac' ? join(RELEASE, a === 'arm64' ? 'mac-arm64' : 'mac', `${desktopPkg.productName}.app`) : winAppDir;
  result.app = { path: rel(appDir), bytes: existsSync(appDir) ? duBytes(appDir) : 0 };
  // artifacts written during this run (blockmaps: differential downloads of the macOS zips)
  for (const name of existsSync(RELEASE) ? readdirSync(RELEASE) : []) {
    const p = join(RELEASE, name);
    const st = statSync(p);
    if (!st.isFile() || st.mtimeMs < started) continue;
    if (!/\.(dmg|zip|exe|blockmap)$/.test(name) || !name.includes(a)) continue;
    result.artifacts.push({ path: rel(p), bytes: st.size, sha256: await sha256(p) });
  }
  // The next arch run overwrites latest-mac.yml: keep this run's copy.
  const macInfoFile = join(RELEASE, 'latest-mac.yml');
  if (target === 'mac' && existsSync(macInfoFile) && statSync(macInfoFile).mtimeMs >= started) macUpdateInfos.push(yaml().load(readFileSync(macInfoFile, 'utf8')));
  if (target === 'mac') inspectMac(result, appDir, a);
  else inspectWin(result, appDir);
  inspectUpdateFiles(result, target === 'mac' ? join(appDir, 'Contents', 'Resources') : join(appDir, 'resources'), a);
  result.inspection.fuses = await inspectFuses(target === 'mac' ? appDir : join(appDir, `${desktopPkg.productName}.exe`), a);
}

// ── 7. inspection ────────────────────────────────────────────────────────────
function inspectMac(result, appDir, a) {
  step(`inspect ${rel(appDir)}`);
  const ins = result.inspection;
  const plist = capture('plutil', ['-convert', 'json', '-o', '-', join(appDir, 'Contents', 'Info.plist')]);
  if (plist.status === 0) {
    const info = JSON.parse(plist.out);
    ins.infoPlist = {
      CFBundleIdentifier: info.CFBundleIdentifier,
      CFBundleShortVersionString: info.CFBundleShortVersionString,
      LSMinimumSystemVersion: info.LSMinimumSystemVersion,
      LSUIElement: info.LSUIElement,
      ElectronAsarIntegrity: Boolean(info.ElectronAsarIntegrity),
    };
    ins.infoPlist.NSHumanReadableCopyright = info.NSHumanReadableCopyright;
    ins.infoPlist.LSApplicationCategoryType = info.LSApplicationCategoryType;
    // Privacy usage descriptions: OrbitDrop requests no camera/microphone/Bluetooth/… access
    // (electron-builder.yml removes Electron's template keys).
    ins.infoPlist.usageDescriptions = Object.keys(info).filter((k) => /UsageDescription$/.test(k));
    if (info.LSUIElement !== true) errors.push(`${a}: Info.plist LSUIElement is not true`);
    if (info.LSMinimumSystemVersion !== '14.0') errors.push(`${a}: LSMinimumSystemVersion is ${info.LSMinimumSystemVersion}, expected 14.0`);
    if (info.CFBundleIdentifier !== builderYml.appId) errors.push(`${a}: CFBundleIdentifier is ${info.CFBundleIdentifier}, electron-builder.yml appId is ${builderYml.appId}`);
    if (ins.infoPlist.usageDescriptions.length) errors.push(`${a}: Info.plist asks for permissions OrbitDrop never uses: ${ins.infoPlist.usageDescriptions.join(', ')}`);
  }
  const main = join(appDir, 'Contents', 'MacOS', desktopPkg.productName);
  ins.mainArchs = capture('lipo', ['-archs', main]).out;
  const helper = join(appDir, 'Contents', 'Resources', 'helper', 'OrbitDropHelper');
  if (existsSync(helper)) {
    ins.helper = { archs: capture('lipo', ['-archs', helper]).out, signature: signatureSummary(helper), entitlements: entitlementKeys(helper) };
    // build/sign.cjs signs the drag helper with the hardened runtime and no entitlements.
    if (ins.helper.entitlements === null || ins.helper.entitlements.length) errors.push(`${a}: the helper must be signed without entitlements, found ${JSON.stringify(ins.helper.entitlements)}`);
    if (!/runtime/.test(ins.helper.signature)) errors.push(`${a}: the helper is not signed with the hardened runtime`);
  } else ins.helper = null;
  const natives = [];
  const nm = join(appDir, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
  for (const sub of [`@img/sharp-darwin-${a}/lib`, `@img/sharp-libvips-darwin-${a}/lib`, `@napi-rs/canvas-darwin-${a}`]) {
    const d = join(nm, ...sub.split('/'));
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (/\.(node|dylib)$/.test(f)) natives.push(`${sub}/${f}: ${capture('lipo', ['-archs', join(d, f)]).out}`);
  }
  ins.natives = natives;
  ins.signature = signatureSummary(appDir);
  const verify = capture('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir]);
  ins.codesignVerify = verify.status === 0 ? 'valid' : `INVALID: ${verify.out.split('\n').slice(-3).join(' | ')}`;
  if (verify.status !== 0) errors.push(`${a}: codesign --verify failed`);
  const spctl = capture('spctl', ['--assess', '--type', 'execute', '-vv', appDir]);
  ins.gatekeeper = `${spctl.status === 0 ? 'accepted' : 'rejected'}: ${spctl.out.split('\n')[0]}`;
  for (const [k, v] of Object.entries(ins)) console.log(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
}

/**
 * Reads the Electron fuse wire back from the packaged binary (macOS: the .app, Windows: the .exe)
 * and compares every fuse configured in electron-builder.yml. Also refuses a package whose UI
 * could not load: the windows use loadFile() (file:// inside app.asar), which fails with
 * ERR_FILE_NOT_FOUND when GrantFileProtocolExtraPrivileges is disabled.
 */
async function inspectFuses(binary, a) {
  // The copy electron-builder itself uses to flip the fuses.
  const { getCurrentFuseWire, FuseV1Options } = createRequire(require.resolve('app-builder-lib/package.json'))('@electron/fuses');
  const STATE = { 48: 'disabled', 49: 'enabled', 114: 'removed', 144: 'inherit' };
  let wire;
  try {
    wire = await getCurrentFuseWire(binary);
  } catch (err) {
    errors.push(`${a}: cannot read the Electron fuses of ${rel(binary)}: ${err.message}`);
    return null;
  }
  const fuses = {};
  for (const [name, index] of Object.entries(FuseV1Options)) {
    if (typeof index === 'number' && wire[index] !== undefined) fuses[name] = STATE[wire[index]] ?? String(wire[index]);
  }
  for (const [key, wanted] of Object.entries(builderYml.electronFuses ?? {})) {
    const name = key.charAt(0).toUpperCase() + key.slice(1);
    if (typeof wanted !== 'boolean' || !(name in FuseV1Options)) continue;
    const expected = wanted ? 'enabled' : 'disabled';
    if (fuses[name] !== expected) errors.push(`${a}: fuse ${name} is ${fuses[name]} in the package, electron-builder.yml asks for ${expected}`);
  }
  if (uiFromFile && fuses.GrantFileProtocolExtraPrivileges !== 'enabled') {
    errors.push(`${a}: GrantFileProtocolExtraPrivileges is ${fuses.GrantFileProtocolExtraPrivileges} but the windows load the UI with loadFile() from app.asar — every window would fail with ERR_FILE_NOT_FOUND`);
  }
  console.log(`  fuses: ${Object.entries(fuses).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return fuses;
}

/** Entitlement keys embedded in a signature ([] when none or empty), null if unreadable. */
function entitlementKeys(path) {
  const r = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', path], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const xml = (r.stdout ?? '').trim();
  if (!xml) return [];
  const j = spawnSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' });
  if (j.status !== 0) return null;
  return Object.keys(JSON.parse(j.stdout || '{}'));
}

function signatureSummary(path) {
  const r = capture('codesign', ['-dvvv', path]);
  if (r.status !== 0) return `unsigned (${r.out.split('\n').pop()})`;
  const get = (k) => (r.out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
  const flags = get('CodeDirectory v') ? (r.out.match(/flags=0x[0-9a-f]+\(([^)]*)\)/) || [])[1] : undefined;
  const authority = (r.out.match(/^Authority=(.*)$/m) || [])[1];
  return [authority ? `authority=${authority}` : `signature=${get('Signature') ?? 'unknown'}`, `team=${get('TeamIdentifier') ?? 'none'}`, `flags=${flags ?? '?'}`].join(', ');
}

/**
 * Mount a DMG read-only at a fixed mount point under release/ (no temp copies are left
 * behind), check its layout and the app's signature, run `use(appInDmg)` (the smoke test runs
 * the DMG's own bits), then detach.
 */
async function withMountedDmg(dmgPath, a, use) {
  step(`inspect ${rel(dmgPath)} (read-only mount)`);
  const mount = join(RELEASE, `.mnt-${a}`);
  mkdirSync(mount, { recursive: true });
  if (capture('mount', []).out.includes(` on ${mount} `)) capture('hdiutil', ['detach', '-force', mount]);
  const attach = capture('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmgPath]);
  if (attach.status !== 0) {
    errors.push(`${a}: hdiutil attach failed: ${attach.out}`);
    return { mounted: false };
  }
  const out = { mounted: true };
  try {
    out.entries = readdirSync(mount).filter((n) => !n.startsWith('.'));
    const appInDmg = join(mount, `${desktopPkg.productName}.app`);
    out.hasApp = existsSync(appInDmg);
    out.applicationsLink = capture('readlink', [join(mount, 'Applications')]).out;
    if (!out.hasApp || out.applicationsLink !== '/Applications') errors.push(`${a}: unexpected DMG layout ${JSON.stringify(out.entries)}`);
    const verify = capture('codesign', ['--verify', '--deep', '--strict', appInDmg]);
    out.codesignVerify = verify.status === 0 ? 'valid' : `INVALID: ${verify.out}`;
    if (verify.status !== 0) errors.push(`${a}: the app inside the DMG fails codesign --verify`);
    console.log(`  dmg: ${JSON.stringify(out)}`);
    if (out.hasApp) await use(appInDmg);
  } finally {
    const detach = capture('hdiutil', ['detach', mount]);
    if (detach.status !== 0) capture('hdiutil', ['detach', '-force', mount]);
  }
  return out;
}

function inspectWin(result, appDir) {
  step(`inspect ${rel(appDir)}`);
  const ins = result.inspection;
  ins.exe = existsSync(join(appDir, `${desktopPkg.productName}.exe`));
  ins.helper = existsSync(join(appDir, 'resources', 'helper', 'OrbitDropHelper.exe'));
  ins.licenses = existsSync(join(appDir, 'resources', 'THIRD_PARTY_LICENSES.md'));
  ins.electronLicense = existsSync(join(appDir, 'LICENSE.electron.txt'));
  ins.chromiumLicenses = existsSync(join(appDir, 'LICENSES.chromium.html'));
  if (!ins.exe) errors.push('win: OrbitDrop.exe missing from win-unpacked');
  if (!ins.licenses) errors.push('win: THIRD_PARTY_LICENSES.md missing from resources');
  // What electron-builder handed to the signing hook in this run (scripts/win-sign.cjs; none in the finish stage).
  if (existsSync(signLog)) {
    ins.signRequests = readFileSync(signLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).name);
  }
  for (const [k, v] of Object.entries(ins)) console.log(`  ${k}: ${JSON.stringify(v)}`);
  inspectWinExecutables(result, appDir);
}

/** The Authenticode state OrbitDrop's own executables must be in after this run (null: mixed, SignPath installer stage). */
function expectedWinSignatures() {
  if (opts.signpath === 'prepare') return 'unsigned'; // SignPath signs them after this stage
  if (opts.signpath === 'installer') return null; // the executables are signed, the new installer not yet
  return signed ? 'signed' : 'unsigned';
}

/**
 * OrbitDrop.exe, OrbitDropHelper.exe, the installer and the uninstaller (the copy the signing hook kept):
 * ProductName "OrbitDrop", ProductVersion = the package version, and the signature state of this build
 * (scripts/win-files.mjs). The facts go to the build report (`signatures`).
 */
function inspectWinExecutables(result, appDir) {
  const files = [join(appDir, `${desktopPkg.productName}.exe`), join(appDir, 'resources', 'helper', 'OrbitDropHelper.exe')];
  const setup = result.artifacts.find((x) => x.path.endsWith('-setup.exe'));
  if (setup) files.push(join(ROOT, setup.path));
  if (existsSync(uninstallerCopy)) files.push(uninstallerCopy);
  else if (!opts.dir) errors.push(`win: no copy of the uninstaller at ${rel(uninstallerCopy)} — electron-builder did not call scripts/win-sign.cjs (electron-builder.yml win.signtoolOptions.sign)`);
  let facts = [];
  try {
    facts = readWindowsFileFacts(files.filter((f) => existsSync(f)));
  } catch (err) {
    errors.push(`win: ${err.message}`);
  }
  const expected = expectedWinSignatures();
  const versionProblems = versionInfoProblems(facts, { productName: desktopPkg.productName, version: desktopPkg.version });
  const signatureIssues = expected === null ? [] : signatureProblems(facts, { expected });
  for (const problem of [...versionProblems, ...signatureIssues]) errors.push(`win: ${problem}`);
  result.signatures = {
    expected,
    ok: facts.length === files.length && versionProblems.length === 0 && signatureIssues.length === 0 && expected !== null,
    files: facts.map((f) => ({ file: basename(f.path), productName: f.productName, productVersion: f.productVersion, fileVersion: f.fileVersion, signature: f.signature, signer: f.signer ?? null, timestamped: Boolean(f.timestamped) })),
  };
  for (const f of result.signatures.files) console.log(`  ${f.file}: ${f.productName} ${f.productVersion} · ${f.signature}${f.signer ? ` (${f.signer})` : ''}`);
}

/**
 * Resources/app-update.yml (electron-updater's configuration, from electron-builder.yml `publish`)
 * and Resources/build-info.json (scripts/after-pack.cjs) must be in every package (a --dir app folder
 * gets no app-update.yml: electron-builder writes it for installable targets only).
 */
function inspectUpdateFiles(result, resources, a) {
  const ins = result.inspection;
  const updateConfig = join(resources, 'app-update.yml');
  if (opts.dir) {
    // electron-builder writes app-update.yml only for runs with dmg/zip (macOS) or NSIS (Windows) targets.
    ins.updateConfig = existsSync(updateConfig) ? 'present (--dir build)' : 'not written for --dir builds (only with dmg/zip or NSIS targets)';
  } else if (existsSync(updateConfig)) {
    const config = yaml().load(readFileSync(updateConfig, 'utf8')) ?? {};
    ins.updateConfig = { provider: config.provider, owner: config.owner, repo: config.repo, updaterCacheDirName: config.updaterCacheDirName, publisherName: config.publisherName ?? null };
    const wanted = builderYml.publish ?? {};
    if (config.provider !== wanted.provider || config.owner !== wanted.owner || config.repo !== wanted.repo) errors.push(`${a}: app-update.yml says ${config.provider} ${config.owner}/${config.repo}, electron-builder.yml publishes to ${wanted.provider} ${wanted.owner}/${wanted.repo}`);
  } else {
    ins.updateConfig = null;
    errors.push(`${a}: Resources/app-update.yml is missing (electron-builder.yml publish) — the app could never update`);
  }
  const buildInfo = join(resources, 'build-info.json');
  ins.buildInfo = existsSync(buildInfo) ? JSON.parse(readFileSync(buildInfo, 'utf8')) : null;
  if (!ins.buildInfo) errors.push(`${a}: Resources/build-info.json is missing (scripts/after-pack.cjs)`);
  else if (ins.buildInfo.version !== desktopPkg.version) errors.push(`${a}: build-info.json says version ${ins.buildInfo.version}, the package is ${desktopPkg.version}`);
  console.log(`  update config: ${JSON.stringify(ins.updateConfig)}; build info: ${JSON.stringify(ins.buildInfo)}`);
}

// ── 7b. DMG: sign, notarize, staple, verify (Developer ID + notarization credentials) ──
if (target === 'mac' && dmgPlan.mode === 'notarize') {
  for (const result of results) {
    if (!result.ok) continue;
    const artifact = result.artifacts.find((x) => x.path.endsWith('.dmg'));
    if (!artifact) {
      errors.push(`${result.arch}: no DMG to notarize`);
      continue;
    }
    step(`sign, notarize and staple ${rel(join(ROOT, artifact.path))}`);
    try {
      result.dmgNotarization = signAndNotarizeDmg({ dmg: join(ROOT, artifact.path), identity: dmgPlan.identity, credentials: dmgPlan.credentials, run: runner, log: console.log });
      console.log(`  DMG: notarization ${result.dmgNotarization.notarization?.status} (${result.dmgNotarization.notarization?.id}), stapled, spctl ${result.dmgNotarization.spctl}, stapler validate ${result.dmgNotarization.staplerValidate}`);
    } catch (err) {
      result.dmgNotarization = err.report ?? { ok: false, error: err.message };
      errors.push(`${result.arch}: ${err.message}`);
    }
    // Stapling changed the DMG: its size and SHA-256 are those of the final file.
    const path = join(ROOT, artifact.path);
    artifact.bytes = statSync(path).size;
    artifact.sha256 = await sha256(path);
  }
} else if (target === 'mac') {
  for (const result of results) if (result.ok) result.dmgNotarization = { ok: false, skipped: dmgPlan.reason };
}

// ── 8. smoke test ────────────────────────────────────────────────────────────
/** The SignPath installer stage only builds the installer; the finish stage runs every check on the signed result. */
const runChecks = opts.signpath !== 'installer';
function smokeTest(binary, { x64OnArm = false } = {}) {
  return new Promise((resolve) => {
    const cmd = x64OnArm ? 'arch' : binary;
    // --smoke-optional-helper (desktop-main) lets the self test pass without the native helper;
    // only used for --allow-incomplete pipeline runs where the helper is known to be missing.
    const appArgs = ['--smoke-test', ...(helperMissing && opts.allowIncomplete ? ['--smoke-optional-helper'] : [])];
    const args = x64OnArm ? ['-x86_64', binary, ...appArgs] : appArgs;
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.ORBITDROP_HELPER_PATH;
    // Chromium's own messages (GPU process, renderer start-up) go to stderr too, so a failing smoke
    // test shows why a window did not load (stderr is printed only when it fails).
    childEnv.ELECTRON_ENABLE_LOGGING = '1';
    const started = Date.now();
    console.log(`  $ ${[cmd, ...args].join(' ')}`);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, detached: !isWin, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const kill = () => {
      if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }, 3000).unref();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.smokeTimeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ran: false, error: err.message });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (!isWin) {
        try {
          process.kill(-child.pid, 'SIGKILL'); // stray Electron helpers, if any
        } catch {}
      }
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('ORBITDROP_SMOKE '));
      let report = null;
      let parseError = null;
      if (line) {
        try {
          report = JSON.parse(line.slice('ORBITDROP_SMOKE '.length));
        } catch (err) {
          parseError = err.message;
        }
      }
      const tail = (s, lines = 8) => s.trim().split(/\r?\n/).slice(-lines).join('\n');
      resolve({
        ran: true,
        exitCode: code,
        signal,
        timedOut,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        ok: Boolean(report && report.ok === true && code === 0),
        implemented: Boolean(line),
        report,
        parseError,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr, 60),
      });
    });
  });
}

async function runSmoke(result, binary) {
  const a = result.arch;
  const x64OnArm = target === 'mac' && a === 'x64' && hostArch === 'arm64';
  if (x64OnArm && !rosetta) {
    result.smoke = { ran: false, error: 'Rosetta 2 unavailable' };
    return;
  }
  step(`smoke test ${os}-${a}${x64OnArm ? ' (Rosetta 2)' : ''}: ${rel(binary)}`);
  const attempt = async () => {
    const s = await smokeTest(binary, { x64OnArm });
    if (s.report) console.log(`  ORBITDROP_SMOKE ${JSON.stringify(s.report)}`);
    console.log(`  exit=${s.exitCode} signal=${s.signal ?? '-'} timedOut=${s.timedOut} ${s.seconds}s → ${s.ok ? 'OK' : 'FAILED'}`);
    if (!s.ok) {
      if (s.stdoutTail) console.log(`  stdout (tail):\n${s.stdoutTail.replace(/^/gm, '    ')}`);
      if (s.stderrTail) console.log(`  stderr (tail):\n${s.stderrTail.replace(/^/gm, '    ')}`);
    }
    return s;
  };
  result.smoke = await attempt();
  // The first launch under Rosetta 2 translates Electron's x86_64 code while the app starts; on a slow
  // machine that alone can break the run. A second launch finds the translation cache warm.
  if (x64OnArm && !result.smoke.ok) {
    console.log('  first launch under Rosetta 2 failed; trying again with the translation cache warm');
    result.smoke = { ...(await attempt()), firstAttempt: { ok: false, exitCode: result.smoke.exitCode, signal: result.smoke.signal, timedOut: result.smoke.timedOut, seconds: result.smoke.seconds } };
  }
  const s = result.smoke;
  if (!s.ok) {
    if (x64OnArm && opts.rosettaSmoke === 'best-effort') {
      s.bestEffort = true;
      console.warn(`  ⚠ ${os}-${a}: the smoke test under Rosetta 2 failed twice; counted as best effort (--rosetta-smoke best-effort), not as a build failure`);
    } else if (s.implemented) errors.push(`${os}-${a}: the smoke test reported failure (exit ${s.exitCode})`);
    else incomplete.push(`${os}-${a}: the app printed no ORBITDROP_SMOKE line within ${opts.smokeTimeoutMs / 1000}s (is --smoke-test implemented in apps/desktop/src/main?)`);
  }
}

for (const result of results) {
  if (!result.ok) continue;
  const exe = (appPath) => (target === 'mac' ? join(appPath, 'Contents', 'MacOS', desktopPkg.productName) : join(appPath, `${desktopPkg.productName}.exe`));
  const dmg = target === 'mac' ? result.artifacts.find((x) => x.path.endsWith('.dmg')) : null;
  if (dmg) {
    // macOS: smoke-test the app inside the DMG (what users install), straight from the mount.
    result.inspection.dmg = await withMountedDmg(join(ROOT, dmg.path), result.arch, async (appInDmg) => {
      if (!opts.skipSmoke) await runSmoke(result, exe(appInDmg));
    });
    if (result.smoke) result.smoke.ranFrom = 'dmg';
  } else if (!opts.skipSmoke && runChecks) {
    await runSmoke(result, exe(join(ROOT, result.app.path)));
    if (result.smoke) result.smoke.ranFrom = 'app folder';
  }
}

// ── 9. native-module check (stock Electron runtime + the packaged module files) ──
// The packaged binary cannot run arbitrary scripts (RunAsNode fuse off, asar-only), so a stock
// Electron of the same version runs apps/desktop/build/native-check against the package's
// Resources: librsvg in libvips (Add Background SVG gradients/masks), @napi-rs/canvas loaded from
// app.asar.unpacked with a system Korean font (Annotate), target-arch native files mapped.
const electronVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
function cachedElectronZip(name) {
  const roots = [env.ELECTRON_CACHE, env.electron_config_cache, join(homedir(), 'Library', 'Caches', 'electron')].filter(Boolean);
  for (const r of roots) {
    if (!existsSync(r)) continue;
    if (existsSync(join(r, name))) return join(r, name);
    for (const d of readdirSync(r)) if (existsSync(join(r, d, name))) return join(r, d, name);
  }
  return null;
}
function electronRuntime(a) {
  if (target === 'win') {
    const exe = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    return a === hostArch && existsSync(exe) ? { cmd: exe, args: [] } : null;
  }
  const hostBin = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  if (a === hostArch) return existsSync(hostBin) ? { cmd: hostBin, args: [] } : null;
  if (a === 'x64' && hostArch === 'arm64' && rosetta) {
    // electron-builder downloaded this runtime for the x64 package; reuse it (under Rosetta 2).
    const dir = join(RELEASE, `.electron-${electronVersion}-darwin-x64`);
    const bin = join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron');
    if (!existsSync(bin)) {
      const zip = cachedElectronZip(`electron-v${electronVersion}-darwin-x64.zip`);
      if (!zip) return null;
      mkdirSync(dir, { recursive: true });
      if (capture('ditto', ['-x', '-k', zip, dir]).status !== 0) return null;
    }
    return { cmd: 'arch', args: ['-x86_64', bin] };
  }
  return null;
}
function nativeCheck(result) {
  const resources = target === 'mac' ? join(ROOT, result.app.path, 'Contents', 'Resources') : join(ROOT, result.app.path, 'resources');
  const rt = electronRuntime(result.arch);
  if (!rt) return { ran: false, reason: `no Electron ${electronVersion} runtime for ${os}-${result.arch} on this host` };
  step(`native-module check ${os}-${result.arch} (Electron ${electronVersion} utilityProcess + packaged modules)`);
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(rt.cmd, [...rt.args, join(DESKTOP, 'build', 'native-check'), resources], { encoding: 'utf8', timeout: 150000, env: childEnv, windowsHide: true });
  const line = `${r.stdout ?? ''}`.split(/\r?\n/).find((l) => l.startsWith('NATIVE_CHECK '));
  if (!line) return { ran: true, ok: false, problems: [`no NATIVE_CHECK line (exit ${r.status}): ${`${r.stdout ?? ''}`.trim().split('\n').slice(-3).join(' | ')}`] };
  const report = JSON.parse(line.slice('NATIVE_CHECK '.length));
  console.log(`  librsvg ${report.sharp?.rsvg ?? 'MISSING'} (libvips ${report.sharp?.vips}), Korean font: ${report.koreanFont ?? 'none'}, Hangul ink: ${report.hangulInkPixels ?? 0}px`);
  console.log(`  pdf-lib: ${report.pdfLib ? `${report.pdfLib.pages} page, ${report.pdfLib.bytes} bytes` : 'FAILED'}; docx: ${report.docx ? `${report.docx.bytes} bytes` : 'FAILED'}`);
  for (const p of report.loaded ?? []) console.log(`  loaded ${rel(p)}`);
  for (const w of report.warnings ?? []) console.warn(`  ⚠ ${w}`);
  console.log(`  → ${report.ok ? 'OK' : `FAILED: ${report.problems.join('; ')}`}`);
  return { ran: true, ...report };
}
if (!opts.skipSmoke && runChecks) {
  for (const result of results) {
    if (!result.ok) continue;
    result.nativeCheck = nativeCheck(result);
    if (result.nativeCheck.ran && !result.nativeCheck.ok) errors.push(`${os}-${result.arch}: native-module check failed: ${result.nativeCheck.problems.join('; ')}`);
    if (!result.nativeCheck.ran) console.warn(`  ⚠ native-module check skipped for ${os}-${result.arch}: ${result.nativeCheck.reason}`);
  }
}

// ── 10. Windows install / uninstall test ─────────────────────────────────────
const PREFERENCES_FILE = 'installer-preferences.json';
const uninstallKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const uninstallEntryPresent = () => {
  const r = capture('reg', ['query', uninstallKey, '/s', '/f', desktopPkg.productName, '/d']);
  return r.status === 0 && r.out.includes(desktopPkg.productName);
};
/** installer-preferences.json of an installation folder (apps/desktop/build/installer.nsh), parsed; null when missing or not JSON. */
function installedPreferences(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, PREFERENCES_FILE), 'utf8'));
  } catch {
    return null;
  }
}
/** Runs the uninstaller silently and waits for it: the NSIS uninstaller re-launches itself from %TEMP% and returns at once. */
async function uninstallSilently(dir, uninstaller, exe) {
  spawnSync(join(dir, uninstaller), ['/S'], { stdio: 'inherit', timeout: 300000 });
  // The copy removes the files first and the uninstall registry key after them. Wait for both (seen on the runner: the
  // key was still there right after the files had gone).
  for (let i = 0; i < 60 && (existsSync(exe) || uninstallEntryPresent()); i++) await new Promise((r) => setTimeout(r, 1000));
  return { uninstalled: !existsSync(exe), uninstallEntryRemoved: !uninstallEntryPresent(), installFolderRemoved: !existsSync(dir), preferencesRemoved: !existsSync(join(dir, PREFERENCES_FILE)) };
}

async function installTestWin(result) {
  const setup = result.artifacts.find((x) => x.path.endsWith('-setup.exe'));
  const out = { ran: false };
  if (!setup) return { ...out, error: 'no NSIS installer was built' };
  const dir = mkdtempSync(join(tmpdir(), 'orbitdrop-install-'));
  const setupPath = join(ROOT, setup.path);
  step(`install test: ${rel(setupPath)} /S → ${dir}`);
  // NSIS: /S = silent; /D= must be the last argument and must not be quoted.
  const install = spawnSync(setupPath, ['/S', `/D=${dir}`], { stdio: 'inherit', windowsVerbatimArguments: true, timeout: 300000 });
  out.ran = true;
  out.installExit = install.status;
  const exe = join(dir, `${desktopPkg.productName}.exe`);
  out.installed = existsSync(exe);
  out.helper = existsSync(join(dir, 'resources', 'helper', 'OrbitDropHelper.exe'));
  out.licenses = existsSync(join(dir, 'resources', 'THIRD_PARTY_LICENSES.md')) && existsSync(join(dir, 'LICENSES.chromium.html'));
  const uninstaller = readdirSync(dir).find((f) => /^Uninstall .*\.exe$/i.test(f));
  out.uninstaller = uninstaller ?? null;
  out.perUserUninstallEntry = uninstallEntryPresent();
  const regLm = capture('reg', ['query', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', desktopPkg.productName, '/d']);
  out.perMachineUninstallEntry = regLm.status === 0 && regLm.out.includes(desktopPkg.productName);
  // A silent install keeps the default: automatic update checks on.
  out.preferences = installedPreferences(dir);
  // What the installer put on disk: OrbitDrop.exe, the helper and the uninstaller as they were built (and signed).
  if (out.installed) {
    const installedFiles = [exe, join(dir, 'resources', 'helper', 'OrbitDropHelper.exe'), ...(uninstaller ? [join(dir, uninstaller)] : [])].filter((f) => existsSync(f));
    try {
      const facts = readWindowsFileFacts(installedFiles);
      out.files = facts.map((f) => ({ file: basename(f.path), productName: f.productName, productVersion: f.productVersion, signature: f.signature, signer: f.signer ?? null }));
      const expected = expectedWinSignatures();
      out.fileProblems = [...versionInfoProblems(facts, { productName: desktopPkg.productName, version: desktopPkg.version }), ...(expected ? signatureProblems(facts, { expected }) : [])];
    } catch (err) {
      out.fileProblems = [err.message];
    }
  }
  if (out.installed && !opts.skipSmoke) {
    step('smoke test (installed copy)');
    out.smoke = await smokeTest(exe);
    console.log(`  exit=${out.smoke.exitCode} timedOut=${out.smoke.timedOut} → ${out.smoke.ok ? 'OK' : 'FAILED'}`);
  }
  if (uninstaller) {
    step('uninstall');
    Object.assign(out, await uninstallSilently(dir, uninstaller, exe));
  }
  // /NOUPDATECHECK: the same silent install with the update check off (the box on the installer's privacy page).
  const dirOff = mkdtempSync(join(tmpdir(), 'orbitdrop-install-noupdatecheck-'));
  step(`install test: ${rel(setupPath)} /S /NOUPDATECHECK → ${dirOff}`);
  const installOff = spawnSync(setupPath, ['/S', '/NOUPDATECHECK', `/D=${dirOff}`], { stdio: 'inherit', windowsVerbatimArguments: true, timeout: 300000 });
  const exeOff = join(dirOff, `${desktopPkg.productName}.exe`);
  out.noUpdateCheck = { installExit: installOff.status, installed: existsSync(exeOff), preferences: installedPreferences(dirOff) };
  const uninstallerOff = existsSync(dirOff) ? readdirSync(dirOff).find((f) => /^Uninstall .*\.exe$/i.test(f)) : undefined;
  if (uninstallerOff) Object.assign(out.noUpdateCheck, await uninstallSilently(dirOff, uninstallerOff, exeOff));

  console.log(`  install test: ${JSON.stringify({ ...out, smoke: out.smoke ? { ok: out.smoke.ok, report: out.smoke.report } : undefined })}`);
  const preferences = (p, autoCheck) => p !== null && typeof p === 'object' && p.version === 1 && p.updates?.autoCheck === autoCheck;
  if (install.status !== 0 || !out.installed) errors.push(`win: silent per-user install failed (exit ${install.status})`);
  if (out.installed && !out.helper) errors.push('win: installed app has no resources/helper/OrbitDropHelper.exe');
  if (out.installed && !out.licenses) errors.push('win: installed app is missing licence files');
  if (out.perMachineUninstallEntry) errors.push('win: installer registered itself under HKLM (expected per-user HKCU only)');
  if (out.installed && !out.perUserUninstallEntry) errors.push('win: no HKCU uninstall entry after install');
  if (out.installed && !preferences(out.preferences, true)) errors.push(`win: /S install: ${PREFERENCES_FILE} is ${JSON.stringify(out.preferences)}, expected {"version":1,"updates":{"autoCheck":true}}`);
  for (const problem of out.fileProblems ?? []) errors.push(`win: installed copy: ${problem}`);
  if (out.smoke && !out.smoke.ok) (out.smoke.implemented ? errors : incomplete).push('win: smoke test of the installed copy did not pass');
  if (uninstaller && (!out.uninstalled || !out.uninstallEntryRemoved)) errors.push('win: silent uninstall left files or registry entries behind');
  if (uninstaller && !out.preferencesRemoved) errors.push(`win: the uninstaller left ${PREFERENCES_FILE} behind`);
  if (installOff.status !== 0 || !out.noUpdateCheck.installed) errors.push(`win: silent install with /NOUPDATECHECK failed (exit ${installOff.status})`);
  else if (!preferences(out.noUpdateCheck.preferences, false)) errors.push(`win: /S /NOUPDATECHECK install: ${PREFERENCES_FILE} is ${JSON.stringify(out.noUpdateCheck.preferences)}, expected {"version":1,"updates":{"autoCheck":false}}`);
  if (out.noUpdateCheck.installed && (!out.noUpdateCheck.uninstalled || !out.noUpdateCheck.preferencesRemoved)) errors.push('win: uninstalling the /NOUPDATECHECK install left files behind');
  return out;
}
if (target === 'win' && opts.installTest && !opts.dir && (opts.signpath === null || opts.signpath === 'finish')) {
  for (const result of results) if (result.ok) result.installTest = await installTestWin(result);
}

// ── 10b. update metadata (latest-mac.yml merged from both arch runs / latest.yml) ──
let updateInfo = null;
// The SignPath prepare stage throws its installer away and the installer stage's one is not signed yet: the finish stage checks.
const builtTargets = opts.signpath === 'prepare' || opts.signpath === 'installer' ? [] : results.filter((r) => r.ok && !opts.dir);
if (builtTargets.length > 0) {
  const file = join(RELEASE, target === 'mac' ? 'latest-mac.yml' : 'latest.yml');
  let info = null;
  if (target === 'mac') {
    info = mergeUpdateInfo(macUpdateInfos);
    if (info) writeFileSync(file, yaml().dump(info, { lineWidth: 8000, noRefs: true }));
  } else if (existsSync(file)) {
    info = yaml().load(readFileSync(file, 'utf8'));
  }
  if (!info) errors.push(`electron-builder wrote no ${rel(file)} (electron-builder.yml publish) — installed copies could not update to this build`);
  else {
    const problems = await checkUpdateInfo(info, RELEASE, { platform: os, version: desktopPkg.version, archs: builtTargets.map((r) => r.arch) });
    updateInfo = { file: rel(file), files: info.files.map((f) => f.url), problems };
    for (const p of problems) errors.push(`${rel(file)}: ${p}`);
    console.log(`\n  update metadata ${rel(file)}: ${updateInfo.files.join(', ')}${problems.length ? ` — ${problems.length} problem(s)` : ' — consistent with the files'}`);
  }
}
if (opts.requireNotarization && target === 'mac') {
  for (const r of results) {
    if (r.ok && !r.signing.notarize) errors.push(`${r.os}-${r.arch}: the app was not notarized (--require-notarization)`);
    if (r.ok && !opts.dir && r.dmgNotarization?.ok !== true) errors.push(`${r.os}-${r.arch}: the DMG is not notarized and stapled (--require-notarization)`);
  }
}

// ── 10c. SignPath: stage the next signing request (only when everything above passed) ──
if (opts.signpath === 'prepare' || opts.signpath === 'installer') {
  const result = results.find((r) => r.ok);
  if (result && errors.length === 0 && incomplete.length === 0) {
    if (opts.signpath === 'prepare') stageRequest1(result);
    else stageRequest2(result);
  } else {
    errors.push(`SignPath ${opts.signpath} stage: nothing staged for signing because of the problems above`);
  }
}

// ── 11. report ───────────────────────────────────────────────────────────────
mkdirSync(RELEASE, { recursive: true });
// The SignPath prepare and installer stages are halfway: the finish stage writes the report of the signed package.
const writeReports = opts.signpath === null || opts.signpath === 'finish';
for (const r of writeReports ? results : []) {
  const file = join(RELEASE, `build-report-${r.os}-${r.arch}.json`);
  writeFileSync(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), version: desktopPkg.version, host: `${process.platform}-${process.arch}`, source, ...r, updateInfo }, null, 2)}\n`);
}
step('summary');
console.log(`  source: ${source ? `${source.commit.slice(0, 12)}${source.dirty ? ' + uncommitted changes' : ''}` : 'unknown (no git)'}`);
for (const r of results) {
  console.log(`  ${r.os}-${r.arch}: ${r.ok ? 'built' : 'BUILD FAILED'} · ${r.signing.mode}${r.labels.length ? ` · labels: ${r.labels.join(', ')}` : ''}`);
  if (r.app) console.log(`    app: ${r.app.path} (${mb(r.app.bytes)})`);
  for (const x of r.artifacts) console.log(`    ${x.path} (${mb(x.bytes)}) sha256 ${x.sha256}`);
  if (r.smoke) console.log(`    smoke: ${r.smoke.ok ? 'OK' : r.smoke.ran ? (r.smoke.implemented ? 'FAILED' : 'not implemented') : `not run (${r.smoke.error})`}${r.smoke.bestEffort ? ' (best effort: Rosetta 2 on this runner)' : ''}${r.smoke.firstAttempt ? ' (second launch)' : ''}`);
  if (r.nativeCheck) console.log(`    native-module check: ${r.nativeCheck.ran ? (r.nativeCheck.ok ? `OK (librsvg ${r.nativeCheck.sharp?.rsvg}, ${r.nativeCheck.koreanFont}, pdf-lib + docx)` : 'FAILED') : `not run (${r.nativeCheck.reason})`}`);
  if (r.dmgNotarization) console.log(`    DMG: ${r.dmgNotarization.ok ? `signed, notarized, stapled (${r.dmgNotarization.spctl})` : r.dmgNotarization.skipped ? `not notarized (${r.dmgNotarization.skipped})` : `FAILED at ${r.dmgNotarization.failedAt ?? '?'}`}`);
  if (r.signatures) console.log(`    executables: ${r.signatures.files.map((f) => `${f.file} ${f.productVersion} ${f.signature}`).join(', ')}${r.signatures.ok ? ' (as expected)' : ''}`);
  if (writeReports) console.log(`    report: ${rel(join(RELEASE, `build-report-${r.os}-${r.arch}.json`))}`);
}
// GitHub Actions job summary (signing status is part of what reviewers must see).
if (process.env.GITHUB_STEP_SUMMARY && !writeReports) {
  const staged = opts.signpath === 'prepare' ? 'request-1' : 'request-2';
  const ok = errors.length === 0 && existsSync(join(SIGNPATH_DIR, staged));
  const line = `### SignPath ${opts.signpath} stage\n\n${ok ? `Staged \`apps/desktop/release/signpath/${staged}/\` for signing.` : '**Failed**: nothing staged for signing (see the log).'}\n`;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, line);
  } catch (err) {
    console.warn(`  ⚠ could not write the job summary: ${err.message}`);
  }
} else if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = ['### OrbitDrop packages', '', '| Target | Signing | Notarized (app / DMG) | Smoke test | Native modules | Artifacts |', '|---|---|---|---|---|---|'];
  for (const r of results) {
    const smoke = (!r.smoke ? 'not run' : r.smoke.ok ? 'OK' : r.smoke.ran ? (r.smoke.implemented ? 'FAILED' : 'not implemented') : `not run (${r.smoke.error})`) + (r.smoke?.bestEffort ? ' (best effort: Rosetta 2 on this runner)' : '');
    const files = r.artifacts.map((x) => `\`${x.path.split('/').pop()}\` (${mb(x.bytes)})`).join('<br>') || (r.ok ? '(dir only)' : 'BUILD FAILED');
    const nat = !r.nativeCheck ? 'not run' : !r.nativeCheck.ran ? 'skipped' : r.nativeCheck.ok ? `OK (librsvg ${r.nativeCheck.sharp?.rsvg}, ${r.nativeCheck.koreanFont}, pdf-lib + docx)` : 'FAILED';
    const notarized = r.signing.notarize === null ? 'n/a' : `${r.signing.notarize ? 'yes' : 'no'} / ${r.dmgNotarization?.ok ? 'yes' : 'no'}`;
    lines.push(`| ${r.os}-${r.arch} | ${r.signing.mode} | ${notarized} | ${smoke} | ${nat} | ${files} |`);
    if (r.installTest) {
      const it = r.installTest;
      lines.push(`| ${r.os}-${r.arch} install test | | | ${it.smoke?.ok ? 'OK' : 'see log'} | | installed=${it.installed}, HKCU entry=${it.perUserUninstallEntry}, update check /S=${it.preferences?.updates?.autoCheck}, /NOUPDATECHECK=${it.noUpdateCheck?.preferences?.updates?.autoCheck}, uninstalled=${it.uninstalled} |`);
    }
    if (r.signatures) lines.push(`| ${r.os}-${r.arch} executables | ${r.signatures.files.map((f) => `\`${f.file}\` ${f.signature}${f.signer ? ` (${f.signer.replace(/\|/g, '/')})` : ''}`).join('<br>')} | | | | ProductName/ProductVersion: ${r.signatures.files.map((f) => `${f.productName} ${f.productVersion}`).join(', ')} |`);
  }
  if (updateInfo) lines.push('', `Update metadata \`${updateInfo.file.split('/').pop()}\`: ${updateInfo.files.map((f) => `\`${f}\``).join(', ')}${updateInfo.problems.length ? ` — **${updateInfo.problems.length} problem(s)**` : ' (checked against the files)'}`);
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  } catch (err) {
    console.warn(`  ⚠ could not write the job summary: ${err.message}`);
  }
}

const failedBuilds = results.filter((r) => !r.ok);
if (failedBuilds.length) errors.push(`electron-builder failed for ${failedBuilds.map((r) => `${r.os}-${r.arch}`).join(', ')}`);
if (incomplete.length) console.warn(`\n⚠ INCOMPLETE${opts.allowIncomplete ? ' (tolerated by --allow-incomplete)' : ''}:\n  - ${incomplete.join('\n  - ')}`);
if (errors.length) console.error(`\n✖ FAILED:\n  - ${errors.join('\n  - ')}`);
if (errors.length || (incomplete.length && !opts.allowIncomplete)) process.exit(1);
console.log(incomplete.length ? '\n✔ pipeline finished, package INCOMPLETE' : '\n✔ done');
