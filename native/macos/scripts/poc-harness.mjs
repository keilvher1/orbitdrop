#!/usr/bin/env node
// Manual PoC harness for the real Finder drag test (docs/workstreams/macos-helper.md §8).
// Spawns the helper the way Electron main does (stdio NDJSON), enables observation and prints
// every session in plain language: wheel shown, payload, DROP (action + file names), cancelled
// (reason). Nothing is converted.
//
// It also checks what main relies on, so a failure is obvious without reading the protocol:
//   - every stdout line is validated with the real zod schema (when started with --import tsx);
//   - every session: AwaitingPayload first, WheelActive before a drop, exactly one terminal
//     message (drop or cancelled), nothing after it, none left open at the end.
// Problems are printed at once with "!!"; a wheel open longer than 20 s is a "??" warning (a long
// drag is fine). A summary ending in RESULT: PASS / FAIL is printed when you press Ctrl+C (twice
// to force) or the helper exits.
//
//   node --import tsx native/macos/scripts/poc-harness.mjs [--guided] [--helper <path>] [--locale ko|en]
//        [--theme light|dark|highContrast] [--reduce-motion] [--tools alt+shift] [--convert shift]
//
//   --guided   walks through the §8 steps: shows what to do and what to expect, waits for Enter,
//              then gives an automatic verdict from the helper's messages (plus a y/n question
//              for what only your eyes can judge) and a table of all steps at the end.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
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
const guided = args.includes('--guided');
const combo = (text) => text.split('+').map((k) => k.trim()).filter(Boolean);
const STUCK_MS = 20_000;

if (!existsSync(helperPath)) {
  console.error(`helper not found: ${helperPath}\nbuild it first: node scripts/build-native-mac.mjs --arch arm64`);
  process.exit(2);
}

// Configure message: the generated fixture (main's own builder) with the chosen theme's tokens.
// With tsx the contracts are loaded and the message is checked with zod; a stale fixture is an
// error (regenerate it), not a silent fallback. Without tsx, lines are checked structurally.
const fixture = () => JSON.parse(readFileSync(join(here, '..', 'Tests', 'OrbitDropHelperCoreTests', 'Fixtures', `configure-${locale}.json`), 'utf8'));
let configure = fixture();
let parseHelperLine = null;
let contracts = null;
try {
  contracts = await import(pathToFileURL(join(root, 'packages/contracts/src/index.ts')).href);
} catch {
  // plain node: no TypeScript loader
}
if (contracts) {
  configure.tokens = contracts.wheelTokens(theme, reduceMotion);
  const checked = contracts.HelperConfigureSchema.safeParse(configure);
  if (!checked.success) {
    console.error(`configure-${locale}.json does not match the current contracts — run: node --import tsx native/macos/scripts/gen-fixtures.mjs\n${checked.error.message}`);
    process.exit(2);
  }
  parseHelperLine = contracts.parseHelperLine;
}
configure.enabled = true;
configure.reduceMotion = reduceMotion;
configure.highContrast = theme === 'highContrast';
configure.modifiers = { convert: combo(opt('--convert', 'shift')), tools: combo(opt('--tools', 'alt+shift')) };

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(2).padStart(7)}s`;
const say = (text) => console.log(`${t()}  ${text}`);

// ------------------------------------------------------------------ session bookkeeping
/** id → { id, awaiting, mode, active: {menuKey, fileCount} | null, drop, cancel, startedAt, endedAt, warned } */
const sessions = new Map();
const order = [];
const anomalies = [];
/** Worth a look but not a failure by themselves (e.g. a drag held longer than 20 s). */
const warnings = [];
let lines = 0;
let invalidLines = 0;
let ready = null;
let permissions = null;

function flag(text) {
  anomalies.push(text);
  say(`!! ${text}`);
}

function session(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, awaiting: false, mode: null, active: null, drop: null, cancel: null, startedAt: Date.now(), endedAt: null, warned: false };
    sessions.set(id, s);
    order.push(s);
  }
  return s;
}

const ended = (s) => s.drop !== null || s.cancel !== null;

function onMessage(m) {
  switch (m.type) {
    case 'ready':
      ready = m;
      say(`ready: helper ${m.helperVersion} ${m.arch}, macOS ${m.osVersion}, pid ${m.pid}, global drag ${m.globalDrag.available ? 'available' : `UNAVAILABLE (${m.globalDrag.reason})`}`);
      if (!m.globalDrag.available) flag('global drag unavailable: the wheel cannot appear');
      send(configure);
      send({ v: 1, type: 'queryPermissions' });
      say(`configured: convert = ${configure.modifiers.convert.join('+')}, tools = ${configure.modifiers.tools.join('+')}, locale ${locale}, theme ${theme}${parseHelperLine ? '' : ' (no tsx: lines checked structurally, not with zod)'}`);
      if (!guided) console.log('         Drag a file in Finder and press the modifier while dragging. Ctrl+C prints the summary and quits.\n');
      else startGuide();
      break;
    case 'permissions':
      permissions = m.items;
      say(`permissions (none required): ${m.items.map((p) => `${p.name}=${p.granted ? 'granted' : 'not granted'}`).join(', ')}`);
      if (m.items.some((p) => p.required)) flag('a permission is marked required');
      break;
    case 'state': {
      const known = sessions.has(m.sessionId);
      const s = session(m.sessionId);
      if (m.state === 'Idle' || m.state === 'PotentialDrag') flag(`[${m.sessionId}] state ${m.state} must never be sent`);
      if (ended(s)) flag(`[${m.sessionId}] state ${m.state} after the session ended`);
      if (!known && m.state !== 'AwaitingPayload') flag(`[${m.sessionId}] first message is ${m.state}, not AwaitingPayload`);
      if (m.state === 'AwaitingPayload') {
        s.awaiting = true;
        s.mode = m.mode;
        say(`[${m.sessionId}] wheel shown (${m.mode}) — waiting for the drag to enter`);
      } else if (m.state === 'WheelActive') {
        s.mode = m.mode;
        s.active = { menuKey: m.menuKey ?? null, fileCount: m.fileCount };
        say(`[${m.sessionId}] ${m.mode} menu for ${m.menuKey ?? 'UNSUPPORTED items'}, ${m.fileCount} file(s)`);
      }
      break;
    }
    case 'drop': {
      const known = sessions.has(m.sessionId);
      const s = session(m.sessionId);
      say(`[${m.sessionId}] DROP ${m.actionId} (${m.mode}, ${m.dropEffect}) on ${m.files.length} file(s): ${m.files.map((f) => basename(f)).join(', ')}`);
      if (!known) flag(`[${m.sessionId}] drop for a session that was never shown`);
      else if (!s.active) flag(`[${m.sessionId}] drop before WheelActive`);
      if (s.drop) flag(`[${m.sessionId}] DUPLICATE drop — this must never happen`);
      else if (s.cancel) flag(`[${m.sessionId}] drop after cancelled`);
      if (m.dropEffect !== 'copy') flag(`[${m.sessionId}] drop effect ${m.dropEffect}, expected copy`);
      if (!s.drop) {
        s.drop = m;
        s.endedAt = Date.now();
      }
      break;
    }
    case 'cancelled': {
      const known = sessions.has(m.sessionId);
      const s = session(m.sessionId);
      say(`[${m.sessionId}] cancelled: ${m.reason}`);
      if (!known) flag(`[${m.sessionId}] cancelled for a session that was never shown`);
      if (ended(s)) flag(`[${m.sessionId}] second terminal message (cancelled after ${s.drop ? 'drop' : 'cancelled'})`);
      else {
        s.cancel = m.reason;
        s.endedAt = Date.now();
      }
      break;
    }
    case 'error':
      say(`error ${m.code}${m.fatal ? ' (fatal)' : ''}: ${m.message}`);
      if (m.fatal) flag(`fatal helper error ${m.code}`);
      break;
    case 'pong':
      break;
    default:
      say(`${m.type}: ${m.message ?? JSON.stringify(m)}`);
  }
}

function validate(line) {
  if (parseHelperLine) return parseHelperLine(line);
  try {
    const m = JSON.parse(line);
    return m && m.v === 1 && typeof m.type === 'string' ? m : null;
  } catch {
    return null;
  }
}

// A wheel that stays open long after anything happened may be the "stuck wheel" defect — or just a
// long drag (edges, Mission Control). A warning only: a session that never ends fails at the end.
setInterval(() => {
  for (const s of order) {
    if (s.awaiting && !ended(s) && !s.warned && Date.now() - s.startedAt > STUCK_MS) {
      s.warned = true;
      const text = `[${s.id}] still open after ${STUCK_MS / 1000} s — if you are not dragging any more, a wheel is stuck on screen`;
      warnings.push(text);
      say(`?? ${text}`);
    }
  }
}, 1000).unref();

// ------------------------------------------------------------------ helper process
const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
helper.on('error', (error) => {
  console.error(`cannot start the helper: ${error.message}`);
  process.exit(2);
});
helper.stdin.on('error', () => {}); // EPIPE after the helper died: the exit handler reports it
function send(message) {
  if (!helper.stdin.destroyed) helper.stdin.write(`${JSON.stringify(message)}\n`);
}
let buffer = '';
helper.stdout.setEncoding('utf8');
helper.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    lines += 1;
    const m = validate(line);
    if (!m) {
      invalidLines += 1;
      flag(`invalid protocol line${parseHelperLine ? ' (zod)' : ''}: ${line.slice(0, 160)}`);
      continue;
    }
    onMessage(m);
  }
});
helper.stderr.setEncoding('utf8');
helper.stderr.on('data', (d) => process.stderr.write(`         stderr: ${d}`));

let stopping = false;
helper.on('exit', (code, signal) => {
  say(`helper exited (code ${code}${signal ? `, signal ${signal}` : ''})`);
  if (!stopping) flag('the helper exited by itself');
  if (signal || code !== 0) flag(`helper exit status ${signal ?? code} (expected 0)`);
  finish();
});

function stop() {
  if (stopping) {
    // Second Ctrl+C: do not wait for a helper that does not exit.
    flag('stopped with a second Ctrl+C: the helper did not exit after the stop message');
    helper.kill('SIGKILL');
    finish();
    return;
  }
  stopping = true;
  console.log('');
  say('stopping helper… (Ctrl+C again to force)');
  send({ v: 1, type: 'shut' + 'down' });
  setTimeout(() => helper.kill('SIGTERM'), 2000).unref();
}

// ------------------------------------------------------------------ summary
function tally(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k}×${n}`).join(', ') || 'none';
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  for (const s of order) if (s.awaiting && !ended(s)) flag(`[${s.id}] never ended (no drop, no cancelled)`);
  const drops = order.filter((s) => s.drop);
  const cancels = order.filter((s) => s.cancel);
  console.log('\n──────── summary ────────');
  console.log(`sessions ${order.length} · drops ${drops.length} (${tally(drops.map((s) => s.drop.actionId))}) · cancelled ${cancels.length} (${tally(cancels.map((s) => s.cancel))})`);
  console.log(`protocol lines ${lines}, invalid ${invalidLines} (${parseHelperLine ? 'zod' : 'structural'})`);
  if (guided) printGuideTable();
  if (warnings.length) {
    console.log(`warnings ${warnings.length} (not failures by themselves):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (anomalies.length) {
    console.log(`anomalies ${anomalies.length}:`);
    for (const a of anomalies) console.log(`  - ${a}`);
  }
  const failedSteps = guided ? results.filter((r) => r.verdict === 'FAIL').length : 0;
  const ok = anomalies.length === 0 && failedSteps === 0;
  console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}${ok ? ' — protocol and session rules held' : ''}${guided ? '' : '; the visual checks of §8 are yours to judge'}`);
  process.exit(ok ? 0 : 1);
}

// ------------------------------------------------------------------ guided §8 walk-through
const okay = (detail = '') => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });
const noDrop = (ss) => ss.every((s) => !s.drop);
const endedWith = (reason) => (s) => s.cancel === reason;
const fileName = (s) => (s.drop ? basename(s.drop.files[0]) : '');

const STEPS = [
  {
    n: 1, title: 'Start',
    doThis: 'Nothing to do — the harness has just started the helper (see the lines above).',
    expect: 'ready … global drag available; permissions (none required); no permission dialog now or later.',
    check: () => (ready?.globalDrag.available && permissions?.every((p) => !p.required) ? okay() : fail('no ready/permissions, or global drag unavailable')),
    ask: 'No permission dialog appeared, and System Settings ▸ Privacy & Security ▸ Accessibility / Input Monitoring has no OrbitDrop entry?',
  },
  {
    n: 2, title: 'Finder drag + Shift → wheel',
    doThis: 'In Finder start dragging "Page 001.pdf"; while moving press and hold Shift; move around a little; then drop it back where it was.',
    expect: 'The wheel appears centered on the pointer within ~0.1 s: DOCX (top), JPG (right), PNG (bottom), TXT (left).',
    check: (ss) => (ss.some((s) => s.mode === 'convert' && s.active?.menuKey === 'pdf' && s.active.fileCount === 1) ? okay() : fail('no session reached "convert menu for pdf, 1 file(s)"')),
    ask: 'Finder stayed the active app (menu bar still says Finder) and the drag image kept following the pointer?',
  },
  {
    n: 3, title: 'PDF → JPG drop',
    doThis: 'Drag "Page 001.pdf" + Shift, move onto JPG (right) and release.',
    expect: 'JPG turns red-orange, capsule and the caption under the ring say JPG, the cursor shows a green "+", the wheel disappears at once.',
    check: (ss) => {
      const drops = ss.filter((s) => s.drop);
      if (drops.length !== 1) return fail(`expected exactly one DROP, saw ${drops.length}`);
      const d = drops[0].drop;
      return d.actionId === 'convert.jpeg' && d.files.length === 1 && d.dropEffect === 'copy' ? okay(fileName(drops[0])) : fail(`DROP ${d.actionId} on ${d.files.length} file(s)`);
    },
    ask: 'The PDF is still in its folder (not moved)?',
  },
  {
    n: 4, title: 'Dead zone',
    doThis: 'Open the wheel again (PDF + Shift) and release over the center capsule.',
    expect: 'No drop; the drag image slides back; the file is unchanged.',
    check: (ss) => (noDrop(ss) && ss.some(endedWith('dragEnded')) ? okay() : fail('expected cancelled: dragEnded and no DROP')),
  },
  {
    n: 5, title: 'Option+Shift → tools wheel',
    doThis: 'Drag a JPG, press Shift+Option together → drop on 자르기/CROP. Also: hold Shift BEFORE clicking a file, then drag (no wheel); release Shift and press it again (wheel opens).',
    expect: 'Tools wheel directly (no flash of the convert wheel), 7 sectors with icons, COMPRESS on top.',
    check: (ss) => (ss.some((s) => s.drop?.actionId === 'tool.crop' && s.drop.mode === 'tools') ? okay() : fail('expected DROP tool.crop (tools)')),
    ask: 'No convert-wheel flash, and Shift held before the click opened no wheel until pressed again?',
  },
  {
    n: 6, title: 'Releasing the modifier keeps the wheel',
    doThis: 'Open the wheel with Shift, release Shift, move to PNG, drop.',
    expect: 'The wheel stays after Shift is released.',
    check: (ss) => (ss.some((s) => s.drop?.actionId === 'convert.png') ? okay() : fail('expected DROP convert.png')),
  },
  {
    n: 7, title: 'Esc',
    doThis: 'Open the wheel, keep the button down with the pointer over the wheel, press Esc. Then repeat with the pointer outside the wheel and release the button.',
    expect: 'Over the wheel: it disappears within ~0.2 s (cancelled: escape). Outside: it stays until release (dragEnded), or escape if the terminal has Input Monitoring.',
    check: (ss) => (noDrop(ss) && ss.some(endedWith('escape')) ? okay() : fail('expected cancelled: escape and no DROP')),
  },
  {
    n: 8, title: 'Exit and re-entry',
    doThis: 'Open the wheel, drag out of it, come back in, drop on JPG. Then open it again, drag out and drop on a Finder folder.',
    expect: 'First: exactly one DROP. Second: Finder moves/copies as usual, the wheel disappears, no DROP.',
    check: (ss) => (ss.filter((s) => s.drop).length === 1 && ss.some((s) => !s.drop && s.cancel === 'dragEnded') ? okay() : fail('expected one DROP and one cancelled: dragEnded')),
    ask: 'Finder performed its normal move/copy into the folder?',
  },
  {
    n: 9, title: 'Beside the ring = Finder\'s drop (key hit-shape check)',
    doThis: 'With a Finder folder just outside the wheel: release (a) 10–20 pt outside the ring, (b) in a diagonal corner of the wheel\'s square, (c) just below the ring beside the caption.',
    expect: 'Each time Finder highlights the folder and receives the drop; the harness says dragEnded, never outsideRing.',
    check: (ss) => {
      if (ss.some(endedWith('outsideRing'))) return fail('outsideRing: the transparent pass-through does not apply to drags on this macOS version — report it');
      return noDrop(ss) && ss.filter(endedWith('dragEnded')).length >= 3 ? okay() : fail('expected three sessions ending with dragEnded and no DROP');
    },
    ask: 'The folder under the pointer received the drop every time?',
  },
  {
    n: 10, title: 'Disabled sector',
    doThis: 'Drag a JPG with Shift, hover HEIC (disabled in this configuration), release there.',
    expect: 'Dashed grey highlight, the reason in the capsule and the caption; no drop.',
    check: (ss) => (noDrop(ss) && ss.some(endedWith('disabledSector')) ? okay() : fail('expected cancelled: disabledSector and no DROP')),
  },
  {
    n: 11, title: 'Unsupported drags',
    doThis: 'Press Shift while dragging: selected text (TextEdit/Safari), a folder, a Photos item or Mail attachment, a .txt file. Release on the wheel each time.',
    expect: 'No sector highlights; specific capsule texts: not a file / folder / save it as a file first / not supported.',
    check: (ss) => (noDrop(ss) && ss.some((s) => s.active && s.active.menuKey === null && s.cancel === 'invalidPayload') ? okay() : fail('expected sessions with UNSUPPORTED items ending invalidPayload, no DROP')),
    ask: 'Each capsule showed the specific text (see §8 step 11)?',
  },
  {
    n: 12, title: 'Neutral wheel without a drop target',
    doThis: 'Drag a Safari tab (or a window tab), press Shift, move over the wheel.',
    expect: 'The neutral wheel disappears ~0.4 s after you move over it.',
    check: (ss) => (ss.some((s) => !s.active && s.cancel === 'invalidPayload') ? okay() : fail('expected a neutral wheel ending invalidPayload without WheelActive')),
  },
  {
    n: 13, title: 'Multiple files',
    doThis: 'Drag two JPGs with Shift+Option, drop on 압축/COMPRESS.',
    expect: 'Capsule "2 files"; EDIT/ANNOTATE/ADD BG/CROP/REDACT greyed with the one-file text.',
    check: (ss) => (ss.some((s) => s.drop?.actionId === 'tool.compress' && s.drop.files.length === 2) ? okay() : fail('expected DROP tool.compress on 2 files')),
    ask: 'The single-file tools were greyed with the one-file reason?',
  },
  {
    n: 14, title: 'Rapid repeated drops',
    doThis: 'Ten quick PDF → JPG drags in a row.',
    expect: 'Ten DROP lines, ten different session ids, no wheel left on screen.',
    check: (ss) => {
      const drops = ss.filter((s) => s.drop);
      return drops.length >= 10 && ss.every(ended) ? okay(`${drops.length} drops`) : fail(`${drops.length} drops, ${ss.filter((s) => !ended(s)).length} sessions not ended`);
    },
  },
  {
    n: 15, title: 'No Copy offered (Command)',
    doThis: 'Open the wheel with Shift, then also hold Command; hover a sector; release.',
    expect: 'Rejected dashed style while Command is held, nothing dropped; releasing Command restores the Copy highlight.',
    check: (ss) => (noDrop(ss) && ss.some((s) => s.active && s.cancel === 'invalidPayload') ? okay() : fail('expected cancelled: invalidPayload after WheelActive, no DROP')),
  },
  { n: 16, title: 'Retina / second display / edges', doThis: 'Repeat steps 2–3 on another display, at all edges and corners, near the menu bar and the Dock.', expect: 'The wheel stays inside the visible area; near the bottom the caption moves above the disc; the highlighted sector always matches the pointer.', check: null, ask: 'All placements and highlights correct?' },
  { n: 17, title: 'Spaces / full screen', doThis: 'Repeat steps 2–3 over a full-screen app and on another Space; also start Mission Control during a drag.', expect: 'The wheel appears above the full-screen app without taking focus; it hides during Mission Control and comes back.', check: null, ask: 'Shown above full-screen apps, no focus change?' },
  { n: 18, title: 'Accessibility', doThis: 'Reduce motion and Reduce transparency (System Settings ▸ Accessibility ▸ Display) while the harness runs; VoiceOver (⌘F5) while hovering JPG then HEIC, and while dragging a folder.', expect: 'No fade with Reduce motion; an opaque disc with Reduce transparency; VoiceOver speaks "JPG", "HEIC: …", and the folder text.', check: null, ask: 'Motion, transparency and VoiceOver behaved as expected?' },
  {
    n: 21, title: 'Screen lock during a drag',
    doThis: 'Open the wheel, keep the button down and lock the screen (Ctrl+Cmd+Q, or Touch ID). Unlock.',
    expect: 'After unlocking no wheel is on screen; the harness says cancelled: sleep.',
    check: (ss) => (ss.some(endedWith('sleep')) && ss.every(ended) ? okay() : fail('expected cancelled: sleep')),
  },
  {
    n: 22, title: 'Secure keyboard entry',
    doThis: 'Turn on Terminal ▸ Secure Keyboard Entry, keep Terminal frontmost and drag the folder proxy icon from its title bar with Shift; press Esc over the wheel. Turn the option off afterwards.',
    expect: 'Note whether the wheel still opens ("folders aren’t supported" is fine) and whether Esc is seen — it may not be.',
    check: null, ask: 'The wheel opened with Shift under secure keyboard entry?',
  },
  { n: 23, title: 'Second display with a different scale', doThis: 'Open the wheel on a 1× display after using it on the Retina display, and back.', expect: 'Crisp labels and ring on both; the highlighted sector matches the pointer exactly.', check: null, ask: 'Crisp on both displays and highlights exact?' },
  {
    n: 24, title: 'Online-only iCloud file',
    doThis: 'In iCloud Drive drag a PDF/JPG that shows the cloud icon (Finder ▸ Remove Download makes one) with Shift, hover the wheel, release on a sector.',
    expect: 'Capsule "먼저 내려받으세요" / "Download it first", no orange sector, no drop; the file keeps its cloud icon (nothing downloaded).',
    check: (ss) => (noDrop(ss) && ss.some((s) => s.active && s.active.menuKey === null && s.cancel === 'invalidPayload') ? okay() : fail('expected the menu to turn UNSUPPORTED and cancelled: invalidPayload, no DROP')),
    ask: 'The capsule said "Download it first" and the file still shows the cloud icon?',
  },
];
const results = [];

function startGuide() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => stop());
  rl.on('close', () => stop());
  const question = (text) => new Promise((done) => rl.question(text, done));
  (async () => {
    console.log('\nGuided §8 check — do each step in Finder, then come back here and press Enter (s = skip, q = quit).');
    for (const step of STEPS) {
      console.log(`\n── step ${step.n}: ${step.title}`);
      console.log(`   do:     ${step.doThis}`);
      console.log(`   expect: ${step.expect}`);
      const since = order.length;
      const answer = (await question('   Enter when done › ')).trim().toLowerCase();
      if (answer === 'q') break;
      if (answer === 's') {
        results.push({ n: step.n, title: step.title, verdict: 'SKIP', detail: '' });
        continue;
      }
      await new Promise((done) => setTimeout(done, 800)); // late cancel/grace messages
      const ss = order.slice(since);
      let verdict = 'PASS';
      let detail = '';
      if (step.check) {
        const r = step.check(ss);
        detail = r.detail;
        if (!r.ok) verdict = 'FAIL';
        console.log(`   ${r.ok ? '✔ helper messages as expected' : `✘ ${r.detail}`}${r.ok && r.detail ? ` (${r.detail})` : ''}`);
      }
      if (step.ask) {
        const yes = (await question(`   ${step.ask} [y/n] › `)).trim().toLowerCase().startsWith('y');
        if (!yes) {
          verdict = 'FAIL';
          detail = detail ? `${detail}; you answered no` : 'you answered no';
        }
      }
      results.push({ n: step.n, title: step.title, verdict, detail });
      console.log(`   → ${verdict}`);
    }
    console.log('\nLast step (19, parent exit): open the wheel and press Ctrl+C here — the wheel must vanish at once.');
    console.log('Or press Ctrl+C now to finish.');
  })();
}

function printGuideTable() {
  if (!results.length) return;
  console.log('steps:');
  for (const r of results) console.log(`  ${String(r.n).padStart(2)}  ${r.verdict.padEnd(4)}  ${r.title}${r.detail ? ` — ${r.detail}` : ''}`);
}

process.on('SIGINT', () => stop());
