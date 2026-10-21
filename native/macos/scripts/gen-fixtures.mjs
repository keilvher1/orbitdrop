#!/usr/bin/env node
// Generates the Swift unit-test fixtures of the macOS helper from the real
// TypeScript sources, so the Swift port is checked against the reference
// rather than against restated expectations.
//
//   node --import tsx native/macos/scripts/gen-fixtures.mjs        (from the repo root)
//
// Writes native/macos/Tests/OrbitDropHelperCoreTests/Fixtures/:
//   js-math-vectors.json   Math.atan2 / Math.hypot results (bit patterns) + a digest
//                          over 200k generated inputs (xorshift32, reproduced in Swift)
//   geometry-vectors.json  hitTestWheel / placeWheel / isArmed / displayIndexForPoint /
//                          AppKit conversions from packages/core (bit patterns)
//   configure-ko.json, configure-en.json
//                          configure messages built with buildHelperMenus,
//                          helperExtensionMap, wheelTokens and validated by zod
//   protocol-cases.json    main→helper lines with zod's verdict (valid / invalid),
//                          used to check the Swift strict decoder agrees with zod
//
// The canonical cross-implementation vectors are tests/fixtures/wheel-golden.json
// (owned by the core workstream); these fixtures add bit-level coverage.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const outDir = join(here, '..', 'Tests', 'OrbitDropHelperCoreTests', 'Fixtures');
mkdirSync(outDir, { recursive: true });

const contracts = await import(pathToFileURL(join(root, 'packages/contracts/src/index.ts')).href);
const core = await import(pathToFileURL(join(root, 'packages/core/src/index.ts')).href);

// ------------------------------------------------------------------ helpers
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
/** IEEE-754 bit pattern of a double as 16 lower-case hex digits (big-endian order). */
function bits(x) {
  f64[0] = x;
  return u32[1].toString(16).padStart(8, '0') + u32[0].toString(16).padStart(8, '0');
}
function write(name, value) {
  const path = join(outDir, name);
  writeFileSync(path, JSON.stringify(value) + '\n');
  console.log(`wrote ${path}`);
}

// xorshift32 — exact in JS (int32 ops) and in Swift (UInt32 wrapping shifts).
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}
const U = 4294967296;
/** FNV-1a over the 8 bytes (little-endian) of each double. */
function fnv1a(state, x) {
  f64[0] = x;
  const bytes = new Uint8Array(f64.buffer);
  let h = state;
  for (let i = 0; i < 8; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// ------------------------------------------------------------------ JS math vectors
{
  const rows = [];
  const next = rng(0x9e3779b9);
  const sample = (kind) => {
    const a = next() / U;
    const b = next() / U;
    switch (kind) {
      case 0:
        return [(a - 0.5) * 800, (b - 0.5) * 800];
      case 1:
        return [Math.floor((a - 0.5) * 800 + 0.5), Math.floor((b - 0.5) * 800 + 0.5)];
      case 2:
        return [Math.floor((a - 0.5) * 8000 + 0.5) / 8, Math.floor((b - 0.5) * 8000 + 0.5) / 8];
      default: {
        const e1 = (next() % 60) - 30;
        const e2 = (next() % 60) - 30;
        return [(a - 0.5) * 2 ** e1, (b - 0.5) * 2 ** e2];
      }
    }
  };
  for (let i = 0; i < 2000; i += 1) {
    const [y, x] = sample(i % 4);
    rows.push([bits(y), bits(x), bits(Math.atan2(y, x)), bits(Math.hypot(x, y))]);
  }
  const specials = [
    [0, 0], [-0, 0], [0, -0], [-0, -0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
    [1e-300, 1], [1, 1e-300], [-1e-300, -1], [Infinity, 1], [1, Infinity], [Infinity, Infinity], [-Infinity, Infinity],
    [Infinity, -Infinity], [-Infinity, -Infinity], [1, -Infinity], [-1, -Infinity], [NaN, 1], [1, NaN], [5e-324, 1],
    [1, 5e-324], [1.7976931348623157e308, 1], [1, 1.7976931348623157e308], [2 ** 70, 1], [1, 2 ** 70],
  ];
  for (const [y, x] of specials) rows.push([bits(y), bits(x), bits(Math.atan2(y, x)), bits(Math.hypot(x, y))]);
  // Points on sector boundary rays, as hit-testing produces them.
  for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 11, 12]) {
    for (let i = 0; i < count; i += 1) {
      const deg = -90 + (i * 360) / count - 360 / count / 2;
      for (const r of [64.8, 65, 100, 120.5, 171.99, 180]) {
        const x = r * Math.cos((deg * Math.PI) / 180);
        const y = r * Math.sin((deg * Math.PI) / 180);
        rows.push([bits(y), bits(x), bits(Math.atan2(y, x)), bits(Math.hypot(x, y))]);
      }
    }
  }
  // Digest over many generated inputs (the Swift test regenerates them).
  const digestSeed = 0x1234abcd;
  const digestCount = 200000;
  const gen = rng(digestSeed);
  let hAtan = 2166136261;
  let hHypot = 2166136261;
  for (let i = 0; i < digestCount; i += 1) {
    const a = gen() / U;
    const b = gen() / U;
    const y = (a - 0.5) * 1000;
    const x = (b - 0.5) * 1000;
    hAtan = fnv1a(hAtan, Math.atan2(y, x));
    hHypot = fnv1a(hHypot, Math.hypot(x, y));
  }
  write('js-math-vectors.json', {
    $comment: 'Rows: [y, x, Math.atan2(y, x), Math.hypot(x, y)] as IEEE-754 bit patterns. digest: FNV-1a(32) over the little-endian bytes of the results for inputs y=(a-0.5)*1000, x=(b-0.5)*1000 with a, b = xorshift32/2^32 (y first).',
    node: process.version,
    arch: process.arch,
    rows,
    digest: { seed: digestSeed, count: digestCount, atan2: hAtan, hypot: hHypot },
  });
}

// ------------------------------------------------------------------ geometry vectors
{
  const G = contracts.DEFAULT_WHEEL_GEOMETRY;
  const geometries = [
    G,
    { ...G, diameter: 320, innerRadiusRatio: 0.3, startAngleDeg: -90 },
    { ...G, diameter: 380, innerRadiusRatio: 0.42, startAngleDeg: 0, armDistance: 12 },
    { ...G, diameter: 600, minDiameter: 600, innerRadiusRatio: 0.15, startAngleDeg: 45.5, edgePadding: 0 },
    { ...G, diameter: 200, minDiameter: 160, innerRadiusRatio: 0.6, startAngleDeg: -360, windowMargin: 0, edgePadding: 80 },
    { ...G, diameter: 240, minDiameter: 300, startAngleDeg: 360, armDistance: 0 },
  ];
  const enc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, bits(v)]));
  const hits = [];
  const next = rng(0xc0ffee);
  const counts = [0, 1, 2, 3, 4, 7, 8, 12, 2.7, -1];
  for (let gi = 0; gi < geometries.length; gi += 1) {
    const g = geometries[gi];
    for (const count of counts) {
      const n = Math.max(1, Math.trunc(count));
      const span = 360 / n;
      const rIn = (g.diameter / 2) * g.innerRadiusRatio;
      const rOut = g.diameter / 2;
      const cases = [];
      for (let k = 0; k < 12; k += 1) {
        const a = next() / U;
        const b = next() / U;
        cases.push([(a - 0.5) * g.diameter * 1.2, (b - 0.5) * g.diameter * 1.2]);
      }
      for (let i = 0; i < n; i += 1) {
        const edge = g.startAngleDeg + i * span - span / 2;
        const center = g.startAngleDeg + i * span;
        const polar = (r, deg) => cases.push([r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)]);
        for (const r of [rIn, rIn + 1e-9, (rIn + rOut) / 2, rOut, rOut + 1e-9]) polar(r, edge);
        for (const deg of [edge + 1e-9, edge - 1e-9, center]) polar((rIn + rOut) / 2, deg);
      }
      cases.push([0, 0], [rIn, 0], [0, -rOut], [-rOut, 0], [NaN, 0], [Infinity, 0], [0, -Infinity]);
      for (const [dx, dy] of cases) {
        const hit = core.hitTestWheel(dx, dy, count, g.diameter, g);
        hits.push([gi, bits(dx), bits(dy), bits(count), bits(g.diameter), hit.zone, hit.zone === 'sector' ? bits(hit.index) : null]);
      }
    }
  }
  const placements = [];
  const workAreas = [
    { x: 0, y: 25, width: 1512, height: 919 },
    { x: -1920, y: -200, width: 1920, height: 1055 },
    { x: 1512, y: 0, width: 2560, height: 1415 },
    { x: 0, y: 0, width: 300, height: 260 },
    { x: 10.5, y: 33.25, width: 199.5, height: 1000 },
    { x: 0, y: 0, width: 100, height: 100 },
  ];
  for (let gi = 0; gi < geometries.length; gi += 1) {
    const g = geometries[gi];
    for (const wa of workAreas) {
      const pts = [
        { x: wa.x + wa.width / 2, y: wa.y + wa.height / 2 },
        { x: wa.x, y: wa.y },
        { x: wa.x + wa.width - 1, y: wa.y + wa.height - 1 },
        { x: wa.x - 50, y: wa.y + 10 },
        { x: wa.x + 3.25, y: wa.y + wa.height + 400 },
      ];
      for (let k = 0; k < 4; k += 1) pts.push({ x: wa.x + (next() / U) * wa.width, y: wa.y + (next() / U) * wa.height });
      for (const p of pts) {
        const r = core.placeWheel(p, wa, g);
        placements.push({ g: gi, activation: enc(p), workArea: enc(wa), center: enc(r.center), diameter: bits(r.diameter), windowFrame: enc(r.windowFrame), shifted: r.shifted });
      }
    }
  }
  const arming = [];
  for (let gi = 0; gi < geometries.length; gi += 1) {
    const g = geometries[gi];
    const act = { x: 100.25, y: -50.5 };
    const pts = [act, { x: act.x + g.armDistance, y: act.y }, { x: act.x + g.armDistance - 1e-9, y: act.y }, { x: act.x + 3, y: act.y + 4 }, { x: NaN, y: 0 }, { x: Infinity, y: 0 }];
    for (let k = 0; k < 6; k += 1) pts.push({ x: act.x + ((next() / U) - 0.5) * 30, y: act.y + ((next() / U) - 0.5) * 30 });
    for (const p of pts) {
      for (const passed of [false, true]) arming.push({ g: gi, activation: enc(act), pointer: enc(p), passedCenter: passed, armed: core.isArmed(act, p, passed, g) });
    }
  }
  const displaySets = [
    [{ x: 0, y: 0, width: 1512, height: 982 }],
    [{ x: 0, y: 0, width: 1512, height: 982 }, { x: 1512, y: -300, width: 2560, height: 1440 }],
    [{ x: 0, y: 0, width: 1440, height: 900 }, { x: -1920, y: 0, width: 1920, height: 1080 }, { x: 0, y: -1080, width: 1920, height: 1080 }],
  ];
  const displays = [];
  for (let si = 0; si < displaySets.length; si += 1) {
    const set = displaySets[si];
    const pts = [{ x: 0, y: 0 }, { x: 1512, y: 0 }, { x: 1511.999, y: 981.5 }, { x: -1, y: -1 }, { x: 5000, y: 5000 }, { x: -3000, y: 500 }, { x: 700, y: -2000 }, { x: 1600, y: 1200 }];
    for (const p of pts) displays.push({ set: si, point: enc(p), index: core.displayIndexForPoint(p, set) });
  }
  const conversions = [];
  const primaries = [{ x: 0, y: 0, width: 1512, height: 982 }, { x: 0, y: 0, width: 2560, height: 1440 }];
  for (const pf of primaries) {
    for (const p of [{ x: 0, y: 0 }, { x: 100.5, y: 900.25 }, { x: -1920, y: 1500 }, { x: 3000, y: -400 }]) {
      conversions.push({ kind: 'point', primary: enc(pf), input: enc(p), toGlobal: enc(core.appKitPointToGlobal(p, pf)), toAppKit: enc(core.globalPointToAppKit(p, pf)) });
    }
    for (const r of [{ x: 0, y: 0, width: 1512, height: 957 }, { x: -1920, y: 100, width: 1920, height: 1080 }, { x: 12.5, y: 40, width: 408, height: 408 }]) {
      conversions.push({ kind: 'rect', primary: enc(pf), input: enc(r), toGlobal: enc(core.appKitRectToGlobal(r, pf)), toAppKit: enc(core.globalRectToAppKit(r, pf)) });
    }
  }
  write('geometry-vectors.json', {
    $comment: 'Generated from packages/core (geometry.ts, coords.ts). All numbers are IEEE-754 bit patterns (16 hex digits). hitTests rows: [geometryIndex, dx, dy, sectorCount, diameter, zone, index|null]; sectorCount may be fractional/negative to pin truncation.',
    geometries: geometries.map(enc),
    hitTests: hits,
    placements,
    arming,
    displaySets: displaySets.map((s) => s.map(enc)),
    displays,
    conversions,
  });
}

// ------------------------------------------------------------------ configure messages
/** Helper strings from apps/desktop/src/shared/locales/<locale>/main.json (flat "helper.*" keys). */
function localeStrings(locale) {
  const file = join(root, 'apps/desktop/src/shared/locales', locale, 'main.json');
  const fallback = {
    ko: { dropHint: '여기에 놓기', unsupported: '지원하지 않는 파일', multiFileUnsupported: '한 번에 한 파일만', fileCount: '{n}개 파일' },
    en: { dropHint: 'Drop here', unsupported: 'Not supported', multiFileUnsupported: 'One file at a time', fileCount: '{n} files' },
  }[locale];
  // The optional, more specific texts (helper-protocol.ts); main may not send them yet.
  const specific = {
    ko: { unsupportedFolder: '폴더는 지원하지 않음', unsupportedNonFile: '파일이 아닌 항목', unsupportedVirtual: '디스크에 없는 항목' },
    en: { unsupportedFolder: "Folders aren't supported", unsupportedNonFile: 'Not a file', unsupportedVirtual: 'Not a file on disk' },
  }[locale];
  let json = {};
  try {
    if (existsSync(file)) json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    json = {};
  }
  const pick = (key) => json[`helper.${key}`] ?? json.helper?.[key];
  const base = Object.fromEntries(Object.entries(fallback).map(([key, value]) => [key, pick(key) ?? value]));
  const extra = Object.fromEntries(Object.entries(specific).map(([key, value]) => [key, pick(key) ?? value]));
  return { base, extra };
}

/** desktop-main's own builder, so the fixture is exactly what main sends (falls back to a local copy). */
async function mainConfigureBuilder() {
  try {
    const mod = await import(pathToFileURL(join(root, 'apps/desktop/src/main/helper/configure.ts')).href);
    return typeof mod.buildConfigureMessage === 'function' ? mod.buildConfigureMessage : null;
  } catch {
    return null;
  }
}

function probe() {
  const yes = (engine) => ({ input: true, output: true, inputEngine: engine, outputEngine: engine });
  const formats = {
    jpeg: yes('sharp'),
    png: yes('sharp'),
    webp: yes('sharp'),
    gif: yes('sharp'),
    tiff: yes('sharp'),
    avif: yes('sharp'),
    heic: { input: false, output: false, inputEngine: 'none', outputEngine: 'none', note: 'measured: sharp prebuilt has no HEVC' },
    bmp: yes('builtin-bmp'),
    pdf: { input: true, output: true, inputEngine: 'pdfjs', outputEngine: 'pdf-lib' },
    docx: { input: false, output: true, inputEngine: 'none', outputEngine: 'docx' },
    txt: { input: false, output: true, inputEngine: 'none', outputEngine: 'text' },
  };
  return { platform: 'darwin', arch: 'arm64', versions: {}, formats, pdfRender: true, pdfText: true, koreanFont: 'Apple SD Gothic Neo', errors: [], probedAt: 0 };
}

const configures = {};
const buildConfigureMessage = await mainConfigureBuilder();
console.log(buildConfigureMessage ? 'configure: built with apps/desktop/src/main/helper/configure.ts' : 'configure: desktop-main builder unavailable, using the local copy');
for (const locale of ['ko', 'en']) {
  const snapshot = core.buildCapabilitySnapshot(probe());
  const { base, extra } = localeStrings(locale);
  let message;
  if (buildConfigureMessage) {
    const settings = { ...contracts.DEFAULT_SETTINGS, locale };
    message = buildConfigureMessage({ settings, snapshot, theme: 'light', reduceMotion: false, highContrast: false, strings: base });
  } else {
    message = {
      v: 1,
      type: 'configure',
      enabled: true,
      locale,
      geometry: { ...contracts.DEFAULT_WHEEL_GEOMETRY },
      tokens: contracts.wheelTokens('light', false),
      reduceMotion: false,
      highContrast: false,
      modifiers: { convert: contracts.DEFAULT_SETTINGS.globalDrag.convertModifiers, tools: contracts.DEFAULT_SETTINGS.globalDrag.toolsModifiers },
      extensions: core.helperExtensionMap(snapshot),
      menus: core.buildHelperMenus(snapshot, locale),
      strings: base,
    };
  }
  // Include the optional specific strings (main will send them after this helper lands).
  message = { ...message, strings: { ...message.strings, ...extra } };
  contracts.HelperConfigureSchema.parse(message);
  configures[locale] = message;
  write(`configure-${locale}.json`, message);
}

// ------------------------------------------------------------------ protocol parity cases
{
  // Mutations start from a compact but complete configure (two menus) to keep the file small;
  // the full generated configure is checked separately (configure-*.json and the 'full' case).
  const base = {
    ...configures.en,
    menus: configures.en.menus.filter((m) => m.key === 'pdf' || m.key === 'image/jpeg'),
    extensions: { '.pdf': 'pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' },
  };
  const clone = () => JSON.parse(JSON.stringify(base));
  const cases = [];
  const add = (name, value) => {
    const line = typeof value === 'string' ? value : JSON.stringify(value);
    let valid = false;
    try {
      valid = contracts.MainToHelperSchema.safeParse(JSON.parse(line)).success;
    } catch {
      valid = false;
    }
    if (contracts.utf8ByteLength(line) > contracts.HELPER_MAX_LINE_BYTES) valid = false;
    cases.push({ name, line, valid });
  };
  const mutate = (name, fn) => {
    const m = clone();
    fn(m);
    add(name, m);
  };
  add('configure: full generated (ko)', configures.ko);
  add('configure: base', base);
  mutate('configure: v as 1.0 is the same number', (m) => (m.v = 1.0));
  mutate('configure: unknown top-level field', (m) => (m.extra = 1));
  mutate('configure: unknown geometry field', (m) => (m.geometry.extra = 1));
  mutate('configure: unknown tokens field', (m) => (m.tokens.extra = '#FFFFFF'));
  mutate('configure: unknown strings field', (m) => (m.strings.extra = 'x'));
  mutate('configure: unknown modifiers field', (m) => (m.modifiers.extra = ['shift']));
  mutate('configure: unknown sector field', (m) => (m.menus[0].convert[0].extra = true));
  mutate('configure: unknown menu field', (m) => (m.menus[0].extra = []));
  mutate('configure: enabled wrong type', (m) => (m.enabled = 'yes'));
  mutate('configure: enabled number', (m) => (m.enabled = 1));
  mutate('configure: enabled null', (m) => (m.enabled = null));
  mutate('configure: missing enabled', (m) => delete m.enabled);
  mutate('configure: missing strings', (m) => delete m.strings);
  mutate('configure: missing menus', (m) => delete m.menus);
  mutate('configure: locale ja', (m) => (m.locale = 'ja'));
  mutate('configure: diameter too large', (m) => (m.geometry.diameter = 601));
  mutate('configure: diameter at max', (m) => (m.geometry.diameter = 600));
  mutate('configure: diameter at min', (m) => (m.geometry.diameter = 200));
  mutate('configure: diameter string', (m) => (m.geometry.diameter = '360'));
  mutate('configure: innerRadiusRatio below min', (m) => (m.geometry.innerRadiusRatio = 0.1));
  mutate('configure: startAngleDeg fractional', (m) => (m.geometry.startAngleDeg = -89.5));
  mutate('configure: startAngleDeg below min', (m) => (m.geometry.startAngleDeg = -361));
  mutate('configure: armDistance huge exponent', (m) => (m.geometry.armDistance = 1e300));
  mutate('configure: missing geometry field', (m) => delete m.geometry.armDistance);
  mutate('configure: labelWeight fractional', (m) => (m.tokens.labelWeight = 700.5));
  mutate('configure: labelWeight 950', (m) => (m.tokens.labelWeight = 950));
  mutate('configure: labelWeight 100', (m) => (m.tokens.labelWeight = 100));
  mutate('configure: appearMs 0', (m) => (m.tokens.appearMs = 0));
  mutate('configure: color 3 digits', (m) => (m.tokens.sector = '#FFF'));
  mutate('configure: color name', (m) => (m.tokens.sector = 'red'));
  mutate('configure: color lowercase 8', (m) => (m.tokens.sector = '#fce4ccf2'));
  mutate('configure: color 7 digits', (m) => (m.tokens.sector = '#FCE4CCF'));
  mutate('configure: color with space', (m) => (m.tokens.sector = '#FCE4CC '));
  mutate('configure: modifiers duplicate', (m) => (m.modifiers.convert = ['shift', 'shift']));
  mutate('configure: modifiers empty', (m) => (m.modifiers.convert = []));
  mutate('configure: modifiers four', (m) => (m.modifiers.tools = ['shift', 'alt', 'control', 'command']));
  mutate('configure: modifiers three', (m) => (m.modifiers.tools = ['shift', 'alt', 'control']));
  mutate('configure: modifiers unknown key', (m) => (m.modifiers.convert = ['fn']));
  mutate('configure: modifiers not array', (m) => (m.modifiers.convert = 'shift'));
  mutate('configure: extension uppercase key', (m) => (m.extensions['.JPG'] = 'image/jpeg'));
  mutate('configure: extension without dot', (m) => (m.extensions.jpg = 'image/jpeg'));
  mutate('configure: extension too long', (m) => (m.extensions['.abcdefghi'] = 'image/jpeg'));
  mutate('configure: extension 8 chars', (m) => (m.extensions['.abcdefgh'] = 'image/jpeg'));
  mutate('configure: extension unknown key value', (m) => (m.extensions['.svg'] = 'image/svg'));
  mutate('configure: extension value number', (m) => (m.extensions['.png'] = 1));
  mutate('configure: extension maps to images', (m) => (m.extensions['.zzz'] = 'images'));
  mutate('configure: extensions empty', (m) => (m.extensions = {}));
  mutate('configure: extensions array', (m) => (m.extensions = []));
  mutate('configure: menus 33', (m) => (m.menus = Array.from({ length: 33 }, () => ({ key: 'pdf', convert: [], tools: [] }))));
  mutate('configure: menus 32', (m) => (m.menus = Array.from({ length: 32 }, () => ({ key: 'pdf', convert: [], tools: [] }))));
  mutate('configure: menus empty', (m) => (m.menus = []));
  mutate('configure: menu key unknown', (m) => (m.menus[0].key = 'image/svg'));
  mutate('configure: sectors 13', (m) => (m.menus[0].convert = Array.from({ length: 13 }, () => m.menus[0].convert[0])));
  mutate('configure: sectors 12', (m) => (m.menus[0].convert = Array.from({ length: 12 }, () => m.menus[0].convert[0])));
  mutate('configure: sector label empty', (m) => (m.menus[0].convert[0].label = ''));
  mutate('configure: sector label 32', (m) => (m.menus[0].convert[0].label = 'X'.repeat(32)));
  mutate('configure: sector label 33', (m) => (m.menus[0].convert[0].label = 'X'.repeat(33)));
  mutate('configure: sector label 32 utf16 units with emoji', (m) => (m.menus[0].convert[0].label = '😀'.repeat(16)));
  mutate('configure: sector label 34 utf16 units with emoji', (m) => (m.menus[0].convert[0].label = '😀'.repeat(17)));
  mutate('configure: sector label hangul 32', (m) => (m.menus[0].convert[0].label = '가'.repeat(32)));
  mutate('configure: sector label 32 emoji (64 utf16 units)', (m) => (m.menus[0].convert[0].label = '😀'.repeat(32)));
  mutate('configure: sector label 33 emoji', (m) => (m.menus[0].convert[0].label = '😀'.repeat(33)));
  mutate('configure: sector label 16 flags (32 code points)', (m) => (m.menus[0].convert[0].label = '🇰🇷'.repeat(16)));
  mutate('configure: sector label 17 flags (34 code points)', (m) => (m.menus[0].convert[0].label = '🇰🇷'.repeat(17)));
  mutate('configure: sector label combining marks 33 code points', (m) => (m.menus[0].convert[0].label = 'e\u0301'.repeat(16) + 'x'));
  mutate('configure: dropHint 60 emoji', (m) => (m.strings.dropHint = '😀'.repeat(60)));
  mutate('configure: dropHint 61 emoji', (m) => (m.strings.dropHint = '😀'.repeat(61)));
  mutate('configure: sector icon missing', (m) => delete m.menus[0].convert[0].icon);
  mutate('configure: sector icon unknown', (m) => (m.menus[0].convert[0].icon = 'star'));
  mutate('configure: sector icon valid', (m) => (m.menus[0].convert[0].icon = 'crop'));
  mutate('configure: sector reason null', (m) => (m.menus[0].convert[0].reason = null));
  mutate('configure: sector reason 120', (m) => (m.menus[0].convert[0].reason = 'r'.repeat(120)));
  mutate('configure: sector reason 121', (m) => (m.menus[0].convert[0].reason = 'r'.repeat(121)));
  mutate('configure: sector reason absent', (m) => delete m.menus[0].convert[0].reason);
  mutate('configure: sector actionId convert.gif', (m) => (m.menus[0].convert[0].actionId = 'convert.gif'));
  mutate('configure: sector actionId tool.unknown', (m) => (m.menus[0].convert[0].actionId = 'tool.unknown'));
  mutate('configure: sector actionId tool.crop in convert list', (m) => (m.menus[0].convert[0].actionId = 'tool.crop'));
  mutate('configure: sector enabled string', (m) => (m.menus[0].convert[0].enabled = 'true'));
  mutate('configure: sector batch missing', (m) => delete m.menus[0].convert[0].batch);
  mutate('configure: dropHint 60', (m) => (m.strings.dropHint = 'h'.repeat(60)));
  mutate('configure: dropHint 61', (m) => (m.strings.dropHint = 'h'.repeat(61)));
  mutate('configure: fileCount empty', (m) => (m.strings.fileCount = ''));
  mutate('configure: optional unsupported strings absent', (m) => {
    delete m.strings.unsupportedFolder;
    delete m.strings.unsupportedNonFile;
    delete m.strings.unsupportedVirtual;
  });
  mutate('configure: unsupportedFolder 60', (m) => (m.strings.unsupportedFolder = 'f'.repeat(60)));
  mutate('configure: unsupportedFolder 61', (m) => (m.strings.unsupportedFolder = 'f'.repeat(61)));
  mutate('configure: unsupportedNonFile null', (m) => (m.strings.unsupportedNonFile = null));
  mutate('configure: unsupportedVirtual number', (m) => (m.strings.unsupportedVirtual = 1));
  mutate('configure: unsupportedVirtual empty', (m) => (m.strings.unsupportedVirtual = ''));
  mutate('configure: unknown unsupported string key', (m) => (m.strings.unsupportedOther = 'x'));
  mutate('configure: v 2', (m) => (m.v = 2));
  mutate('configure: v string', (m) => (m.v = '1'));
  mutate('configure: v missing', (m) => delete m.v);
  mutate('configure: type missing', (m) => delete m.type);
  mutate('configure: type wrong case', (m) => (m.type = 'Configure'));
  add('ping: valid', { v: 1, type: 'ping', nonce: 42 });
  add('ping: zero', { v: 1, type: 'ping', nonce: 0 });
  add('ping: max safe integer', { v: 1, type: 'ping', nonce: 9007199254740991 });
  add('ping: above max safe integer', { v: 1, type: 'ping', nonce: 9007199254740992 });
  add('ping: negative', { v: 1, type: 'ping', nonce: -1 });
  add('ping: fractional', { v: 1, type: 'ping', nonce: 1.5 });
  add('ping: string nonce', { v: 1, type: 'ping', nonce: '1' });
  add('ping: missing nonce', { v: 1, type: 'ping' });
  add('ping: extra field', { v: 1, type: 'ping', nonce: 1, extra: 0 });
  add('ping: exponent notation integer', '{"v":1,"type":"ping","nonce":1e3}');
  add('ping: float notation integer', '{"v":1,"type":"ping","nonce":7.0}');
  add('shutdown: valid', { v: 1, type: 'shutdown' });
  add('shutdown: extra field', { v: 1, type: 'shutdown', now: true });
  add('queryPermissions: valid', { v: 1, type: 'queryPermissions' });
  add('cancelSession: valid', { v: 1, type: 'cancelSession', sessionId: 'm123-4-abc_DEF' });
  add('cancelSession: 64 chars', { v: 1, type: 'cancelSession', sessionId: 'a'.repeat(64) });
  add('cancelSession: 65 chars', { v: 1, type: 'cancelSession', sessionId: 'a'.repeat(65) });
  add('cancelSession: empty', { v: 1, type: 'cancelSession', sessionId: '' });
  add('cancelSession: space', { v: 1, type: 'cancelSession', sessionId: 'a b' });
  add('cancelSession: unicode', { v: 1, type: 'cancelSession', sessionId: 'é' });
  add('cancelSession: missing id', { v: 1, type: 'cancelSession' });
  add('unknown type', { v: 1, type: 'hello' });
  add('helper message type sent to helper', { v: 1, type: 'pong', nonce: 1 });
  add('top-level array', '[1,2]');
  add('top-level null', 'null');
  add('top-level string', '"configure"');
  add('top-level number', '1');
  add('truncated json', '{"v":1,"type":"ping","nonce":1');
  add('trailing garbage', '{"v":1,"type":"ping","nonce":1} x');
  add('trailing whitespace', '{"v":1,"type":"ping","nonce":1}  \r');
  add('leading whitespace', '   {"v":1,"type":"shutdown"}');
  add('single quotes', "{'v':1,'type':'shutdown'}");
  add('comment', '{"v":1,"type":"shutdown"} // bye');
  add('NaN literal', '{"v":1,"type":"ping","nonce":NaN}');
  add('type null', '{"v":1,"type":null}');
  add('type number', '{"v":1,"type":5}');
  add('duplicate key, last wins in JSON.parse', '{"v":1,"type":"ping","nonce":-1,"nonce":5}');
  add('unknown nested array field', '{"v":1,"type":"queryPermissions","x":' + '['.repeat(50) + ']'.repeat(50) + '}');
  add('unicode escape in id', '{"v":1,"type":"cancelSession","sessionId":"\\u0061bc"}');
  // (Oversized lines are built by the Swift tests themselves to keep this file small.)
  write('protocol-cases.json', { $comment: 'Lines main could send; valid = MainToHelperSchema.safeParse(JSON.parse(line)).success (and within HELPER_MAX_LINE_BYTES).', cases });
}
