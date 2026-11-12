#!/usr/bin/env node
// Sets OrbitDrop's version everywhere a build reads it, so the app and both native helpers always
// report the same version (diagnostics, Windows file properties, code-signing metadata checks):
//
//   node scripts/set-version.mjs 1.0.0          # or 1.1.0-beta.1
//   node scripts/set-version.mjs --check        # exit 1 when the files disagree (CI, tests)
//
// Files:
//   apps/desktop/package.json                                  "version" (the release version; tags are v<version>)
//   native/macos/Sources/OrbitDropHelperCore/Protocol/ProtocolBasics.swift  HelperInfo.version (full semver)
//   native/macos/Support/Info.plist                            CFBundleShortVersionString (major.minor.patch)
//   native/windows/CMakeLists.txt                              project(... VERSION major.minor.patch) →
//                                                              the helper's VERSIONINFO (res/OrbitDropHelper.rc.in)
// CMake and CFBundleShortVersionString only take numbers, so a prerelease suffix (-beta.1) is kept in
// package.json and the Swift constant only.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-((?:alpha|beta)\.\d+))?$/;

export const VERSION_FILES = {
  packageJson: 'apps/desktop/package.json',
  swift: 'native/macos/Sources/OrbitDropHelperCore/Protocol/ProtocolBasics.swift',
  plist: 'native/macos/Support/Info.plist',
  cmake: 'native/windows/CMakeLists.txt',
};

const SWIFT_RE = /(public static let version = ")([^"]*)(")/;
const PLIST_RE = /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]*)(<\/string>)/;
const CMAKE_RE = /(project\(OrbitDropHelper VERSION )([0-9.]+)( )/;

function read(rel, root) {
  return readFileSync(join(root, rel), 'utf8');
}

/** The version each file states now. */
export function readVersions(root = ROOT) {
  const one = (rel, re) => {
    const m = re.exec(read(rel, root));
    if (!m) throw new Error(`${rel}: version field not found`);
    return m[2];
  };
  return {
    packageJson: JSON.parse(read(VERSION_FILES.packageJson, root)).version,
    swift: one(VERSION_FILES.swift, SWIFT_RE),
    plist: one(VERSION_FILES.plist, PLIST_RE),
    cmake: one(VERSION_FILES.cmake, CMAKE_RE),
  };
}

/** Problems (empty = consistent): every file must follow apps/desktop/package.json. */
export function checkVersions(root = ROOT) {
  const v = readVersions(root);
  const m = SEMVER.exec(v.packageJson);
  if (!m) return [`${VERSION_FILES.packageJson}: "${v.packageJson}" is not x.y.z or x.y.z-alpha.N / -beta.N`];
  const numeric = `${m[1]}.${m[2]}.${m[3]}`;
  const problems = [];
  if (v.swift !== v.packageJson) problems.push(`${VERSION_FILES.swift}: HelperInfo.version "${v.swift}", expected "${v.packageJson}"`);
  if (v.plist !== numeric) problems.push(`${VERSION_FILES.plist}: CFBundleShortVersionString "${v.plist}", expected "${numeric}"`);
  if (v.cmake !== numeric) problems.push(`${VERSION_FILES.cmake}: project VERSION "${v.cmake}", expected "${numeric}"`);
  return problems;
}

/** Writes `version` into every file. */
export function setVersion(version, root = ROOT) {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`"${version}" is not x.y.z or x.y.z-alpha.N / -beta.N (other prerelease names become separate update channels, docs/RELEASING.md)`);
  const numeric = `${m[1]}.${m[2]}.${m[3]}`;
  const pkgPath = join(root, VERSION_FILES.packageJson);
  const pkgText = readFileSync(pkgPath, 'utf8');
  // Keep the file's formatting: replace only the top-level "version" value.
  const pkgNext = pkgText.replace(/^(\s{2}"version":\s*")([^"]*)(")/m, `$1${version}$3`);
  if (JSON.parse(pkgNext).version !== version) throw new Error(`${VERSION_FILES.packageJson}: could not set "version"`);
  writeFileSync(pkgPath, pkgNext);
  const edit = (rel, re, value) => {
    const path = join(root, rel);
    const text = readFileSync(path, 'utf8');
    if (!re.test(text)) throw new Error(`${rel}: version field not found`);
    writeFileSync(path, text.replace(re, `$1${value}$3`));
  };
  edit(VERSION_FILES.swift, SWIFT_RE, version);
  edit(VERSION_FILES.plist, PLIST_RE, numeric);
  edit(VERSION_FILES.cmake, CMAKE_RE, numeric);
  return readVersions(root);
}

function main(argv) {
  const [arg] = argv;
  if (arg === '--check') {
    const problems = checkVersions();
    if (problems.length) {
      console.error(`version mismatch:\n  - ${problems.join('\n  - ')}\nfix: node scripts/set-version.mjs ${readVersions().packageJson}`);
      process.exit(1);
    }
    console.log(`versions agree: ${readVersions().packageJson}`);
    return;
  }
  if (!arg) {
    console.error('usage: node scripts/set-version.mjs <x.y.z[-beta.N]> | --check');
    process.exit(2);
  }
  const result = setVersion(arg);
  console.log(`version set to ${arg}:`, result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
