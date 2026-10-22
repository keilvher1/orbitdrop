// electron-builder beforePack hook (electron-builder.yml → beforePack). Never shipped.
//
// Works around a node_modules collection bug in electron-builder 26.15.3 with pnpm 11 and
// `nodeLinker: hoisted` (this repository's setup, ADR-03):
//
//   `pnpm list --prod --json` reports every dependency at a virtual-store path
//   (node_modules/.pnpm/<name>@<version>/node_modules/<name>) that does not exist in a hoisted
//   layout. electron-builder's pnpm collector then fails to find the exact version, and its
//   "installed version outside the declared range" fallback accepts whatever copy of the package
//   is hoisted to the top of node_modules. Whenever versions conflict, the package silently
//   ships the wrong one. Measured on the 0.1.0 packages (source d4f6d1e): pdf-lib 1.17.1
//   requires tslib ^1.11.1 and got tslib 2.8.1, docx 9.12.0 requires nanoid ^6.0.1 and got
//   nanoid 3.3.20 (the hoisted copies belong to the dev toolchain). The collector logs this only
//   at debug level ("dependencies resolved to a version outside the declared range").
//
// The workaround runs before the app files are collected and makes the collector look up the
// exact name@version that pnpm reported in the real (hoisted, nested) node_modules tree first:
// <dir>/node_modules/<name>, then <dir>/node_modules/<pkg>/node_modules/<name> and deeper, for
// apps/desktop and each parent folder. Copies of one name@version are identical, so any match is
// correct. Anything it cannot find goes through electron-builder's original lookup.
//
// It is applied only to the app-builder-lib versions listed below. On any other version it does
// nothing and warns; scripts/after-pack.cjs checks the packaged dependency tree either way (every
// dependency must resolve inside the package to a version that satisfies its declared range) and
// fails the build if the collector picked a wrong version again.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PATCHED_VERSIONS = new Set(['26.15.3']);
const COLLECTOR_SUFFIX = path.join('app-builder-lib', 'out', 'node-module-collector', 'pnpmNodeModulesCollector.js');
const MARK = Symbol.for('orbitdrop.hoistedExactLookup');
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_NESTING = 4;

const log = (msg) => console.log(`  • [before-pack] ${msg}`);

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function list(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

/** Breadth-first search for node_modules/<name> with exactly `version` below one node_modules folder. */
function searchNodeModules(nodeModules, name, version) {
  const queue = [[nodeModules, 0]];
  const seen = new Set();
  while (queue.length) {
    const [dir, depth] = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, ...name.split('/'));
    const pkg = readVersion(candidate);
    if (pkg && pkg.version === version) return { packageDir: fs.realpathSync(candidate), packageJson: pkg };
    if (depth >= MAX_NESTING) continue;
    for (const entry of list(dir)) {
      const scoped = entry.startsWith('@') ? list(path.join(dir, entry)).map((s) => path.join(dir, entry, s)) : [path.join(dir, entry)];
      for (const pkgDir of scoped) {
        const nested = path.join(pkgDir, 'node_modules');
        if (isDir(nested)) queue.push([nested, depth + 1]);
      }
    }
  }
  return null;
}

function createExactLookup() {
  const cache = new Map();
  return function findExact(rootDir, name, version) {
    const key = `${rootDir}\0${name}@${version}`;
    if (cache.has(key)) return cache.get(key);
    let found = null;
    for (let dir = path.resolve(rootDir); ; dir = path.dirname(dir)) {
      const nodeModules = path.join(dir, 'node_modules');
      if (isDir(nodeModules)) found = searchNodeModules(nodeModules, name, version);
      if (found || path.dirname(dir) === dir) break;
    }
    cache.set(key, found);
    return found;
  };
}

/** Loaded copies of the pnpm collector module (the instance electron-builder uses), or a resolved one. */
function collectorModules() {
  const loaded = Object.keys(require.cache).filter((f) => f.endsWith(COLLECTOR_SUFFIX));
  if (loaded.length) return loaded;
  try {
    const builderDir = path.dirname(require.resolve('electron-builder/package.json'));
    const ablDir = path.dirname(require.resolve('app-builder-lib/package.json', { paths: [builderDir] }));
    return [path.join(ablDir, 'out', 'node-module-collector', 'pnpmNodeModulesCollector.js')];
  } catch {
    return [];
  }
}

function patchCollector(file) {
  const ablDir = path.resolve(path.dirname(file), '..', '..');
  const version = readVersion(ablDir)?.version;
  if (!PATCHED_VERSIONS.has(version)) {
    console.warn(
      `  ⚠ [before-pack] app-builder-lib ${version ?? '?'} is not one of ${[...PATCHED_VERSIONS].join(', ')}: the hoisted-layout lookup workaround is NOT applied ` +
        '(re-check the pnpm collector, then update PATCHED_VERSIONS in apps/desktop/build/before-pack.cjs); after-pack still verifies the dependency tree',
    );
    return false;
  }
  const { PnpmNodeModulesCollector } = require(file);
  const proto = PnpmNodeModulesCollector?.prototype;
  if (!proto || typeof proto.locateFromDepOrRoot !== 'function') {
    console.warn(`  ⚠ [before-pack] ${file} has no PnpmNodeModulesCollector.locateFromDepOrRoot; workaround not applied`);
    return false;
  }
  if (proto[MARK]) return true;
  const original = proto.locateFromDepOrRoot;
  const findExact = createExactLookup();
  proto.locateFromDepOrRoot = async function locateFromDepOrRootHoisted(pkgName, parentPath, requiredRange) {
    if (typeof requiredRange === 'string' && EXACT_VERSION.test(requiredRange)) {
      const found = findExact(this.rootDir, pkgName, requiredRange);
      if (found) return found;
    }
    return original.call(this, pkgName, parentPath, requiredRange);
  };
  proto[MARK] = true;
  log(`pnpm collector: exact name@version lookup in the hoisted node_modules tree enabled (app-builder-lib ${version})`);
  return true;
}

async function beforePack() {
  const files = collectorModules();
  if (!files.length) {
    console.warn('  ⚠ [before-pack] electron-builder pnpm collector not found; workaround not applied (after-pack still verifies the dependency tree)');
    return;
  }
  for (const file of files) patchCollector(file);
}

module.exports = beforePack;
module.exports.default = beforePack;
module.exports.createExactLookup = createExactLookup;
