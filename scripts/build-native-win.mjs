#!/usr/bin/env node
// Builds, tests and stages the Windows drag helper (native/windows).
//
//   node scripts/build-native-win.mjs [--arch x64] [--config Release|Debug] [--skip-tests] [--no-stage]
//        On Windows: MSVC x64 (static CRT /MT) via the CMake preset `msvc-x64`, then
//        core unit tests (incl. tests/fixtures/wheel-golden.json), the OLE glue tests, the stdio smoke test,
//        wheel snapshots (PNG), and stages OrbitDropHelper.exe + BUILD_INFO.txt into
//        apps/desktop/resources/helper/win32-x64/.
//
//   node scripts/build-native-win.mjs --core-tests [--parity] [--no-asan]
//        Any OS: builds and runs the portable core tests with the host compiler
//        (preset `host-tests`), then again with AddressSanitizer + UBSan on
//        macOS/Linux (preset `host-tests-asan`; --no-asan skips it). --parity also
//        cross-checks the C++ protocol code against the zod schemas (needs
//        node_modules/tsx).
//
//   node scripts/build-native-win.mjs --cross [--no-stage]
//        macOS/Linux: compile check with MinGW-w64 (preset `mingw-x64`, warnings are
//        errors), DLL import check, and staging of a stripped copy labelled
//        CROSS-COMPILED / NOT VERIFIED ON WINDOWS in BUILD_INFO.txt.
//
// Flags can be combined (e.g. --core-tests --cross). Exit code 0 on success.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(repo, 'native', 'windows');
const stageDir = join(repo, 'apps', 'desktop', 'resources', 'helper', 'win32-x64');
const isWindows = process.platform === 'win32';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

if (flag('--help') || flag('-h')) {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  console.log(text.split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

const arch = option('--arch', 'x64');
if (arch !== 'x64') {
  console.error(`unsupported --arch ${arch}: the Windows helper is built for x64 only (Windows ARM64 is out of scope)`);
  process.exit(2);
}
const config = option('--config', 'Release');
const skipTests = flag('--skip-tests');
const stage = !flag('--no-stage');
const wantCross = flag('--cross');
const wantCoreTests = flag('--core-tests');
const wantParity = flag('--parity');
const wantAsan = !flag('--no-asan');

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd ?? src, env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ''} exited with code ${r.status}`);
}

function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd ?? src, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function firstExisting(paths) {
  return paths.find((p) => existsSync(p)) ?? null;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function compilerVersion(buildDir) {
  try {
    const files = join(buildDir, 'CMakeFiles');
    for (const entry of readdirSync(files)) {
      const f = join(files, entry, 'CMakeCXXCompiler.cmake');
      if (!existsSync(f)) continue;
      const text = readFileSync(f, 'utf8');
      const id = /set\(CMAKE_CXX_COMPILER_ID "([^"]*)"\)/.exec(text)?.[1] ?? '?';
      const ver = /set\(CMAKE_CXX_COMPILER_VERSION "([^"]*)"\)/.exec(text)?.[1] ?? '?';
      return `${id} ${ver}`;
    }
  } catch {}
  return 'unknown';
}

function gitDescribe() {
  const head = capture('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo })?.trim() ?? 'unknown';
  const dirty = (capture('git', ['status', '--porcelain', '--', 'native/windows'], { cwd: repo }) ?? '').trim().length > 0;
  return dirty ? `${head} + uncommitted native/windows changes` : head;
}

function helperVersion() {
  const text = readFileSync(join(src, 'CMakeLists.txt'), 'utf8');
  return /project\(OrbitDropHelper VERSION ([0-9.]+)/.exec(text)?.[1] ?? 'unknown';
}

function stageHelper(builtExe, status, toolchain, strip) {
  mkdirSync(stageDir, { recursive: true });
  const target = join(stageDir, 'OrbitDropHelper.exe');
  rmSync(target, { force: true });
  if (strip) run(strip, ['-o', target, builtExe]);
  else copyFileSync(builtExe, target);
  const info = [
    'OrbitDropHelper.exe — OrbitDrop native drag helper, Windows x64',
    `version:   ${helperVersion()}`,
    `built:     ${new Date().toISOString()} on ${process.platform}-${process.arch} (${os.release()})`,
    `toolchain: ${toolchain}`,
    `source:    ${gitDescribe()}`,
    `sha256:    ${sha256(target)}`,
    `status:    ${status}`,
    '',
    'GUI drag behaviour (Explorer drag + Shift, OLE drop, DPI, multi-monitor) is only verified',
    'by the manual checklist in docs/workstreams/windows-helper.md.',
    '',
  ].join('\n');
  writeFileSync(join(stageDir, 'BUILD_INFO.txt'), info);
  console.log(`\nstaged ${target}\n${info}`);
}

function runParity(toolExe) {
  const tsx = join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsx)) {
    console.warn('\n(skipping protocol parity: node_modules/tsx is not installed)');
    return;
  }
  run(process.execPath, [tsx, join(src, 'tests', 'tools', 'protocol-parity.mjs'), toolExe], { cwd: repo });
}

// ------------------------------------------------------------------ portable core tests (any OS)
function buildAndRunCoreTests(preset, config) {
  run('cmake', ['--preset', preset]);
  run('cmake', ['--build', '--preset', preset, '--parallel']);
  const dir = join(src, 'build', preset);
  const exe = firstExisting([
    join(dir, 'orbitdrop-core-tests'),
    join(dir, 'orbitdrop-core-tests.exe'),
    join(dir, config, 'orbitdrop-core-tests.exe'),
  ]);
  if (!exe) throw new Error(`orbitdrop-core-tests was not built (preset ${preset})`);
  run(exe, ['--require-golden']);
  return dir;
}

function coreTests() {
  const dir = buildAndRunCoreTests('host-tests', 'Release');
  // ASan + UBSan (findings abort the run: -fno-sanitize-recover); the preset is GCC/Clang only.
  if (!isWindows && wantAsan) buildAndRunCoreTests('host-tests-asan', 'Debug');
  if (wantParity) {
    const tool = firstExisting([
      join(dir, 'orbitdrop-protocol-tool'),
      join(dir, 'orbitdrop-protocol-tool.exe'),
      join(dir, 'Release', 'orbitdrop-protocol-tool.exe'),
    ]);
    if (!tool) throw new Error('--parity: orbitdrop-protocol-tool was not built');
    runParity(tool);
  }
}

// ------------------------------------------------------------------ MinGW cross compile (macOS/Linux)
const ALLOWED_DLLS = /^(kernel32|user32|gdi32|ole32|oleaut32|shell32|shcore|advapi32|wtsapi32|d2d1|dwrite|api-ms-win-crt-[a-z0-9-]+)\.dll$/i;

function cross() {
  const prefix = process.env.MINGW_PREFIX || 'x86_64-w64-mingw32';
  if (!capture(`${prefix}-g++`, ['--version'])) {
    throw new Error(`${prefix}-g++ not found (install mingw-w64, e.g. brew install mingw-w64)`);
  }
  run('cmake', ['--preset', 'mingw-x64']);
  run('cmake', ['--build', '--preset', 'mingw-x64', '--parallel']);
  const buildDir = join(src, 'build', 'mingw-x64');
  const exe = join(buildDir, 'OrbitDropHelper.exe');
  if (!existsSync(exe)) throw new Error('OrbitDropHelper.exe was not produced');
  const objdump = `${prefix.replace(/-posix$|-win32$/, '')}-objdump`;
  const dump = capture(objdump, ['-p', exe]) ?? capture('x86_64-w64-mingw32-objdump', ['-p', exe]);
  if (dump) {
    const dlls = [...new Set([...dump.matchAll(/DLL Name: (\S+)/g)].map((m) => m[1]))].sort();
    console.log(`\nDLL imports: ${dlls.join(', ')}`);
    const unexpected = dlls.filter((d) => !ALLOWED_DLLS.test(d));
    if (unexpected.length > 0) throw new Error(`unexpected DLL dependencies: ${unexpected.join(', ')}`);
    if (!/Subsystem\s+00000002/.test(dump)) throw new Error('OrbitDropHelper.exe is not a GUI-subsystem executable');
  } else {
    console.warn('(objdump not found: DLL import check skipped)');
  }
  if (stage) {
    const gxx = (capture(`${prefix}-g++`, ['--version']) ?? '').split('\n')[0];
    stageHelper(
      exe,
      `CROSS-COMPILED with MinGW-w64 on ${process.platform}-${process.arch}. NOT VERIFIED ON WINDOWS — compile/link check only; do not ship. Rebuild on Windows: node scripts/build-native-win.mjs`,
      `${gxx} (static libstdc++/libgcc/winpthread, UCRT)`,
      `${prefix.replace(/-posix$|-win32$/, '')}-strip`,
    );
  }
}

// ------------------------------------------------------------------ Windows (MSVC)
function windows() {
  run('cmake', ['--preset', 'msvc-x64']);
  run('cmake', ['--build', '--preset', 'msvc-x64-release', '--config', config, '--parallel']);
  const outDir = join(src, 'build', 'msvc-x64', config);
  const exe = join(outDir, 'OrbitDropHelper.exe');
  if (!existsSync(exe)) throw new Error(`${exe} was not produced`);
  let status = 'BUILT WITH MSVC ON WINDOWS (tests skipped).';
  if (!skipTests) {
    run(join(outDir, 'orbitdrop-core-tests.exe'), ['--require-golden']);
    run(join(outDir, 'orbitdrop-ole-tests.exe'), []);  // DropTarget + fake IDataObject (headless)
    const snapshots = option('--snapshots', join(src, 'build', 'msvc-x64', 'snapshots'));
    run(process.execPath, [join(src, 'tests', 'tools', 'stdio-smoke.mjs'), exe, '--snapshots', snapshots], { cwd: repo });
    if (wantParity) runParity(join(outDir, 'orbitdrop-protocol-tool.exe'));
    status =
      'BUILT WITH MSVC ON WINDOWS (static CRT). Core unit tests incl. wheel-golden.json, the OLE glue tests (DropTarget + fake IDataObject) and the stdio smoke test (pipes, ready/ping/errors/EOF exit, snapshots) passed.';
  }
  if (stage) stageHelper(exe, status, `${compilerVersion(join(src, 'build', 'msvc-x64'))}, /MT`, null);
}

// ------------------------------------------------------------------ main
try {
  if (!wantCross && !wantCoreTests) {
    if (!isWindows) {
      console.error(
        'The Windows helper is built with MSVC on Windows.\n' +
          'On this machine use:\n' +
          '  node scripts/build-native-win.mjs --core-tests [--parity]   portable unit tests (host compiler)\n' +
          '  node scripts/build-native-win.mjs --cross                   MinGW-w64 compile check (unverified binary)',
      );
      process.exit(1);
    }
    windows();
  } else {
    if (wantCoreTests) coreTests();
    if (wantCross) {
      if (isWindows) throw new Error('--cross is for macOS/Linux; on Windows run without flags (MSVC)');
      cross();
    }
  }
  console.log('\nbuild-native-win: done');
} catch (err) {
  console.error(`\nbuild-native-win: ${err.message}`);
  process.exit(1);
}
