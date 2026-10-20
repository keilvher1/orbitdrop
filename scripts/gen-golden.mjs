#!/usr/bin/env node
// Generates tests/fixtures/wheel-golden.json (golden vectors for the Swift and
// C++ wheel implementations) from the TypeScript reference in packages/core.
//
//   node scripts/gen-golden.mjs            write the file
//   node scripts/gen-golden.mjs --check    exit 1 if the committed file is out of date
//
// The generator is TypeScript (packages/core/src/golden/wheel-golden.ts); when
// this script is started with plain `node` it re-runs itself with
// `--import tsx` (tsx is a root devDependency). Cross-platform: no shell.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const generatorUrl = pathToFileURL(join(root, 'packages/core/src/golden/wheel-golden.ts')).href;
const args = process.argv.slice(2);
const check = args.includes('--check');
const CHILD_FLAG = 'ORBITDROP_GEN_GOLDEN_CHILD';

async function loadGenerator() {
  try {
    return await import(generatorUrl);
  } catch (error) {
    if (process.env[CHILD_FLAG] === '1') throw error;
    // TypeScript (extensionless imports, parameter properties) needs tsx: re-run under it.
    const require = createRequire(join(root, 'package.json'));
    let tsxLoader;
    try {
      tsxLoader = pathToFileURL(require.resolve('tsx')).href;
    } catch {
      console.error('gen-golden: tsx is not installed (it is a root devDependency; run pnpm install).');
      process.exit(2);
    }
    const result = spawnSync(process.execPath, ['--import', tsxLoader, fileURLToPath(import.meta.url), ...args], {
      stdio: 'inherit',
      cwd: root,
      env: { ...process.env, [CHILD_FLAG]: '1' },
    });
    process.exit(result.status ?? 1);
  }
}

const { generateWheelGolden, serializeGolden, GOLDEN_RELATIVE_PATH } = await loadGenerator();
const target = join(root, GOLDEN_RELATIVE_PATH);
const text = serializeGolden(generateWheelGolden());

if (check) {
  let current = '';
  try {
    current = (await readFile(target, 'utf8')).replace(/\r\n/g, '\n');
  } catch {
    // missing file counts as out of date
  }
  if (current !== text) {
    console.error(`gen-golden: ${relative(root, target)} is out of date; run: node scripts/gen-golden.mjs`);
    process.exit(1);
  }
  console.log(`gen-golden: ${relative(root, target)} is up to date`);
} else {
  await writeFile(target, text, 'utf8');
  const golden = JSON.parse(text);
  console.log(
    `gen-golden: wrote ${relative(root, target)} (${(text.length / 1024).toFixed(0)} KiB; ` +
      `${golden.hitTest.cases.length + golden.hitTestNonFinite.cases.length} hit-test, ${golden.placement.cases.length} placement, ` +
      `${golden.arming.cases.length} arming, ${golden.selection.cases.length} selection, ${golden.fileCount.cases.length} file-count cases, ` +
      `${golden.coords.mac.length} macOS + ${golden.coords.win.length} Windows layouts)`,
  );
}
