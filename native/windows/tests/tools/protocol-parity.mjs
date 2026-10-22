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
//    boundary numbers, long strings, unknown keys, …) plus parser-level edge
//    cases (whitespace, escapes, number spellings) must get the same
//    accept/reject verdict from zod (MainToHelperSchema after JSON.parse and the
//    HELPER_MAX_LINE_BYTES check) and from the C++ parser.
//    Escaped lone surrogates are accepted like JSON.parse does (read as U+FFFD,
//    one code point, as zod counts a lone surrogate) — the macOS helper too.
// 4. Known, intentional differences are checked to stay what the docs say: JSON
//    with duplicate keys, and lines with more than 50,000 JSON values, are
//    accepted by zod (JSON.parse keeps the last key) and rejected by C++.
// 5. When present, the macOS helper's zod-generated corpus
//    (native/macos/Tests/OrbitDropHelperCoreTests/Fixtures/protocol-cases.json,
//    each line with zod's verdict) must get the same verdicts here, so both
//    helpers follow the same rules; only duplicate keys may differ (rejected).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
// Parser-level edge cases: whitespace, escapes, number spellings JSON.parse accepts.
for (const raw of [
  ' {"v":1,"type":"ping","nonce":1}\r',
  '{"v":1 ,"type" : "shutdown" }\t',
  '﻿{"v":1,"type":"ping","nonce":1}', // a BOM is not JSON whitespace
  '{"v":1,"type":"ping","nonce":1} ', // nor is NBSP
  '{"\\u0076":1,"type":"ping","nonce":1}', // escaped key "v"
  '{"v":1,"type":"\\u0070ing","nonce":1}',
  '{"v":1,"type":"ping","nonce":1E0}',
  '{"v":1,"type":"ping","nonce":1.0}',
  '{"v":1,"type":"ping","nonce":-0}',
  '{"v":1,"type":"ping","nonce":1e-400}', // underflows to 0: a valid nonce
  '{"v":1,"type":"ping","nonce":5e-324}', // subnormal: not an integer
  '{"v":1,"type":"ping","nonce":100000000000000000000}',
  '{"v":1,"type":"ping","nonce":9007199254740991.4}', // rounds to MAX_SAFE_INTEGER
  '{"v":1,"type":"ping","nonce":9007199254740992.5}',
  '{"v":1.0000000000000002,"type":"ping","nonce":1}',
  '{"v":1,"type":"cancelSession","sessionId":"\\u0061bc"}',
  '{"v":1,"type":"cancelSession","sessionId":"ab\\u0000"}',
]) {
  add(raw, `raw ${JSON.stringify(raw)}`);
}
// Escaped lone surrogates (JSON.stringify writes them for a split pair): valid
// JavaScript strings, each one code point for zod's limits.
const withLabel = (label) => {
  const m = clone(tsConfigure);
  m.menus[0].convert[0].label = label;
  return JSON.stringify(m);
};
add(JSON.stringify({ ...tsConfigure, strings: { ...tsConfigure.strings, dropHint: 'a\ud800b' } }), 'lone high surrogate in dropHint');
add(JSON.stringify({ ...tsConfigure, strings: { ...tsConfigure.strings, unsupported: '\udbffA' } }), 'high surrogate before a BMP character');
add(withLabel('\udc00\ud800'), 'reversed surrogates in a label');
add(withLabel('\ud800'.repeat(32)), 'label of 32 lone surrogates');
add(withLabel('\ud800'.repeat(33)), 'label of 33 lone surrogates');
// Labels measured in code points with an escaped surrogate pair (32 = the limit).
const tsLine = JSON.stringify(tsConfigure);
add(tsLine.replace(/"label":"[^"]*"/, `"label":"${'L'.repeat(31)}\\ud83d\\ude00"`), 'label: 31 + escaped pair = 32 code points');
add(tsLine.replace(/"label":"[^"]*"/, `"label":"${'L'.repeat(32)}\\ud83d\\ude00"`), 'label: 32 + escaped pair = 33 code points');
add(JSON.stringify({ v: 1, type: 'ping', nonce: 1, pad: 'x'.repeat(HELPER_MAX_LINE_BYTES) }), 'oversized line');
const nearLimit = { ...tsConfigure, strings: { ...tsConfigure.strings } };
add(JSON.stringify(nearLimit), 'configure (again)');

// ------------------------------------------------------------------ 4. intentional differences
// zod accepts these, the helpers reject them on purpose (main never sends them):
// duplicate keys (see the header and the contract), and more than
// 50,000 JSON values in one line (json::ParseOptions::maxValues bounds memory;
// main's configure has about 1,600).
const bigExtensions = {};
for (let i = 0; Object.keys(bigExtensions).length < 50_001; i += 1) bigExtensions[`.${i.toString(36)}`] = 'pdf';
const differences = [
  ['duplicate key', '{"v":1,"type":"ping","nonce":1,"nonce":2}'],
  ['more than 50,000 JSON values', JSON.stringify({ ...tsConfigure, extensions: bigExtensions })],
];

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

const differenceVerdicts = run(['parse'], differences.map(([, line]) => line).join('\n') + '\n')
  .split('\n')
  .filter((l) => l.length > 0);
differences.forEach(([why, line], i) => {
  const tsOk = utf8ByteLength(line) <= HELPER_MAX_LINE_BYTES && MainToHelperSchema.safeParse(JSON.parse(line)).success;
  if (!tsOk) fail(`intentional difference "${why}": expected zod to accept it`);
  if ((differenceVerdicts[i] ?? '').startsWith('ok ')) fail(`intentional difference "${why}": C++ accepted it (${differenceVerdicts[i]})`);
});
console.log(`intentional differences: ${differences.length} lines accepted by zod and rejected by C++ as documented`);

// ------------------------------------------------------------------ 5. the macOS helper's corpus
/** True when an object in a JSON text repeats a member name (after unescaping). */
const hasDuplicateKey = (text) => {
  const frames = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '{' || c === '[') {
      frames.push({ object: c === '{', keys: new Set(), expectKey: c === '{' });
      i += 1;
    } else if (c === '}' || c === ']') {
      frames.pop();
      i += 1;
    } else if (c === ',') {
      const top = frames[frames.length - 1];
      if (top?.object) top.expectKey = true;
      i += 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = frames[frames.length - 1];
      if (top?.object && top.expectKey) {
        let key;
        try {
          key = JSON.parse(text.slice(i, j + 1));
        } catch {
          return false;
        }
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return false;
};
const macCorpus = `${repo}/native/macos/Tests/OrbitDropHelperCoreTests/Fixtures/protocol-cases.json`;
if (existsSync(macCorpus)) {
  const { cases } = JSON.parse(readFileSync(macCorpus, 'utf8'));
  const usable = cases.filter((c) => typeof c.line === 'string' && typeof c.valid === 'boolean' && !c.line.includes('\n'));
  if (usable.length === 0) fail('macOS helper corpus: no {name, line, valid} cases found (format changed?)');
  const macVerdicts = run(['parse'], usable.map((c) => c.line).join('\n') + '\n')
    .split('\n')
    .filter((l) => l.length > 0);
  let allowed = 0;
  usable.forEach((c, i) => {
    const cppOk = (macVerdicts[i] ?? '').startsWith('ok ');
    if (cppOk === c.valid) return;
    if (c.valid && !cppOk && hasDuplicateKey(c.line)) {
      allowed += 1;
      return;
    }
    fail(`macOS corpus "${c.name}": zod ${c.valid ? 'accepts' : 'rejects'}, C++ ${macVerdicts[i]}`);
  });
  console.log(`macOS helper corpus: ${usable.length} zod-verdict lines compared (${allowed} duplicate-key line(s) rejected as documented)`);
} else {
  console.log('macOS helper corpus: not present, skipped');
}
if (failures > 0) {
  console.error(`protocol parity: ${failures} mismatch(es)`);
  process.exit(1);
}
console.log('protocol parity: OK');
