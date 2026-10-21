#!/usr/bin/env node
// Cross-checks the C++ helper protocol code against the zod schemas in
// packages/contracts — the schemas main uses to validate helper output and to
// build its own messages.
//
//   npx tsx native/windows/tests/tools/protocol-parity.mjs <path/to/orbitdrop-protocol-tool>
//
// 1. Every helper → main line produced by the C++ serializers must pass
//    contracts parseHelperLine (HelperToMainSchema + line length).
// 2. A configure message built the way main builds it (core buildHelperMenus /
//    helperExtensionMap / contracts wheelTokens) and the C++ reference
//    configure must both be accepted by zod and by the C++ validator.
// 3. Thousands of mutated main → helper lines (deleted fields, wrong types,
//    boundary numbers, long strings, unknown keys, …) must get the same
//    accept/reject verdict from zod (MainToHelperSchema after JSON.parse and the
//    HELPER_MAX_LINE_BYTES check) and from the C++ parser.
// Known, intentional difference (not generated): JSON with duplicate keys or
// lone surrogate escapes is rejected by C++ (JSON.parse keeps the last key /
// keeps the lone surrogate).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const contracts = await import(`${repo}/packages/contracts/src/index.ts`);
const core = await import(`${repo}/packages/core/src/capabilities.ts`);
const { MainToHelperSchema, HELPER_MAX_LINE_BYTES, utf8ByteLength, parseHelperLine, DEFAULT_WHEEL_GEOMETRY, wheelTokens, FILE_FORMATS } =
  contracts;

const tool = process.argv[2];
if (!tool) {
  console.error('usage: npx tsx protocol-parity.mjs <orbitdrop-protocol-tool>');
  process.exit(2);
}
const run = (args, input) => {
  const r = spawnSync(tool, args, { input, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${tool} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

let failures = 0;
const fail = (msg) => {
  failures += 1;
  if (failures <= 25) console.error(`  MISMATCH ${msg}`);
};

// ------------------------------------------------------------------ 1. helper → main
const samples = run(['samples']).split('\n').filter((l) => l.length > 0);
for (const line of samples) {
  if (parseHelperLine(line) === null) fail(`helper→main sample rejected by contracts: ${line.slice(0, 160)}`);
}
console.log(`helper→main: ${samples.length} C++ serializer samples checked against HelperToMainSchema`);

// ------------------------------------------------------------------ 2. configure as main builds it
const formats = Object.fromEntries(
  FILE_FORMATS.map((f) => [f, { input: f !== 'docx' && f !== 'txt', output: true, inputEngine: 'sharp', outputEngine: 'sharp' }]),
);
const probe = {
  platform: 'win32',
  arch: 'x64',
  versions: {},
  formats: { ...formats, heic: { input: false, output: false, inputEngine: 'none', outputEngine: 'none', note: 'no HEVC' } },
  pdfRender: true,
  pdfText: true,
  koreanFont: 'Malgun Gothic',
  errors: [],
  probedAt: 0,
};
const snapshot = core.buildCapabilitySnapshot(probe);
const tsConfigure = {
  v: 1,
  type: 'configure',
  enabled: true,
  locale: 'ko',
  geometry: { ...DEFAULT_WHEEL_GEOMETRY },
  tokens: wheelTokens('light', false),
  reduceMotion: false,
  highContrast: false,
  modifiers: { convert: ['shift'], tools: ['alt', 'shift'] },
  extensions: core.helperExtensionMap(snapshot),
  menus: core.buildHelperMenus(snapshot, 'ko'),
  strings: { dropHint: '여기에 놓기', unsupported: '지원하지 않는 형식', multiFileUnsupported: '한 번에 한 파일만', fileCount: '파일 {n}개' },
};
const cppConfigure = JSON.parse(run(['configure', 'ko', 'light']));
for (const [name, msg] of [
  ['main-built configure', tsConfigure],
  ['C++ reference configure', cppConfigure],
]) {
  const r = MainToHelperSchema.safeParse(msg);
  if (!r.success) fail(`${name} rejected by zod: ${JSON.stringify(r.error.issues).slice(0, 300)}`);
}

// ------------------------------------------------------------------ 3. corpus
let seed = 1234567;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const clone = (v) => JSON.parse(JSON.stringify(v));

const interesting = [
  0, -0, 1, -1, 0.5, 2, 6, 8, 12, 20, 24, 32, 40, 48, 60, 80, 99.5, 100, 101, 160, 199.999, 200, 360, 600, 600.0001, 700, 700.5, 900, 901, 1000,
  1001, -360, -360.5, 0.15, 0.149, 0.6, 0.6001, 1e21, 9007199254740991, 9007199254740992, -1e-9, '', 'x', 'shift', 'alt', 'command', 'hyper', 'pdf',
  'image/jpeg', 'image/xyz', 'images', 'mixed', 'convert.jpeg', 'convert.gif', 'tool.crop', 'compress', 'star', 'ko', 'en', 'de', '#FFF', '#FF00AA',
  '#ff00aa80', '#GG0000', 'FF00AA', 'L'.repeat(32), 'L'.repeat(33), 'L'.repeat(30) + '😀', 'L'.repeat(31) + '😀', 'r'.repeat(120), 'r'.repeat(121),
  'd'.repeat(60), 'd'.repeat(61), '한'.repeat(32), '한'.repeat(33), true, false, null, [], {}, ['shift'], ['shift', 'shift'], ['alt', 'shift'],
  ['shift', 'alt', 'control', 'command'], { extra: 1 },
];

/** All paths (arrays of keys) to values inside `v`. */
const paths = (v, prefix = []) => {
  const out = [prefix];
  if (Array.isArray(v)) v.forEach((e, i) => out.push(...paths(e, [...prefix, i])));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) out.push(...paths(v[k], [...prefix, k]));
  return out;
};
const getAt = (v, p) => p.reduce((o, k) => (o == null ? undefined : o[k]), v);
const isContainer = (o) => o !== null && typeof o === 'object';
const setAt = (v, p, value) => {
  if (p.length === 0) return value;
  const parent = getAt(v, p.slice(0, -1));
  if (isContainer(parent)) parent[p[p.length - 1]] = value;
  return v;
};
const deleteAt = (v, p) => {
  const parent = getAt(v, p.slice(0, -1));
  if (Array.isArray(parent)) parent.splice(p[p.length - 1], 1);
  else if (isContainer(parent)) delete parent[p[p.length - 1]];
  return v;
};

const corpus = [];
const add = (line, why) => corpus.push({ line, why });
add(JSON.stringify(tsConfigure), 'main-built configure');
add(JSON.stringify(cppConfigure), 'C++ reference configure');

for (const base of [tsConfigure, cppConfigure]) {
  const all = paths(base).filter((p) => p.length > 0);
  const iterations = Number(process.env.PARITY_ITERATIONS ?? 2500);
  for (let i = 0; i < iterations; i += 1) {
    const m = clone(base);
    // Occasionally apply a second, independent mutation first.
    if (rnd() < 0.3) {
      const q = pick(all);
      setAt(m, q, pick(interesting));
    }
    const p = pick(all);
    if (!isContainer(getAt(m, p.slice(0, -1)))) continue;
    const op = rnd();
    let why;
    if (op < 0.15 && p.length > 0) {
      deleteAt(m, p);
      why = `delete ${p.join('.')}`;
    } else if (op < 0.25) {
      const parent = getAt(m, p);
      if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
        parent[pick(['extra', 'Label', '__proto__x', '.zip', 'reason'])] = pick(interesting);
        why = `add key under ${p.join('.')}`;
      } else {
        setAt(m, p, pick(interesting));
        why = `set ${p.join('.')}`;
      }
    } else if (op < 0.32) {
      const arr = getAt(m, p.slice(0, -1));
      if (Array.isArray(arr) && arr.length > 0) {
        const n = pick([12, 13, 32, 33]);
        while (arr.length < n) arr.push(clone(arr[0]));
        why = `grow ${p.slice(0, -1).join('.')} to ${n}`;
      } else {
        setAt(m, p, pick(interesting));
        why = `set ${p.join('.')}`;
      }
    } else {
      const value = pick(interesting);
      setAt(m, p, value);
      why = `set ${p.join('.')} = ${JSON.stringify(value)?.slice(0, 40)}`;
    }
    add(JSON.stringify(m), why);
  }
}

// Envelopes and the small messages.
const small = [
  { v: 1, type: 'ping', nonce: 0 },
  { v: 1, type: 'ping', nonce: 9007199254740991 },
  { v: 1, type: 'ping', nonce: 9007199254740992 },
  { v: 1, type: 'ping', nonce: -1 },
  { v: 1, type: 'ping', nonce: 1.5 },
  { v: 1, type: 'ping', nonce: '1' },
  { v: 1, type: 'ping' },
  { v: 1, type: 'ping', nonce: 1, extra: 0 },
  { v: 1.0, type: 'ping', nonce: 3 },
  { v: 2, type: 'ping', nonce: 3 },
  { v: '1', type: 'ping', nonce: 3 },
  { type: 'ping', nonce: 3 },
  { v: 1, type: 'Ping', nonce: 3 },
  { v: 1, type: 'drop' },
  { v: 1, type: 5 },
  { v: 1, type: 'shutdown' },
  { v: 1, type: 'shutdown', x: null },
  { v: 1, type: 'queryPermissions' },
  { v: 1, type: 'queryPermissions', items: [] },
  { v: 1, type: 'cancelSession', sessionId: 'w1a2b-3f9c0d12ab-1' },
  { v: 1, type: 'cancelSession', sessionId: '' },
  { v: 1, type: 'cancelSession', sessionId: 'a'.repeat(64) },
  { v: 1, type: 'cancelSession', sessionId: 'a'.repeat(65) },
  { v: 1, type: 'cancelSession', sessionId: 'a b' },
  { v: 1, type: 'cancelSession', sessionId: 'é' },
  { v: 1, type: 'cancelSession', sessionId: 7 },
  [1, 2],
  'string',
  42,
  null,
];
for (const m of small) add(JSON.stringify(m), `small ${JSON.stringify(m).slice(0, 60)}`);
for (const raw of ['', 'not json', '{', '{"v":1,"type":"ping","nonce":1}x', '{"v":1,"type":"ping","nonce":01}', '{"v":1,"type":"ping","nonce":1e400}']) {
  add(raw, `raw ${raw}`);
}
add(JSON.stringify({ v: 1, type: 'ping', nonce: 1, pad: 'x'.repeat(HELPER_MAX_LINE_BYTES) }), 'oversized line');
const nearLimit = { ...tsConfigure, strings: { ...tsConfigure.strings } };
add(JSON.stringify(nearLimit), 'configure (again)');

// ------------------------------------------------------------------ compare
const verdicts = run(['parse'], corpus.map((c) => c.line).join('\n') + '\n')
  .split('\n')
  .filter((l) => l.length > 0);
if (verdicts.length !== corpus.length) fail(`tool returned ${verdicts.length} verdicts for ${corpus.length} lines`);
let accepted = 0;
corpus.forEach((c, i) => {
  let tsOk = false;
  if (utf8ByteLength(c.line) <= HELPER_MAX_LINE_BYTES) {
    try {
      tsOk = MainToHelperSchema.safeParse(JSON.parse(c.line)).success;
    } catch {
      tsOk = false;
    }
  }
  const cppOk = (verdicts[i] ?? '').startsWith('ok ');
  if (tsOk) accepted += 1;
  if (tsOk !== cppOk) fail(`${c.why}: zod ${tsOk ? 'accepts' : 'rejects'}, C++ ${verdicts[i]}`);
});
console.log(`main→helper: ${corpus.length} lines compared (${accepted} accepted by zod, ${corpus.length - accepted} rejected)`);
if (failures > 0) {
  console.error(`protocol parity: ${failures} mismatch(es)`);
  process.exit(1);
}
console.log('protocol parity: OK');
