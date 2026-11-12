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
// CSC_KEY_PASSWORD). Otherwise the build is explicitly UNSIGNED: macOS apps get an ad-hoc
// signature (hardened runtime, build/entitlements.mac.adhoc.plist), notarization is disabled,
// and every artifact name carries "-unsigned". Nothing is ever published.
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
//   --install-test      Windows: silently install the NSIS package per-user into a temp folder,
//                       check the HKCU uninstall entry, smoke-test the installed exe, uninstall
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSigningIdentity, notaryCredentials, signAndNotarizeDmg } from './mac-dmg.mjs';
import { checkUpdateInfo, createRunner, mergeUpdateInfo, yaml } from './release-lib.mjs';

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
};

const errors = []; // always fatal
const incomplete = []; // fatal unless --allow-incomplete (missing helper / smoke-test mode)
const fatal = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n▶ ${msg}`);

if (!['mac', 'win'].includes(target)) fatal(`unknown target "${target}" (expected mac or win)`);
if (target === 'mac' && process.platform !== 'darwin') fatal('macOS packages are built on macOS (codesign, hdiutil, the Swift helper). Use the macOS CI job.');
if (target === 'win' && process.platform !== 'win32') fatal('Windows packages are built on Windows (MSVC helper, win32 sharp/canvas binaries). Use the Windows CI job.');

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
if (opts.requireSigning && (!hasSigningCreds || opts.unsigned)) fatal('--require-signing: no signing credentials in the environment (see docs/packaging.md)');
const signed = hasSigningCreds && !opts.unsigned;
const signing = signed
  ? { mode: target === 'mac' ? 'Developer ID' : 'Authenticode', notarize: target === 'mac' ? canNotarize : null }
  : { mode: target === 'mac' ? 'unsigned (ad-hoc signature)' : 'unsigned', notarize: target === 'mac' ? false : null };
console.log(`  signing: ${signing.mode}${target === 'mac' ? `, notarization: ${signing.notarize ? 'yes' : 'no'}` : ''}`);
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
if (!signed) {
  for (const v of credentialVars) delete env[v];
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  if (target === 'mac') {
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

// ── 3. license list + icons ──────────────────────────────────────────────────
step('third-party license list');
if (!existsSync(join(ROOT, 'scripts', 'licenses.mjs'))) fatal('scripts/licenses.mjs is missing');
nodeScript('licenses.mjs', []);
step('icons');
nodeScript('gen-icons.mjs', ['--verify']);

// ── 4. native helper ─────────────────────────────────────────────────────────
const helperName = target === 'mac' ? 'OrbitDropHelper' : 'OrbitDropHelper.exe';
const stagedHelper = (a) => join(DESKTOP, 'resources', 'helper', `${os}-${a}`, helperName);
step('native helper');
const nativeScript = join(ROOT, 'scripts', target === 'mac' ? 'build-native-mac.mjs' : 'build-native-win.mjs');
for (const a of archs) {
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
const helperMissing = archs.some((a) => !existsSync(stagedHelper(a)));
if (incomplete.length && !opts.allowIncomplete) fatal(`cannot package:\n  - ${incomplete.join('\n  - ')}\n  (use --allow-incomplete to test the pipeline anyway; artifacts will be labelled "-incomplete")`);

// ── 5. bundles ───────────────────────────────────────────────────────────────
step('electron-vite build');
if (!opts.skipBuild) {
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

// ── 6. electron-builder per arch ─────────────────────────────────────────────
const labels = [];
if (!signed) labels.push('unsigned');
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
  step(`electron-builder ${target} ${a}`);
  const started = Date.now() - 2000;
  const outBefore = outManifest();
  const targets = opts.dir ? ['dir'] : target === 'mac' ? ['dmg', 'zip'] : ['nsis'];
  const r = run(process.execPath, [builderCli, `--${target}`, ...targets, `--${a}`, '--publish', 'never', '--projectDir', '.', ...builderConfig], {
    cwd: DESKTOP,
    env,
    allowFail: true,
  });
  const result = { os, arch: a, ok: r.status === 0, signing, labels, artifacts: [], app: null, inspection: {}, smoke: null };
  results.push(result);
  if (outManifest() !== outBefore) {
    result.ok = false;
    errors.push(`apps/desktop/out changed while packaging ${os}-${a} (another build ran concurrently); re-run the packaging`);
    continue;
  }
  if (!result.ok) {
    console.error(`  ✖ electron-builder failed for ${os}-${a} (exit ${r.status}); see the after-pack messages above`);
    continue;
  }
  // unpacked app produced by electron-builder
  const appDir = target === 'mac' ? join(RELEASE, a === 'arm64' ? 'mac-arm64' : 'mac', `${desktopPkg.productName}.app`) : join(RELEASE, 'win-unpacked');
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
  for (const [k, v] of Object.entries(ins)) console.log(`  ${k}: ${JSON.stringify(v)}`);
}

/**
 * Resources/app-update.yml (electron-updater's configuration, from electron-builder.yml `publish`)
 * and Resources/build-info.json (scripts/after-pack.cjs) must be in every package.
 */
function inspectUpdateFiles(result, resources, a) {
  const ins = result.inspection;
  const updateConfig = join(resources, 'app-update.yml');
  if (existsSync(updateConfig)) {
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
      const tail = (s) => s.trim().split(/\r?\n/).slice(-8).join('\n');
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
        stderrTail: tail(stderr),
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
  result.smoke = await smokeTest(binary, { x64OnArm });
  const s = result.smoke;
  if (s.report) console.log(`  ORBITDROP_SMOKE ${JSON.stringify(s.report)}`);
  console.log(`  exit=${s.exitCode} signal=${s.signal ?? '-'} timedOut=${s.timedOut} ${s.seconds}s → ${s.ok ? 'OK' : 'FAILED'}`);
  if (!s.ok) {
    if (s.stdoutTail) console.log(`  stdout (tail):\n${s.stdoutTail.replace(/^/gm, '    ')}`);
    if (s.stderrTail) console.log(`  stderr (tail):\n${s.stderrTail.replace(/^/gm, '    ')}`);
    if (s.implemented) errors.push(`${os}-${a}: the smoke test reported failure (exit ${s.exitCode})`);
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
  } else if (!opts.skipSmoke) {
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
if (!opts.skipSmoke) {
  for (const result of results) {
    if (!result.ok) continue;
    result.nativeCheck = nativeCheck(result);
    if (result.nativeCheck.ran && !result.nativeCheck.ok) errors.push(`${os}-${result.arch}: native-module check failed: ${result.nativeCheck.problems.join('; ')}`);
    if (!result.nativeCheck.ran) console.warn(`  ⚠ native-module check skipped for ${os}-${result.arch}: ${result.nativeCheck.reason}`);
  }
}

// ── 10. Windows install / uninstall test ─────────────────────────────────────
async function installTestWin(result) {
  const setup = result.artifacts.find((x) => x.path.endsWith('-setup.exe'));
  const out = { ran: false };
  if (!setup) return { ...out, error: 'no NSIS installer was built' };
  const dir = mkdtempSync(join(tmpdir(), 'orbitdrop-install-'));
  const setupPath = join(ROOT, setup.path);
  step(`install test: ${rel(setupPath)} → ${dir}`);
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
  const reg = capture('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', desktopPkg.productName, '/d']);
  out.perUserUninstallEntry = reg.status === 0 && reg.out.includes(desktopPkg.productName);
  const regLm = capture('reg', ['query', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', desktopPkg.productName, '/d']);
  out.perMachineUninstallEntry = regLm.status === 0 && regLm.out.includes(desktopPkg.productName);
  if (out.installed && !opts.skipSmoke) {
    step('smoke test (installed copy)');
    out.smoke = await smokeTest(exe);
    console.log(`  exit=${out.smoke.exitCode} timedOut=${out.smoke.timedOut} → ${out.smoke.ok ? 'OK' : 'FAILED'}`);
  }
  if (uninstaller) {
    step('uninstall');
    spawnSync(join(dir, uninstaller), ['/S'], { stdio: 'inherit', timeout: 300000 });
    // The NSIS uninstaller re-launches itself from %TEMP%; wait for the files to disappear.
    for (let i = 0; i < 60 && existsSync(exe); i++) await new Promise((r) => setTimeout(r, 1000));
    out.uninstalled = !existsSync(exe);
    const after = capture('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', desktopPkg.productName, '/d']);
    out.uninstallEntryRemoved = !(after.status === 0 && after.out.includes(desktopPkg.productName));
  }
  console.log(`  install test: ${JSON.stringify({ ...out, smoke: out.smoke ? { ok: out.smoke.ok, report: out.smoke.report } : undefined })}`);
  if (install.status !== 0 || !out.installed) errors.push(`win: silent per-user install failed (exit ${install.status})`);
  if (out.installed && !out.helper) errors.push('win: installed app has no resources/helper/OrbitDropHelper.exe');
  if (out.installed && !out.licenses) errors.push('win: installed app is missing licence files');
  if (out.perMachineUninstallEntry) errors.push('win: installer registered itself under HKLM (expected per-user HKCU only)');
  if (out.installed && !out.perUserUninstallEntry) errors.push('win: no HKCU uninstall entry after install');
  if (out.smoke && !out.smoke.ok) (out.smoke.implemented ? errors : incomplete).push('win: smoke test of the installed copy did not pass');
  if (uninstaller && (!out.uninstalled || !out.uninstallEntryRemoved)) errors.push('win: silent uninstall left files or registry entries behind');
  return out;
}
if (target === 'win' && opts.installTest && !opts.dir) {
  for (const result of results) if (result.ok) result.installTest = await installTestWin(result);
}

// ── 10b. update metadata (latest-mac.yml merged from both arch runs / latest.yml) ──
let updateInfo = null;
const builtTargets = results.filter((r) => r.ok && !opts.dir);
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

// ── 11. report ───────────────────────────────────────────────────────────────
mkdirSync(RELEASE, { recursive: true });
for (const r of results) {
  const file = join(RELEASE, `build-report-${r.os}-${r.arch}.json`);
  writeFileSync(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), version: desktopPkg.version, host: `${process.platform}-${process.arch}`, source, ...r, updateInfo }, null, 2)}\n`);
}
step('summary');
console.log(`  source: ${source ? `${source.commit.slice(0, 12)}${source.dirty ? ' + uncommitted changes' : ''}` : 'unknown (no git)'}`);
for (const r of results) {
  console.log(`  ${r.os}-${r.arch}: ${r.ok ? 'built' : 'BUILD FAILED'} · ${r.signing.mode}${r.labels.length ? ` · labels: ${r.labels.join(', ')}` : ''}`);
  if (r.app) console.log(`    app: ${r.app.path} (${mb(r.app.bytes)})`);
  for (const x of r.artifacts) console.log(`    ${x.path} (${mb(x.bytes)}) sha256 ${x.sha256}`);
  if (r.smoke) console.log(`    smoke: ${r.smoke.ok ? 'OK' : r.smoke.ran ? (r.smoke.implemented ? 'FAILED' : 'not implemented') : `not run (${r.smoke.error})`}`);
  if (r.nativeCheck) console.log(`    native-module check: ${r.nativeCheck.ran ? (r.nativeCheck.ok ? `OK (librsvg ${r.nativeCheck.sharp?.rsvg}, ${r.nativeCheck.koreanFont}, pdf-lib + docx)` : 'FAILED') : `not run (${r.nativeCheck.reason})`}`);
  if (r.dmgNotarization) console.log(`    DMG: ${r.dmgNotarization.ok ? `signed, notarized, stapled (${r.dmgNotarization.spctl})` : r.dmgNotarization.skipped ? `not notarized (${r.dmgNotarization.skipped})` : `FAILED at ${r.dmgNotarization.failedAt ?? '?'}`}`);
  console.log(`    report: ${rel(join(RELEASE, `build-report-${r.os}-${r.arch}.json`))}`);
}
// GitHub Actions job summary (signing status is part of what reviewers must see).
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = ['### OrbitDrop packages', '', '| Target | Signing | Notarized (app / DMG) | Smoke test | Native modules | Artifacts |', '|---|---|---|---|---|---|'];
  for (const r of results) {
    const smoke = !r.smoke ? 'not run' : r.smoke.ok ? 'OK' : r.smoke.ran ? (r.smoke.implemented ? 'FAILED' : 'not implemented') : `not run (${r.smoke.error})`;
    const files = r.artifacts.map((x) => `\`${x.path.split('/').pop()}\` (${mb(x.bytes)})`).join('<br>') || (r.ok ? '(dir only)' : 'BUILD FAILED');
    const nat = !r.nativeCheck ? 'not run' : !r.nativeCheck.ran ? 'skipped' : r.nativeCheck.ok ? `OK (librsvg ${r.nativeCheck.sharp?.rsvg}, ${r.nativeCheck.koreanFont}, pdf-lib + docx)` : 'FAILED';
    const notarized = r.signing.notarize === null ? 'n/a' : `${r.signing.notarize ? 'yes' : 'no'} / ${r.dmgNotarization?.ok ? 'yes' : 'no'}`;
    lines.push(`| ${r.os}-${r.arch} | ${r.signing.mode} | ${notarized} | ${smoke} | ${nat} | ${files} |`);
    if (r.installTest) lines.push(`| ${r.os}-${r.arch} install test | | | ${r.installTest.smoke?.ok ? 'OK' : 'see log'} | | installed=${r.installTest.installed}, HKCU entry=${r.installTest.perUserUninstallEntry}, uninstalled=${r.installTest.uninstalled} |`);
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
