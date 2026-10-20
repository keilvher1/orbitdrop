#!/usr/bin/env node
// Builds the native drag helper for the current (or given) platform and stages
// it under apps/desktop/resources/helper/<platform>-<arch>/.
//   node scripts/build-native.mjs mac [--arch arm64|x64|universal]
//   node scripts/build-native.mjs win [--arch x64]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [target = process.platform === 'win32' ? 'win' : 'mac', ...rest] = process.argv.slice(2);
const script = { mac: 'build-native-mac.mjs', win: 'build-native-win.mjs' }[target];
if (!script) {
  console.error(`unknown target "${target}" (expected mac or win)`);
  process.exit(2);
}
const result = spawnSync(process.execPath, [join(here, script), ...rest], { stdio: 'inherit' });
process.exit(result.status ?? 1);
