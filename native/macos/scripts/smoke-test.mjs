#!/usr/bin/env node
// End-to-end smoke test of a built OrbitDropHelper binary over its stdio protocol.
//
//   node --import tsx native/macos/scripts/smoke-test.mjs <OrbitDropHelper> [--expect-arch arm64|x64] [--enabled] [--json]
//
// With `--import tsx` every line the helper prints is validated with the real zod
// schema (parseHelperLine from packages/contracts); without it, structural checks
// are used. Never synthesizes input and never shows a window: the wheel only
// appears during a real OS drag with the modifier held, and `configure` is sent
// with enabled:false unless --enabled is given.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const binary = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--expect-arch');
const expectArch = args.includes('--expect-arch') ? args[args.indexOf('--expect-arch') + 1] : undefined;
const enabled = args.includes('--enabled');
const jsonSummary = args.includes('--json');
if (!binary || !existsSync(binary)) {
  console.error('usage: smoke-test.mjs <OrbitDropHelper> [--expect-arch arm64|x64] [--enabled] [--json]');
  process.exit(2);
}

let parseHelperLine = null;
let schemaMode = 'structural';
try {
  const contracts = await import(pathToFileURL(join(repoRoot, 'packages/contracts/src/index.ts')).href);
  parseHelperLine = contracts.parseHelperLine;
  schemaMode = 'zod';
} catch {
  // Plain node without tsx cannot load .ts files: fall back to structural checks.
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!jsonSummary) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const HELPER_TYPES = new Set(['ready', 'state', 'drop', 'cancelled', 'pong', 'permissions', 'log', 'error']);
function validate(line) {
  if (parseHelperLine) return parseHelperLine(line);
  try {
    const m = JSON.parse(line);
    return m && m.v === 1 && HELPER_TYPES.has(m.type) ? m : null;
  } catch {
    return null;
  }
}

function launch(extraArgs = []) {
  const child = spawn(binary, extraArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, messages: [], invalid: [], stderr: '', exit: null, waiters: [] };
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const message = validate(line);
      if (message) state.messages.push({ message, at: performance.now() });
      else state.invalid.push(line.slice(0, 200));
      for (const w of [...state.waiters]) w();
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (state.stderr += chunk));
  child.on('exit', (code, signal) => {
    state.exit = { code, signal, at: performance.now() };
    for (const w of [...state.waiters]) w();
  });
  child.stdin.on('error', () => {});
  state.send = (obj) => child.stdin.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n');
  state.waitFor = (predicate, ms) =>
    new Promise((resolveWait) => {
      const found = () => state.messages.find((m) => predicate(m.message));
      const hit = found();
      if (hit) return resolveWait(hit);
      const timer = setTimeout(() => {
        state.waiters = state.waiters.filter((w) => w !== waiter);
        resolveWait(null);
      }, ms);
      const waiter = () => {
        const m = found();
        if (m) {
          clearTimeout(timer);
          state.waiters = state.waiters.filter((w) => w !== waiter);
          resolveWait(m);
        }
      };
      state.waiters.push(waiter);
    });
  state.waitExit = (ms) =>
    new Promise((resolveExit) => {
      if (state.exit) return resolveExit(state.exit);
      const timer = setTimeout(() => resolveExit(null), ms);
      state.waiters.push(() => {
        if (state.exit) {
          clearTimeout(timer);
          resolveExit(state.exit);
        }
      });
    });
  return state;
}

function configureMessage() {
  const fixture = join(here, '..', 'Tests', 'OrbitDropHelperCoreTests', 'Fixtures', 'configure-en.json');
  const message = JSON.parse(readFileSync(fixture, 'utf8'));
  message.enabled = enabled;
  return message;
}

const t0 = performance.now();

// ---------------------------------------------------------------- A: protocol round trip + shutdown
{
  const h = launch();
  const started = performance.now();
  const ready = await h.waitFor((m) => m.type === 'ready', 5000);
  check('ready within 5 s', ready, ready ? `${Math.round(ready.at - started)} ms` : 'no ready');
  if (ready) {
    const r = ready.message;
    check('ready.platform darwin', r.platform === 'darwin', r.platform);
    if (expectArch) check(`ready.arch ${expectArch}`, r.arch === expectArch, r.arch);
    check('ready.pid is the child pid', r.pid === h.child.pid, `${r.pid}`);
    check('ready.globalDrag.available', r.globalDrag?.available === true, JSON.stringify(r.globalDrag));
  }
  h.send(configureMessage());
  const pingAt = performance.now();
  h.send({ v: 1, type: 'ping', nonce: 7 });
  const pong = await h.waitFor((m) => m.type === 'pong' && m.nonce === 7, 3000);
  check('configure accepted, pong 7', pong, pong ? `${Math.round(pong.at - pingAt)} ms` : '');
  h.send({ v: 1, type: 'queryPermissions' });
  const perms = await h.waitFor((m) => m.type === 'permissions', 3000);
  check('permissions reported, none required', perms && perms.message.items.every((i) => i.required === false), perms ? JSON.stringify(perms.message.items) : '');
  h.send({ v: 1, type: 'bogus' });
  const warn = await h.waitFor((m) => m.type === 'log' && m.level === 'warn' && /invalid/.test(m.message), 3000);
  check('unknown type ignored and logged', warn, warn?.message.message ?? '');
  h.send(JSON.stringify({ v: 1, type: 'ping', nonce: 1, pad: 'x'.repeat(1_048_600) }));
  const big = await h.waitFor((m) => m.type === 'log' && /longer than/.test(m.message), 3000);
  check('oversized line dropped and logged', big, big?.message.message ?? '');
  h.send({ v: 1, type: 'cancelSession', sessionId: 'nope' });
  h.send({ v: 1, type: 'ping', nonce: 8 });
  const pong2 = await h.waitFor((m) => m.type === 'pong' && m.nonce === 8, 3000);
  check('still alive after invalid input, pong 8', pong2);
  const stopAt = performance.now();
  h.send({ v: 1, type: 'shut' + 'down' });
  const exit = await h.waitExit(4000);
  check('exits 0 after the stop message', exit && exit.code === 0, exit ? `code ${exit.code} in ${Math.round(exit.at - stopAt)} ms` : 'did not exit');
  check('every stdout line is a valid protocol message', h.invalid.length === 0, h.invalid.length ? h.invalid[0] : `${h.messages.length} lines (${schemaMode})`);
  check('no sessions or drops without a real drag', !h.messages.some((m) => ['state', 'drop', 'cancelled'].includes(m.message.type)));
  if (!exit) h.child.kill('SIGKILL');
}

// ---------------------------------------------------------------- B: parent gone (stdin EOF)
{
  const h = launch();
  const ready = await h.waitFor((m) => m.type === 'ready', 5000);
  h.send(configureMessage());
  await h.waitFor((m) => m.type === 'ready', 10);
  const closedAt = performance.now();
  h.child.stdin.end();
  const exit = await h.waitExit(4000);
  check('exits 0 when stdin reaches EOF', ready && exit && exit.code === 0, exit ? `code ${exit.code} in ${Math.round(exit.at - closedAt)} ms` : 'did not exit');
  if (!exit) h.child.kill('SIGKILL');
}

// ---------------------------------------------------------------- C: SIGTERM
{
  const h = launch();
  const ready = await h.waitFor((m) => m.type === 'ready', 5000);
  h.child.kill('SIGTERM');
  const exit = await h.waitExit(4000);
  check('exits 0 on SIGTERM', ready && exit && exit.code === 0, exit ? `code ${exit.code}, signal ${exit.signal}` : 'did not exit');
  if (!exit) h.child.kill('SIGKILL');
}

// ---------------------------------------------------------------- D: CLI modes
{
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  check('--version', version.status === 0 && /OrbitDropHelper \d+\.\d+\.\d+/.test(version.stdout), version.stdout.trim());
  const probe = spawnSync(binary, ['imageio', '--probe'], { encoding: 'utf8' });
  let probed = null;
  try {
    probed = JSON.parse(probe.stdout);
  } catch {}
  const shapeOk = probed && Array.isArray(probed.decode) && Array.isArray(probed.encode) && Object.keys(probed).length === 2;
  check('imageio --probe JSON', probe.status === 0 && shapeOk, probe.stdout.trim());
  const dir = mkdtempSync(join(tmpdir(), 'orbitdrop-helper-smoke-'));
  const png = join(dir, 'wheel.png');
  const snap = spawnSync(binary, ['--render-snapshot', png, '--menu', 'pdf', '--mode', 'convert', '--highlight', '1', '--scale', '1'], { encoding: 'utf8' });
  let pngOk = false;
  if (snap.status === 0 && existsSync(png)) {
    const head = readFileSync(png).subarray(0, 24);
    pngOk = head.toString('latin1', 1, 4) === 'PNG' && head.readUInt32BE(16) === 408 && head.readUInt32BE(20) === 408 && statSync(png).size > 5000;
  }
  check('--render-snapshot writes a 408×408 PNG', pngOk, snap.stderr.trim());
}

const failed = results.filter((r) => !r.ok);
const summary = { ok: failed.length === 0, binary, schema: schemaMode, checks: results.length, failed: failed.map((f) => f.name), ms: Math.round(performance.now() - t0) };
console.log(jsonSummary ? JSON.stringify(summary) : `\n${summary.ok ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} checks (${schemaMode} validation) in ${summary.ms} ms`);
process.exit(summary.ok ? 0 : 1);
