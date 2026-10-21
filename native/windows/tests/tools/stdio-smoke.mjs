#!/usr/bin/env node
// Runtime smoke test of OrbitDropHelper.exe over real stdio pipes (Windows only;
// no GUI interaction, no drag). Used by scripts/build-native-win.mjs and CI.
//
//   node native/windows/tests/tools/stdio-smoke.mjs <OrbitDropHelper.exe> [--snapshots <dir>]
//
// Checks: `ready` arrives within 5 s with the right shape; ping → pong; queryPermissions
// → permissions []; malformed / oversized / unknown lines → non-fatal `error` without
// echoing content; a valid configure is accepted silently; closing stdin makes the
// helper exit with code 0 within 5 s; `shutdown` also exits 0. With --snapshots,
// renders wheel states to PNG with --render-snapshot and checks the output.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const exe = process.argv[2];
const snapIndex = process.argv.indexOf('--snapshots');
const snapshotDir = snapIndex > 0 ? process.argv[snapIndex + 1] : null;
if (!exe || !existsSync(exe)) {
  console.error('usage: node stdio-smoke.mjs <OrbitDropHelper.exe> [--snapshots <dir>]');
  process.exit(2);
}
if (process.platform !== 'win32') {
  console.error('stdio-smoke runs the Windows helper and needs Windows');
  process.exit(2);
}

let failures = 0;
const check = (cond, what) => {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${what}`);
  }
};

function startHelper() {
  // Same spawn options main should use: plain pipes (not 'overlapped'), no console window.
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  const waiters = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        failures += 1;
        console.error(`  FAIL  helper wrote a non-JSON line: ${line.slice(0, 120)}`);
      }
      if (msg) {
        lines.push(msg);
        for (const w of [...waiters]) if (w.pred(msg)) w.resolve(msg);
      }
    }
  });
  child.stderr.on('data', () => {});
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const waitFor = (pred, ms) =>
    new Promise((resolve) => {
      const found = lines.find(pred);
      if (found) return resolve(found);
      const w = { pred, resolve: (m) => (clearTimeout(t), waiters.splice(waiters.indexOf(w), 1), resolve(m)) };
      const t = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        resolve(null);
      }, ms);
      waiters.push(w);
    });
  const send = (obj) => child.stdin.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
  return { child, lines, waitFor, send, exited };
}

const timeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);

function configureMessage() {
  const color = '#FCE4CCF2';
  const tokens = Object.fromEntries(
    ['wheelDisc', 'wheelRing', 'wheelShadow', 'sector', 'sectorHover', 'sectorText', 'sectorIcon', 'sectorDisabled', 'sectorDisabledText',
      'sectorActive', 'sectorActiveText', 'capsule', 'capsuleText', 'capsuleReject'].map((k) => [k, color]),
  );
  Object.assign(tokens, { labelSize: 15, labelWeight: 700, iconSize: 20, capsuleTextSize: 16, appearMs: 140, disappearMs: 90 });
  const sector = (actionId, label, icon = null, batch = true) => ({ actionId, label, icon, enabled: true, batch });
  return {
    v: 1,
    type: 'configure',
    enabled: true,
    locale: 'ko',
    geometry: {
      diameter: 360, minDiameter: 240, ringWidth: 1.5, ringInset: 8, innerRadiusRatio: 0.36, sectorGap: 6, sectorCornerRadius: 14,
      capsuleWidth: 104, capsuleHeight: 46, startAngleDeg: -90, windowMargin: 24, edgePadding: 8, armDistance: 6,
    },
    tokens,
    reduceMotion: false,
    highContrast: false,
    modifiers: { convert: ['shift'], tools: ['alt', 'shift'] },
    extensions: { '.pdf': 'pdf', '.jpg': 'image/jpeg', '.png': 'image/png' },
    menus: [
      { key: 'pdf', convert: [sector('convert.docx', 'DOCX'), sector('convert.jpeg', 'JPG'), sector('convert.png', 'PNG'), sector('convert.txt', 'TXT')], tools: [] },
      { key: 'image/jpeg', convert: [sector('convert.png', 'PNG')], tools: [sector('tool.crop', '자르기', 'crop', false)] },
    ],
    strings: { dropHint: '여기에 놓기', unsupported: '지원하지 않는 형식', multiFileUnsupported: '한 번에 한 파일만', fileCount: '파일 {n}개' },
  };
}

console.log(`stdio smoke test: ${exe}`);

// ------------------------------------------------------------------ session 1: protocol, then stdin EOF
{
  const h = startHelper();
  const ready = await h.waitFor((m) => m.type === 'ready', 5000);
  check(ready !== null, 'ready within 5 s');
  if (ready) {
    check(ready.v === 1 && ready.platform === 'win32' && ready.arch === 'x64', 'ready: v=1, platform win32, arch x64');
    check(ready.pid === h.child.pid, 'ready.pid is the child pid');
    check(typeof ready.helperVersion === 'string' && ready.helperVersion.length <= 32, 'ready.helperVersion');
    check(typeof ready.globalDrag?.available === 'boolean', `ready.globalDrag.available = ${ready.globalDrag?.available} ${ready.globalDrag?.reason ?? ''}`);
    check(/^\d+\.\d+\.\d+$/.test(ready.osVersion), `ready.osVersion = ${ready.osVersion}`);
  }
  h.send({ v: 1, type: 'ping', nonce: 9007199254740991 });
  const pong = await h.waitFor((m) => m.type === 'pong', 3000);
  check(pong?.nonce === 9007199254740991, 'ping → pong with the same nonce');
  h.send({ v: 1, type: 'queryPermissions' });
  const perms = await h.waitFor((m) => m.type === 'permissions', 3000);
  check(Array.isArray(perms?.items) && perms.items.length === 0, 'queryPermissions → permissions { items: [] }');

  h.send('{"v":1,"type":"ping","nonce":"C:\\\\secret.pdf"}');
  const e1 = await h.waitFor((m) => m.type === 'error' && m.code === 'invalidMessage', 3000);
  check(e1 !== null && e1.fatal === false && !e1.message.includes('secret'), 'wrong field type → non-fatal error without echo');
  h.send('not json at all');
  check((await h.waitFor((m) => m.type === 'error' && m.code === 'invalidJson', 3000)) !== null, 'invalid JSON → error invalidJson');
  h.send({ v: 1, type: 'teleport' });
  check((await h.waitFor((m) => m.type === 'error' && m.code === 'unknownType', 3000)) !== null, 'unknown type → error unknownType');
  h.send({ v: 9, type: 'ping', nonce: 1 });
  check((await h.waitFor((m) => m.type === 'error' && m.code === 'protocolVersion', 3000)) !== null, 'v=9 → error protocolVersion');
  h.send(`{"v":1,"type":"ping","nonce":1,"pad":"${'x'.repeat(1_100_000)}"}`);
  check((await h.waitFor((m) => m.type === 'error' && m.code === 'lineTooLong', 5000)) !== null, 'line > 1 MiB → error lineTooLong');

  const errorsBefore = h.lines.filter((m) => m.type === 'error').length;
  h.send(configureMessage());
  h.send({ v: 1, type: 'ping', nonce: 7 });
  await h.waitFor((m) => m.type === 'pong' && m.nonce === 7, 3000);
  check(h.lines.filter((m) => m.type === 'error').length === errorsBefore, 'valid configure accepted without error');
  h.send({ v: 1, type: 'cancelSession', sessionId: 'not-active' });

  h.child.stdin.end();  // parent gone
  const code = await timeout(h.exited, 5000);
  check(code === 0, `stdin EOF → exit code 0 (got ${code})`);
  if (code === 'timeout') h.child.kill();
}

// ------------------------------------------------------------------ session 2: shutdown message
{
  const h = startHelper();
  await h.waitFor((m) => m.type === 'ready', 5000);
  h.send({ v: 1, type: 'shutdown' });
  const code = await timeout(h.exited, 5000);
  check(code === 0, `shutdown → exit code 0 (got ${code})`);
  if (code === 'timeout') h.child.kill();
}

// ------------------------------------------------------------------ snapshots (Direct2D/DirectWrite/WIC, no window)
if (snapshotDir) {
  mkdirSync(snapshotDir, { recursive: true });
  const cases = [
    ['pdf-convert-neutral', ['--menu', 'pdf', '--state', 'neutral']],
    ['pdf-convert-jpg', ['--menu', 'pdf', '--highlight', '1']],
    ['jpeg-tools-crop-ko', ['--menu', 'image/jpeg', '--mode', 'tools', '--highlight', '5', '--locale', 'ko']],
    ['jpeg-tools-two-files', ['--menu', 'image/jpeg', '--mode', 'tools', '--files', '2', '--highlight', '0']],
    ['jpeg-convert-dark-150', ['--menu', 'image/jpeg', '--theme', 'dark', '--scale', '1.5', '--highlight', '3']],
    ['png-convert-hc-200', ['--menu', 'image/png', '--theme', 'high-contrast', '--scale', '2', '--highlight', '0']],
    ['pdf-disabled-docx', ['--menu', 'pdf', '--disable', '0', '--highlight', '0']],
    ['unsupported', ['--menu', 'pdf', '--state', 'unsupported']],
    ['unsupported-folder-ko', ['--menu', 'pdf', '--state', 'folder', '--locale', 'ko']],
    ['unsupported-virtual', ['--menu', 'pdf', '--state', 'virtual']],
    ['unsupported-nonfile', ['--menu', 'pdf', '--state', 'nonfile']],
  ];
  for (const [name, args] of cases) {
    const out = join(snapshotDir, `windows-helper-${name}.png`);
    const r = spawnSync(exe, ['--render-snapshot', out, ...args], { encoding: 'utf8', windowsHide: true });
    let info = null;
    try {
      info = JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {}
    const okFile = existsSync(out) && statSync(out).size > 1000;
    const png = okFile ? readFileSync(out) : null;
    const isPng = png !== null && png.readUInt32BE(0) === 0x89504e47;
    check(r.status === 0 && info?.ok === true && isPng, `snapshot ${name}: ${info ? `${info.width}x${info.height}, capsule "${info.capsule}", fonts ${info.textFont} / ${info.iconFont}` : r.stdout + r.stderr}`);
  }
}

console.log(failures === 0 ? 'stdio smoke test: OK' : `stdio smoke test: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
