#!/usr/bin/env node
// Manual PoC harness for the real Finder drag test (docs/workstreams/macos-helper.md).
// Spawns the helper the way Electron main will (stdio NDJSON), enables observation and
// prints every session in plain language: wheel shown, payload, DROP (action + file
// names), cancelled (reason). Nothing is converted. Ctrl+C stops the helper cleanly.
//
//   node --import tsx native/macos/scripts/poc-harness.mjs [--helper <path>] [--locale ko|en]
//        [--theme light|dark|highContrast] [--reduce-motion] [--tools alt+shift] [--convert shift]
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const arch = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
const helperPath = opt('--helper', join(root, 'apps', 'desktop', 'resources', 'helper', arch, 'OrbitDropHelper'));
const locale = opt('--locale', 'ko');
const theme = opt('--theme', 'light');
const reduceMotion = args.includes('--reduce-motion');
const combo = (text) => text.split('+').map((k) => k.trim()).filter(Boolean);

if (!existsSync(helperPath)) {
  console.error(`helper not found: ${helperPath}\nbuild it first: node scripts/build-native-mac.mjs --arch arm64`);
  process.exit(2);
}

// Configure message: the real one from contracts/core when tsx is available, else the fixture.
let configure;
try {
  const contracts = await import(pathToFileURL(join(root, 'packages/contracts/src/index.ts')).href);
  configure = JSON.parse(readFileSync(join(here, '..', 'Tests', 'OrbitDropHelperCoreTests', 'Fixtures', `configure-${locale}.json`), 'utf8'));
  configure.tokens = contracts.wheelTokens(theme, reduceMotion);
  contracts.HelperConfigureSchema.parse(configure);
} catch {
  configure = JSON.parse(readFileSync(join(here, '..', 'Tests', 'OrbitDropHelperCoreTests', 'Fixtures', `configure-${locale}.json`), 'utf8'));
}
configure.enabled = true;
configure.reduceMotion = reduceMotion;
configure.highContrast = theme === 'highContrast';
configure.modifiers = { convert: combo(opt('--convert', 'shift')), tools: combo(opt('--tools', 'alt+shift')) };

const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(2).padStart(7)}s`;
const drops = new Map();
let buffer = '';
helper.stdout.setEncoding('utf8');
helper.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      console.log(`${t()}  !! non-JSON line: ${line.slice(0, 120)}`);
      continue;
    }
    switch (m.type) {
      case 'ready':
        console.log(`${t()}  ready: helper ${m.helperVersion} ${m.arch}, macOS ${m.osVersion}, pid ${m.pid}, global drag ${m.globalDrag.available ? 'available' : `UNAVAILABLE (${m.globalDrag.reason})`}`);
        helper.stdin.write(JSON.stringify(configure) + '\n');
        helper.stdin.write(JSON.stringify({ v: 1, type: 'queryPermissions' }) + '\n');
        console.log(`${t()}  configured: convert = ${configure.modifiers.convert.join('+')}, tools = ${configure.modifiers.tools.join('+')}, locale ${locale}, theme ${theme}`);
        console.log('         Drag a file in Finder and press the modifier while dragging. Ctrl+C to quit.\n');
        break;
      case 'permissions':
        console.log(`${t()}  permissions (none required): ${m.items.map((p) => `${p.name}=${p.granted ? 'granted' : 'not granted'}`).join(', ')}`);
        break;
      case 'state':
        if (m.state === 'AwaitingPayload') console.log(`${t()}  [${m.sessionId}] wheel shown (${m.mode}) — waiting for the drag to enter`);
        else if (m.state === 'WheelActive') console.log(`${t()}  [${m.sessionId}] ${m.mode} menu for ${m.menuKey ?? 'UNSUPPORTED items'}, ${m.fileCount} file(s)`);
        else console.log(`${t()}  [${m.sessionId}] state ${m.state}`);
        break;
      case 'drop': {
        const count = (drops.get(m.sessionId) ?? 0) + 1;
        drops.set(m.sessionId, count);
        console.log(`${t()}  [${m.sessionId}] DROP ${m.actionId} (${m.mode}, ${m.dropEffect}) on ${m.files.length} file(s): ${m.files.map((f) => basename(f)).join(', ')}`);
        if (count > 1) console.log(`${t()}  !! DUPLICATE drop for ${m.sessionId} — this must never happen`);
        break;
      }
      case 'cancelled':
        console.log(`${t()}  [${m.sessionId}] cancelled: ${m.reason}`);
        break;
      default:
        console.log(`${t()}  ${m.type}: ${m.message ?? JSON.stringify(m)}`);
    }
  }
});
helper.stderr.setEncoding('utf8');
helper.stderr.on('data', (d) => process.stderr.write(`         stderr: ${d}`));
helper.on('exit', (code, signal) => {
  console.log(`${t()}  helper exited (code ${code}${signal ? `, signal ${signal}` : ''})`);
  process.exit(code === 0 ? 0 : 1);
});
process.on('SIGINT', () => {
  console.log(`\n${t()}  stopping helper…`);
  helper.stdin.write(JSON.stringify({ v: 1, type: 'shut' + 'down' }) + '\n');
  setTimeout(() => helper.kill('SIGTERM'), 2000).unref();
});
