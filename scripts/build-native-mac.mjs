#!/usr/bin/env node
// Builds the macOS drag helper (native/macos, SwiftPM) and stages it for Electron:
//   apps/desktop/resources/helper/darwin-arm64/OrbitDropHelper
//   apps/desktop/resources/helper/darwin-x64/OrbitDropHelper
//   (and darwin-universal/OrbitDropHelper with --arch universal)
//
//   node scripts/build-native-mac.mjs [--arch arm64|x64|all|universal] [--debug] [--test]
//                                      [--sign "<identity>"] [--no-smoke] [--no-strip]
//
// Release build per architecture with deployment target macOS 14.0, strip, code
// signature with the hardened runtime (ad-hoc "-" by default, for local runs; pass
// --sign with a Developer ID Application identity for distribution), verification
// (codesign --verify, lipo -info, file, vtool), then the stdio smoke test
// (native/macos/scripts/smoke-test.mjs) against each staged binary — the x64 one runs
// under Rosetta 2. Each binary is finished under a temporary name and renamed into place,
// so a helper running from the staged path is never rewritten under its feet.
// Node-only, no shell syntax; it refuses to run on other platforms.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = join(root, 'native', 'macos');
const stageRoot = join(root, 'apps', 'desktop', 'resources', 'helper');
const BUNDLE_ID = 'io.github.keilvher1.orbitdrop.helper';
const DEPLOYMENT_TARGET = '14.0';
const ARCHES = {
  arm64: { triple: `arm64-apple-macosx${DEPLOYMENT_TARGET}`, lipo: 'arm64', dir: 'darwin-arm64' },
  x64: { triple: `x86_64-apple-macosx${DEPLOYMENT_TARGET}`, lipo: 'x86_64', dir: 'darwin-x64' },
};

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error('usage: node scripts/build-native-mac.mjs [--arch arm64|x64|all|universal] [--debug] [--test] [--sign "<identity>"] [--no-smoke] [--no-strip]');
  process.exit(2);
}

const argv = process.argv.slice(2);
const options = { arches: [], universal: false, configuration: 'release', test: false, smoke: true, strip: true, identity: '-' };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--arch') {
    const value = argv[++i];
    if (value === 'arm64' || value === 'x64') options.arches.push(value);
    else if (value === 'x86_64') options.arches.push('x64');
    else if (value === 'all' || value === 'both') options.arches.push('arm64', 'x64');
    else if (value === 'universal') {
      options.arches.push('arm64', 'x64');
      options.universal = true;
    } else usage(`unknown --arch ${value}`);
  } else if (a === '--debug') options.configuration = 'debug';
  else if (a === '--test') options.test = true;
  else if (a === '--no-smoke') options.smoke = false;
  else if (a === '--no-strip') options.strip = false;
  else if (a === '--sign') {
    options.identity = argv[++i];
    if (!options.identity) usage('--sign needs an identity');
  } else if (a === '--help' || a === '-h') usage();
  else usage(`unknown argument ${a}`);
}
if (options.arches.length === 0) options.arches = ['arm64', 'x64'];
options.arches = [...new Set(options.arches)];

if (process.platform !== 'darwin') {
  console.error('The macOS helper can only be built on macOS (needs Xcode/Swift and the macOS SDK).');
  process.exit(1);
}

function run(cmd, args, { capture = false, allowFailure = false, env } = {}) {
  const pretty = [cmd, ...args].map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ');
  if (!capture) console.log(`$ ${pretty}`);
  const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: env ?? process.env });
  if (result.error) {
    if (allowFailure) return result;
    console.error(`failed to run ${cmd}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0 && !allowFailure) {
    if (capture) process.stderr.write(result.stderr ?? '');
    console.error(`command failed (${result.status}): ${pretty}`);
    process.exit(result.status ?? 1);
  }
  return result;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const rosettaAvailable = () => spawnSync('arch', ['-x86_64', '/usr/bin/true']).status === 0;
const tsxAvailable = existsSync(join(root, 'node_modules', 'tsx'));

if (options.test) run('swift', ['test', '--package-path', packagePath]);

// Each binary is prepared (copied, stripped, signed, verified) under a temporary name next to
// its final path and then renamed into place. A helper still running from the staged path (the
// dev app, an E2E run, the PoC harness) keeps its own, untouched file, and the next launch never
// meets a signed binary rewritten in place (macOS caches code signatures per file: such a binary
// can be killed with a code-signature fault).
const pendingStaging = new Set();
process.on('exit', () => {
  for (const file of pendingStaging) if (existsSync(file)) unlinkSync(file);
});
function stagingPath(target) {
  const file = join(dirname(target), `.${basename(target)}.staging-${process.pid}`);
  pendingStaging.add(file);
  return file;
}
function commit(staging, target) {
  renameSync(staging, target);
  pendingStaging.delete(staging);
}

const staged = [];
for (const arch of options.arches) {
  const { triple, lipo, dir } = ARCHES[arch];
  console.log(`\n== ${arch} (${triple}, ${options.configuration})`);
  const common = ['--package-path', packagePath, '-c', options.configuration, '--triple', triple];
  run('swift', ['build', ...common, '--product', 'OrbitDropHelper']);
  const binDir = run('swift', ['build', ...common, '--show-bin-path'], { capture: true }).stdout.trim();
  const built = join(binDir, 'OrbitDropHelper');
  if (!existsSync(built)) {
    console.error(`build output missing: ${built}`);
    process.exit(1);
  }
  const outDir = join(stageRoot, dir);
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, 'OrbitDropHelper');
  const staging = stagingPath(target);
  copyFileSync(built, staging);
  chmodSync(staging, 0o755);
  if (options.strip) run('xcrun', ['strip', '-S', '-x', staging]);
  sign(staging);
  verify(staging, lipo);
  commit(staging, target);
  staged.push({ arch, path: target });
}

if (options.universal) {
  console.log('\n== universal');
  const outDir = join(stageRoot, 'darwin-universal');
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, 'OrbitDropHelper');
  const staging = stagingPath(target);
  run('xcrun', ['lipo', '-create', '-output', staging, ...staged.map((s) => s.path)]);
  sign(staging);
  verify(staging, null);
  commit(staging, target);
  staged.push({ arch: 'universal', path: target });
}

function sign(target) {
  const args = ['--force', '--options', 'runtime', '--identifier', BUNDLE_ID, '--sign', options.identity];
  // A secure timestamp is required for notarization; ad-hoc signatures cannot carry one.
  args.splice(0, 0, options.identity === '-' ? '--timestamp=none' : '--timestamp');
  run('codesign', [...args, target]);
}

function verify(target, lipoArch) {
  run('codesign', ['--verify', '--strict', '--verbose=2', target]);
  const details = run('codesign', ['-dv', '--verbose=4', target], { capture: true });
  const info = `${details.stdout}${details.stderr}`;
  if (!/flags=0x[0-9a-f]+\(.*runtime.*\)/.test(info)) {
    console.error('hardened runtime flag missing from the signature');
    process.exit(1);
  }
  const lipoInfo = run('xcrun', ['lipo', '-info', target], { capture: true }).stdout.trim();
  console.log(lipoInfo);
  if (lipoArch && !lipoInfo.endsWith(`architecture: ${lipoArch}`)) {
    console.error(`expected a thin ${lipoArch} binary`);
    process.exit(1);
  }
  console.log(run('file', [target], { capture: true }).stdout.trim());
  const build = run('xcrun', ['vtool', '-show-build', target], { capture: true }).stdout;
  const minos = [...build.matchAll(/minos ([0-9.]+)/g)].map((m) => m[1]);
  console.log(`minos: ${minos.join(', ')}`);
  if (minos.length === 0 || minos.some((v) => v !== DEPLOYMENT_TARGET)) {
    console.error(`expected deployment target ${DEPLOYMENT_TARGET}`);
    process.exit(1);
  }
}

const summary = [];
for (const { arch, path } of staged) {
  const entry = { arch, path: relative(root, path), bytes: statSync(path).size, sha256: sha256(path).slice(0, 16), smoke: 'skipped' };
  if (options.smoke && arch !== 'universal') {
    if (arch === 'x64' && process.arch === 'arm64' && !rosettaAvailable()) {
      entry.smoke = 'skipped (Rosetta 2 not installed)';
    } else {
      const nodeArgs = [...(tsxAvailable ? ['--import', 'tsx'] : []), join(packagePath, 'scripts', 'smoke-test.mjs'), path, '--expect-arch', arch, '--json'];
      const result = run(process.execPath, nodeArgs, { capture: true, allowFailure: true });
      const line = (result.stdout ?? '').trim().split('\n').pop() ?? '';
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {}
      entry.smoke = parsed?.ok ? `passed ${parsed.checks}/${parsed.checks} (${parsed.schema}${arch === 'x64' && process.arch === 'arm64' ? ', Rosetta 2' : ''})` : `FAILED ${parsed ? parsed.failed.join('; ') : line || result.stderr}`;
      if (!parsed?.ok) {
        console.error(result.stdout, result.stderr);
        summary.push(entry);
        console.table(summary);
        process.exit(1);
      }
    }
  }
  summary.push(entry);
}
console.log('');
console.table(summary);
console.log(options.identity === '-' ? 'Signed ad-hoc with the hardened runtime (local use only; not notarizable).' : `Signed with "${options.identity}" + hardened runtime + secure timestamp.`);
