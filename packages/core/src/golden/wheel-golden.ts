import { DEFAULT_WHEEL_GEOMETRY, type Point, type Rect, type WheelGeometry, type WheelHit, type WheelSector } from '@orbitdrop/contracts';
import { adjustMenuForFileCount, buildCapabilitySnapshot, buildWheelMenu, helperExtensionMap } from '../capabilities';
import {
  appKitPointToGlobal,
  appKitRectToGlobal,
  clampRectIntoArea,
  dipToPhysicalPoint,
  dipToPhysicalRect,
  displayIndexAtPoint,
  displaysFromAppKitScreens,
  displaysFromWin32Monitors,
  fitRectIntoArea,
  physicalToDipPoint,
  roundHalfUp,
  roundRect,
  virtualScreenBounds,
  type AppKitScreen,
  type Win32Monitor,
} from '../coords';
import {
  hitTestFromAppKit,
  hitTestFromPhysical,
  hitTestWheel,
  innerRadius,
  isArmed,
  normalizeDeg,
  outerRadius,
  placeWheel,
  placeWheelFromAppKit,
  placeWheelFromPhysical,
  sectorCenterDeg,
  sectorOuterRadius,
  sectorStartDeg,
} from '../geometry';
import { menuKeyForPaths } from '../selection';
import { PROBE_DARWIN_ARM64, PROBE_DARWIN_ARM64_IMAGEIO, PROBE_DARWIN_NO_PDFJS } from './probes';

/**
 * Generator of tests/fixtures/wheel-golden.json — golden vectors computed with
 * the TypeScript reference implementation, consumed by the Swift (native/macos)
 * and C++ (native/windows) unit tests. Run `node scripts/gen-golden.mjs` after
 * changing geometry, coordinates or selection rules; packages/core/test/golden
 * fails when the committed file drifts.
 */

export const GOLDEN_FORMAT_VERSION = 1;
export const GOLDEN_RELATIVE_PATH = 'tests/fixtures/wheel-golden.json';

/** Hit-test points keep at least this distance from every radius limit and sector boundary. */
export const MIN_MARGIN_DIP = 0.01;
export const MIN_MARGIN_DEG = 0.01;
/** Coordinates in the golden file are rounded to 4 decimals (exact decimal → identical double in every parser). */
const DECIMALS = 1e4;
const RADIAL_OFFSET = 0.05;
const BOUNDARY_OFFSET_DEG = 0.05;
const HIT_DIAMETERS = [240, 320, 360, 380] as const;
const EMPHASIZED_COUNTS = new Set([4, 7, 8, 9]);
const MULTI_FILE_REASON = 'Single file only';

const G = DEFAULT_WHEEL_GEOMETRY;

function round4(value: number): number {
  const r = Math.round(value * DECIMALS) / DECIMALS;
  return Object.is(r, -0) ? 0 : r;
}

function polar(r: number, deg: number): { dx: number; dy: number } {
  const rad = (deg * Math.PI) / 180;
  return { dx: round4(r * Math.cos(rad)), dy: round4(r * Math.sin(rad)) };
}

function degOf(dx: number, dy: number): number {
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** Angular distance (≥ 0, degrees) from `deg` to the nearest sector boundary; Infinity for fewer than 2 sectors. */
export function boundaryMarginDeg(deg: number, sectorCount: number, g: WheelGeometry = G): number {
  if (sectorCount < 2) return Number.POSITIVE_INFINITY;
  const span = 360 / sectorCount;
  const m = normalizeDeg(deg - g.startAngleDeg + span / 2) % span;
  return Math.min(m, span - m);
}

/**
 * Throws unless the point is safely away from the dead-zone radius, the outer
 * radius and (inside the ring) every sector boundary, both in degrees and in
 * DIP perpendicular to the boundary ray.
 */
export function assertRobustHitPoint(dx: number, dy: number, sectorCount: number, diameter: number, g: WheelGeometry = G): void {
  const r = Math.hypot(dx, dy);
  const ri = innerRadius(diameter, g);
  const ro = outerRadius(diameter);
  if (Math.abs(r - ri) < MIN_MARGIN_DIP || Math.abs(r - ro) < MIN_MARGIN_DIP) {
    throw new Error(`hit point (${dx}, ${dy}) is within ${MIN_MARGIN_DIP} DIP of a radius limit (n=${sectorCount}, d=${diameter})`);
  }
  if (r > ri && r <= ro) {
    const margin = boundaryMarginDeg(degOf(dx, dy), sectorCount, g);
    if (margin < MIN_MARGIN_DEG || r * Math.sin(Math.min(margin, 90) * (Math.PI / 180)) < MIN_MARGIN_DIP) {
      throw new Error(`hit point (${dx}, ${dy}) is too close to a sector boundary (n=${sectorCount}, d=${diameter})`);
    }
  }
}

function sameHit(a: WheelHit, b: WheelHit): boolean {
  return a.zone === b.zone && (a.zone !== 'sector' || (b.zone === 'sector' && a.index === b.index));
}

function hitFields(hit: WheelHit): { zone: WheelHit['zone']; index?: number } {
  return hit.zone === 'sector' ? { zone: 'sector', index: hit.index } : { zone: hit.zone };
}

// ------------------------------------------------------------------ hit-test

export interface HitCase {
  readonly n: number;
  readonly d: number;
  readonly dx: number;
  readonly dy: number;
  readonly zone: WheelHit['zone'];
  readonly index?: number;
  readonly kind: string;
}

/** Nudge an angle until it is ≥ 0.5° from every boundary (radial test points must not depend on boundaries). */
function radialAngle(start: number, sectorCount: number): number {
  let a = start;
  while (boundaryMarginDeg(a, sectorCount) < 0.5) a += 0.37;
  return a;
}

function hitCases(): HitCase[] {
  const cases: HitCase[] = [];
  for (const d of HIT_DIAMETERS) {
    for (let n = 0; n <= 12; n += 1) {
      const ri = innerRadius(d, G);
      const ro = outerRadius(d);
      const rMid = (ri + ro) / 2;
      const push = (kind: string, p: { dx: number; dy: number }, intended?: WheelHit): void => {
        assertRobustHitPoint(p.dx, p.dy, n, d);
        const hit = hitTestWheel(p.dx, p.dy, n, d, G);
        if (intended !== undefined && !sameHit(hit, intended)) {
          throw new Error(`golden generator: ${kind} (${p.dx}, ${p.dy}) n=${n} d=${d} gave ${JSON.stringify(hit)}, expected ${JSON.stringify(intended)}`);
        }
        cases.push({ n, d, dx: p.dx, dy: p.dy, ...hitFields(hit), kind });
      };
      push('center', { dx: 0, dy: 0 }, { zone: 'center' });
      for (const start of [17, 233]) {
        const a = radialAngle(start, n);
        push('deadZoneEdge', polar(ri - RADIAL_OFFSET, a), { zone: 'center' });
        push('ringInnerEdge', polar(ri + RADIAL_OFFSET, a), n === 0 ? { zone: 'outside' } : undefined);
        push('ringOuterEdge', polar(ro - RADIAL_OFFSET, a), n === 0 ? { zone: 'outside' } : undefined);
        push('outsideEdge', polar(ro + RADIAL_OFFSET, a), { zone: 'outside' });
      }
      push('far', polar(ro * 2, 300), { zone: 'outside' });
      push('far', { dx: 1000000, dy: -1000000 }, { zone: 'outside' });
      if (n === 0) continue;
      const radii = EMPHASIZED_COUNTS.has(n) ? [ri + RADIAL_OFFSET, rMid, ro - RADIAL_OFFSET] : [rMid];
      for (let i = 0; i < n; i += 1) {
        for (const r of radii) push('sectorCenter', polar(r, sectorCenterDeg(i, n, G)), { zone: 'sector', index: i });
      }
      for (let k = 0; k < n; k += 1) {
        const boundary = sectorStartDeg(k, n, G);
        for (const r of radii) {
          push('boundaryAfter', polar(r, boundary + BOUNDARY_OFFSET_DEG), { zone: 'sector', index: k });
          push('boundaryBefore', polar(r, boundary - BOUNDARY_OFFSET_DEG), { zone: 'sector', index: (k - 1 + n) % n });
        }
      }
    }
  }
  return cases;
}

/** Non-finite inputs (encoded as strings: JSON has no NaN/Infinity) are never inside the wheel. */
function hitNonFiniteCases() {
  const values: [number | string, number | string][] = [
    ['NaN', 0],
    [0, 'NaN'],
    ['Infinity', 0],
    [0, '-Infinity'],
    ['-Infinity', 'Infinity'],
  ];
  const decode = (v: number | string): number => (typeof v === 'number' ? v : Number(v.replace(/^\+/, '')));
  return values.map(([dx, dy]) => {
    const hit = hitTestWheel(decode(dx), decode(dy), 8, 360, G);
    if (hit.zone !== 'outside') throw new Error('non-finite hit must be outside');
    return { n: 8, d: 360, dx, dy, ...hitFields(hit), kind: 'nonFinite' };
  });
}

// ------------------------------------------------------------------ placement

const WORK_AREAS: readonly { readonly name: string; readonly workArea: Rect }[] = [
  { name: 'win-1080p-taskbar', workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { name: 'mac-laptop-menubar-dock', workArea: { x: 0, y: 37, width: 1512, height: 885 } },
  { name: 'secondary-left-negative', workArea: { x: -2560, y: -200, width: 2560, height: 1400 } },
  { name: 'secondary-above-negative', workArea: { x: -280, y: -1415, width: 2560, height: 1415 } },
  { name: 'win-125pct-fractional', workArea: { x: -1536, y: 0, width: 1536, height: 825.6 } },
  { name: 'tiny-300', workArea: { x: 100, y: 100, width: 300, height: 300 } },
  { name: 'tiny-200-negative', workArea: { x: -250, y: -250, width: 200, height: 200 } },
  { name: 'wide-short', workArea: { x: 0, y: 0, width: 1000, height: 250 } },
  { name: 'tall-narrow', workArea: { x: 500, y: -500, width: 250, height: 1000 } },
  { name: 'exact-fit-376', workArea: { x: 10, y: 20, width: 376, height: 376 } },
];

function activationPoints(wa: Rect, diameter: number): { name: string; point: Point }[] {
  const cx = wa.x + wa.width / 2;
  const cy = wa.y + wa.height / 2;
  const right = wa.x + wa.width;
  const bottom = wa.y + wa.height;
  const limit = wa.x + diameter / 2 + G.edgePadding;
  return [
    { name: 'center', point: { x: cx, y: cy } },
    { name: 'nearLeft', point: { x: wa.x + 3, y: cy } },
    { name: 'nearRight', point: { x: right - 3, y: cy } },
    { name: 'nearTop', point: { x: cx, y: wa.y + 3 } },
    { name: 'nearBottom', point: { x: cx, y: bottom - 3 } },
    { name: 'topLeft', point: { x: wa.x + 3, y: wa.y + 3 } },
    { name: 'topRight', point: { x: right - 3, y: wa.y + 3 } },
    { name: 'bottomLeft', point: { x: wa.x + 3, y: bottom - 3 } },
    { name: 'bottomRight', point: { x: right - 3, y: bottom - 3 } },
    { name: 'aboveWorkArea', point: { x: cx, y: wa.y - 12 } },
    { name: 'belowWorkArea', point: { x: cx, y: bottom + 20 } },
    { name: 'farLeft', point: { x: wa.x - 400, y: cy } },
    { name: 'atLeftLimit', point: { x: limit, y: cy } },
    { name: 'insideLeftLimit', point: { x: limit + 0.5, y: cy + 0.25 } },
  ];
}

function placementCases() {
  const cases: unknown[] = [];
  const add = (workAreaName: string, wa: Rect, diameter: number, pointName: string, activation: Point): void => {
    const g = { ...G, diameter };
    const p = placeWheel(activation, wa, g);
    cases.push({
      workAreaName,
      point: pointName,
      diameter,
      activation,
      workArea: wa,
      expect: { center: p.center, diameter: p.diameter, windowFrame: p.windowFrame, shifted: p.shifted },
    });
  };
  for (const { name, workArea } of WORK_AREAS) {
    for (const { name: pointName, point } of activationPoints(workArea, 360)) add(name, workArea, 360, pointName, point);
    for (const diameter of [320, 380]) {
      for (const { name: pointName, point } of activationPoints(workArea, diameter)) {
        if (['center', 'topLeft', 'bottomRight', 'belowWorkArea', 'atLeftLimit'].includes(pointName)) add(name, workArea, diameter, pointName, point);
      }
    }
    // Configured diameter below minDiameter (allowed by the geometry schema) and a very large one.
    for (const diameter of [200, 600]) {
      const center = activationPoints(workArea, diameter)[0]!;
      add(name, workArea, diameter, center.name, center.point);
    }
  }
  return cases;
}

// ------------------------------------------------------------------ arming

function armingCases() {
  const cases: unknown[] = [];
  const activation = { x: 812.5, y: -340.25 };
  const add = (armDistance: number, distance: number, angle: number, passedCenter: boolean): void => {
    const rad = (angle * Math.PI) / 180;
    const pointer = { x: round4(activation.x + distance * Math.cos(rad)), y: round4(activation.y + distance * Math.sin(rad)) };
    const actual = Math.hypot(pointer.x - activation.x, pointer.y - activation.y);
    if (distance !== 0 && Math.abs(actual - armDistance) < MIN_MARGIN_DIP) throw new Error('arming case too close to armDistance');
    const g = { ...G, armDistance };
    cases.push({ armDistance, activation, pointer, passedCenter, expect: isArmed(activation, pointer, passedCenter, g) });
  };
  for (const angle of [0, 37, 145, 270]) {
    for (const distance of [0, 2, 5.95, 6.05, 40]) add(G.armDistance, distance, angle, false);
  }
  add(G.armDistance, 0, 0, true);
  add(G.armDistance, 2, 90, true);
  add(0, 0, 0, false);
  add(12, 11.95, 200, false);
  add(12, 12.05, 200, false);
  return cases;
}

// ------------------------------------------------------------------ selection

const NFD_KOREAN = '\u1109\u1161\u110c\u1175\u11ab'; // 사진 decomposed into jamo

const SELECTION_CASES: readonly { readonly map: string; readonly paths: readonly string[]; readonly note: string }[] = [
  { map: 'darwin', paths: ['/Users/me/Desktop/Page 001.pdf'], note: 'single PDF' },
  { map: 'darwin', paths: ['/Users/me/photo.JPG'], note: 'upper-case extension' },
  { map: 'darwin', paths: ['/a/b.jpeg', '/a/c.jpg', '/a/d.JFIF', '/a/e.jpe'], note: 'all JPEG spellings, one format' },
  { map: 'darwin', paths: ['/a/b.jpg', '/a/c.png'], note: 'two image formats' },
  { map: 'darwin', paths: ['/a/b.pdf', '/a/c.png'], note: 'PDF + image' },
  { map: 'darwin', paths: ['/a/b.pdf', '/a/c.PDF'], note: 'several PDFs' },
  { map: 'darwin', paths: ['/a/x.gif', '/a/y.png', '/a/z.pdf'], note: 'PDF + two image formats' },
  { map: 'darwin', paths: ['/a/x.tiff', '/a/y.tif'], note: 'TIFF spellings' },
  { map: 'darwin', paths: ['/a/x.bmp', '/a/y.dib'], note: 'BMP spellings' },
  { map: 'darwin', paths: ['/a/x.avif'], note: 'AVIF' },
  { map: 'darwin', paths: ['/a/b.heic'], note: 'HEIC without a decoder' },
  { map: 'darwinImageIO', paths: ['/a/b.heic', '/a/c.HEIF', '/a/d.hif'], note: 'HEIC with the ImageIO helper' },
  { map: 'darwinImageIO', paths: ['/a/b.heic', '/a/c.jpg'], note: 'HEIC + JPEG' },
  { map: 'darwin', paths: ['/a/notes.txt'], note: 'unsupported extension' },
  { map: 'darwin', paths: ['/a/b.png', '/a/notes.txt'], note: 'one unsupported file makes the selection unsupported' },
  { map: 'darwin', paths: ['/a/report.docx'], note: 'output-only format' },
  { map: 'darwin', paths: [], note: 'no paths' },
  { map: 'darwin', paths: ['/a/b.pdf', ''], note: 'an empty path' },
  { map: 'darwin', paths: ['/a/folder.png/'], note: 'trailing separator = folder' },
  { map: 'darwin', paths: ['C:\\Users\\me\\Pictures\\Album.jpg\\'], note: 'trailing backslash = folder' },
  { map: 'darwin', paths: ['/a/.png'], note: 'leading dot only: hidden file without extension' },
  { map: 'darwin', paths: ['/a/photo.'], note: 'trailing dot: no extension' },
  { map: 'darwin', paths: ['/a/no_extension'], note: 'no extension' },
  { map: 'darwin', paths: ['/a.dir/file'], note: 'dot only in a parent folder' },
  { map: 'darwin', paths: ['/a/archive.tar.png'], note: 'last dot wins' },
  { map: 'darwin', paths: ['/a/x.jpg '], note: 'trailing space is part of the extension' },
  { map: 'darwin', paths: ['/a/x.jp g'], note: 'space inside the extension' },
  { map: 'darwin', paths: ['/a/x.\uff2a\uff30\uff27'], note: 'full-width letters are not lower-cased (ASCII only)' },
  { map: 'darwin', paths: ['C:\\Users\\me\\Pictures\\Photo.PNG'], note: 'Windows path' },
  { map: 'darwin', paths: ['\\\\server\\share\\scan.pdf'], note: 'UNC path' },
  { map: 'darwin', paths: ['C:/Users/me\\mixed.webp'], note: 'mixed separators' },
  { map: 'darwin', paths: ['/Users/me/odd\\.png'], note: "'\\' separates on every platform: the name is '.png' (no extension)" },
  { map: 'darwin', paths: ['/Users/me/사진 001.jpg'], note: 'Korean NFC name' },
  { map: 'darwin', paths: [`/Users/me/${NFD_KOREAN}.jpg`], note: 'Korean NFD name' },
  { map: 'darwin', paths: ['/Users/me/🍊 orange.webp'], note: 'emoji name' },
  { map: 'darwin', paths: ['/Users/me/x.Jpg', '/Users/me/y.jPeG'], note: 'mixed case' },
  { map: 'darwin', paths: ['/Users/me/Cafe\u0301.png'], note: 'combining mark in the base name' },
  { map: 'darwin', paths: ['/Users/me/x.png\u0301'], note: 'combining mark after the extension: no match (code units, no normalization)' },
  { map: 'darwin', paths: ['/Users/me/x.png.\u0301'], note: 'combining mark on the last dot: that dot still starts the extension' },
  { map: 'noPdf', paths: ['/a/x.pdf'], note: 'PDF.js unavailable: PDFs are unsupported' },
  { map: 'noPdf', paths: ['/a/x.pdf', '/a/y.jpg'], note: 'PDF.js unavailable: mixed selection unsupported' },
  { map: 'noPdf', paths: ['/a/y.jpg'], note: 'PDF.js unavailable: images still work' },
];

function selectionSection() {
  const maps = {
    darwin: helperExtensionMap(buildCapabilitySnapshot(PROBE_DARWIN_ARM64)),
    darwinImageIO: helperExtensionMap(buildCapabilitySnapshot(PROBE_DARWIN_ARM64_IMAGEIO)),
    noPdf: helperExtensionMap(buildCapabilitySnapshot(PROBE_DARWIN_NO_PDFJS)),
  } as const;
  return {
    extensionMaps: maps,
    cases: SELECTION_CASES.map((c) => ({ map: c.map, paths: c.paths, expect: menuKeyForPaths(c.paths, maps[c.map as keyof typeof maps]), note: c.note })),
  };
}

// ------------------------------------------------------------------ file count

function sectorInput(s: WheelSector) {
  return { actionId: s.actionId, enabled: s.enabled, batch: s.batch, ...(s.reason === undefined ? {} : { reason: s.reason }) };
}

function sectorOutput(s: WheelSector) {
  return { actionId: s.actionId, enabled: s.enabled, ...(s.reason === undefined ? {} : { reason: s.reason }) };
}

function fileCountSection() {
  const snapshot = buildCapabilitySnapshot(PROBE_DARWIN_ARM64);
  const cases: unknown[] = [];
  const add = (name: string, sectors: readonly WheelSector[], fileCount: number): void => {
    const menu = { key: 'images' as const, mode: 'tools' as const, sectors };
    cases.push({
      name,
      fileCount,
      sectors: sectors.map(sectorInput),
      expect: adjustMenuForFileCount(menu, fileCount, MULTI_FILE_REASON).sectors.map(sectorOutput),
    });
  };
  const menus = [
    ['image/jpeg tools', buildWheelMenu(snapshot, 'image/jpeg', 'tools', 'en')],
    ['image/jpeg convert', buildWheelMenu(snapshot, 'image/jpeg', 'convert', 'en')],
    ['images tools', buildWheelMenu(snapshot, 'images', 'tools', 'en')],
    ['pdf convert', buildWheelMenu(snapshot, 'pdf', 'convert', 'en')],
    ['mixed convert', buildWheelMenu(snapshot, 'mixed', 'convert', 'en')],
  ] as const;
  for (const [name, menu] of menus) {
    for (const fileCount of name === 'image/jpeg tools' ? [0, 1, 2, 200] : [2]) add(name, menu.sectors, fileCount);
  }
  const handmade: WheelSector[] = [
    { actionId: 'tool.crop', label: 'CROP', icon: 'crop', enabled: false, reason: 'Drawing engine unavailable', batch: false },
    { actionId: 'tool.compress', label: 'COMPRESS', icon: 'compress', enabled: true, batch: true },
    { actionId: 'tool.edit', label: 'EDIT', icon: 'edit', enabled: true, batch: false },
    { actionId: 'tool.metadata', label: 'METADATA', icon: 'metadata', enabled: false, reason: 'No PNG encoder in this build', batch: true },
  ];
  add('already disabled sectors keep their reason', handmade, 3);
  add('already disabled sectors keep their reason', handmade, 1);
  return { multiFileReason: MULTI_FILE_REASON, cases };
}

// ------------------------------------------------------------------ coordinates

interface MacLayout {
  readonly name: string;
  readonly screens: readonly AppKitScreen[];
  readonly points: readonly Point[];
  readonly rects: readonly Rect[];
  readonly activations: readonly Point[];
}

const MAC_LAYOUTS: readonly MacLayout[] = [
  {
    name: 'laptop-only',
    screens: [{ frame: { x: 0, y: 0, width: 1512, height: 982 }, visibleFrame: { x: 0, y: 60, width: 1512, height: 885 }, backingScaleFactor: 2 }],
    points: [
      { x: 756, y: 491 },
      { x: 0, y: 982 },
      { x: 1511.5, y: 0.5 },
      { x: 100, y: 0 },
      { x: -10, y: 500 },
    ],
    rects: [
      { x: 100, y: 200, width: 400, height: 300 },
      { x: 0, y: 945, width: 1512, height: 37 },
    ],
    activations: [
      { x: 756, y: 491 },
      { x: 1500, y: 975 },
      { x: 5, y: 10 },
    ],
  },
  {
    name: 'external-above',
    screens: [
      { frame: { x: 0, y: 0, width: 1512, height: 982 }, visibleFrame: { x: 0, y: 0, width: 1512, height: 945 }, backingScaleFactor: 2 },
      { frame: { x: -524, y: 982, width: 2560, height: 1440 }, visibleFrame: { x: -524, y: 982, width: 2560, height: 1415 }, backingScaleFactor: 1 },
    ],
    points: [
      { x: 700, y: 400 },
      { x: 700, y: 982 },
      { x: 700, y: 981.5 },
      { x: -500, y: 2400 },
      { x: 2035.5, y: 2421.5 },
      { x: 1600, y: 500 },
    ],
    rects: [{ x: -100, y: 1500, width: 408, height: 408 }],
    activations: [
      { x: 700, y: 990 },
      { x: -520, y: 2420 },
      { x: 1508, y: 4 },
    ],
  },
  {
    name: 'external-left-lower',
    screens: [
      { frame: { x: 0, y: 0, width: 1440, height: 900 }, visibleFrame: { x: 0, y: 0, width: 1440, height: 875 }, backingScaleFactor: 2 },
      { frame: { x: -1920, y: -400, width: 1920, height: 1080 }, visibleFrame: { x: -1920, y: -400, width: 1920, height: 1055 }, backingScaleFactor: 1 },
    ],
    points: [
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { x: -960, y: -399.5 },
      { x: -960, y: 679.5 },
      { x: -100, y: 800 },
    ],
    rects: [{ x: -300, y: 100, width: 600, height: 400 }],
    activations: [
      { x: -2, y: 300 },
      { x: -1900, y: -390 },
      { x: 2, y: 300 },
    ],
  },
  {
    name: 'external-primary-laptop-right',
    screens: [
      { frame: { x: 0, y: 0, width: 2560, height: 1440 }, visibleFrame: { x: 0, y: 70, width: 2560, height: 1345 }, backingScaleFactor: 1 },
      { frame: { x: 2560, y: -200, width: 1512, height: 982 }, visibleFrame: { x: 2560, y: -200, width: 1512, height: 945 }, backingScaleFactor: 2 },
    ],
    points: [
      { x: 2560, y: 100 },
      { x: 2559.5, y: 100 },
      { x: 4071.5, y: -199.5 },
      { x: 3000, y: 1000 },
    ],
    rects: [{ x: 2400, y: 0, width: 400, height: 400 }],
    activations: [
      { x: 2565, y: 700 },
      { x: 4070, y: -198 },
      { x: 1280, y: 30 },
    ],
  },
  {
    name: 'diagonal-three',
    screens: [
      { frame: { x: 0, y: 0, width: 1920, height: 1080 }, visibleFrame: { x: 0, y: 0, width: 1920, height: 1055 }, backingScaleFactor: 1 },
      { frame: { x: 1920, y: 1080, width: 1920, height: 1080 }, visibleFrame: { x: 1920, y: 1080, width: 1920, height: 1055 }, backingScaleFactor: 1 },
      { frame: { x: -1280, y: -1024, width: 1280, height: 1024 }, visibleFrame: { x: -1280, y: -1024, width: 1280, height: 999 }, backingScaleFactor: 1 },
    ],
    points: [
      { x: 1920, y: 1080 },
      { x: 2500, y: 500 },
      { x: -10, y: -10 },
      { x: 0, y: -0.5 },
    ],
    rects: [{ x: 1800, y: 1000, width: 300, height: 300 }],
    activations: [
      { x: 1921, y: 1081 },
      { x: 2500, y: 500 },
      { x: -1279, y: -1 },
    ],
  },
];

interface WinLayout {
  readonly name: string;
  readonly monitors: readonly Win32Monitor[];
  readonly physicalPoints: readonly Point[];
  readonly dipPoints: readonly Point[];
  readonly dipRects: readonly Rect[];
  readonly activations: readonly Point[];
}

const WIN_LAYOUTS: readonly WinLayout[] = [
  {
    name: 'single-100',
    monitors: [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, dpi: 96, primary: true }],
    physicalPoints: [
      { x: 0, y: 0 },
      { x: 1919, y: 1079 },
      { x: 1920, y: 500 },
    ],
    dipPoints: [{ x: 960.5, y: 540.25 }],
    dipRects: [{ x: 100.25, y: 100.75, width: 408, height: 408 }],
    activations: [
      { x: 960, y: 540 },
      { x: 1919, y: 1079 },
    ],
  },
  {
    name: 'single-150',
    monitors: [{ bounds: { x: 0, y: 0, width: 2880, height: 1800 }, workArea: { x: 0, y: 0, width: 2880, height: 1728 }, dpi: 144, primary: true }],
    physicalPoints: [
      { x: 1440, y: 900 },
      { x: 2879, y: 1799 },
      { x: 3, y: 7 },
    ],
    dipPoints: [
      { x: 0.5, y: 0.5 },
      { x: 1919.9, y: 1199.9 },
    ],
    dipRects: [{ x: 10.1, y: 20.3, width: 408, height: 408 }],
    activations: [
      { x: 1440, y: 900 },
      { x: 2870, y: 1790 },
      { x: 5, y: 5 },
    ],
  },
  {
    name: 'dual-same-dpi-left',
    monitors: [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, dpi: 96, primary: true },
      { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 }, dpi: 96 },
    ],
    physicalPoints: [
      { x: -1, y: 500 },
      { x: 0, y: 500 },
      { x: -1920, y: 0 },
    ],
    dipPoints: [{ x: -0.5, y: 10 }],
    dipRects: [{ x: -204, y: 300, width: 408, height: 408 }],
    activations: [
      { x: -5, y: 500 },
      { x: 5, y: 500 },
    ],
  },
  {
    name: 'mixed-150-left-of-100-primary',
    monitors: [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, dpi: 96, primary: true },
      { bounds: { x: -3840, y: 0, width: 3840, height: 2160 }, workArea: { x: -3840, y: 0, width: 3840, height: 2088 }, dpi: 144 },
    ],
    physicalPoints: [
      { x: -1, y: 10 },
      { x: -3840, y: 2159 },
      { x: -1920, y: 1080 },
    ],
    dipPoints: [
      { x: -0.25, y: 10 },
      { x: -2560, y: 1391.5 },
    ],
    dipRects: [{ x: -300, y: 200, width: 408, height: 408 }],
    activations: [
      { x: -2, y: 1000 },
      { x: -3838, y: 2150 },
      { x: 2, y: 1000 },
    ],
  },
  {
    name: 'mixed-100-right-of-125-primary-bottom-aligned',
    monitors: [
      { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1380 }, dpi: 120, primary: true },
      { bounds: { x: 2560, y: 360, width: 1920, height: 1080 }, workArea: { x: 2560, y: 360, width: 1920, height: 1040 }, dpi: 96 },
    ],
    physicalPoints: [
      { x: 2560, y: 360 },
      { x: 2559, y: 1439 },
      { x: 3000, y: 100 },
    ],
    dipPoints: [
      { x: 2048, y: 72 },
      { x: 2047.5, y: 1151 },
    ],
    dipRects: [{ x: 1900, y: 500, width: 408, height: 408 }],
    activations: [
      { x: 2562, y: 1400 },
      { x: 4478, y: 362 },
    ],
  },
  {
    name: 'mixed-150-above-200-laptop',
    monitors: [
      { bounds: { x: 0, y: 0, width: 3000, height: 2000 }, workArea: { x: 0, y: 0, width: 3000, height: 1904 }, dpi: 192, primary: true },
      { bounds: { x: -420, y: -2160, width: 3840, height: 2160 }, workArea: { x: -420, y: -2160, width: 3840, height: 2088 }, dpi: 144 },
    ],
    physicalPoints: [
      { x: 0, y: -1 },
      { x: 0, y: 0 },
      { x: -420, y: -2160 },
      { x: 3419, y: -1 },
    ],
    dipPoints: [
      { x: -280, y: -1440 },
      { x: 1499.5, y: -0.5 },
    ],
    dipRects: [{ x: 600, y: -300, width: 408, height: 408 }],
    activations: [
      { x: 1500, y: -3 },
      { x: 1500, y: 3 },
      { x: -419, y: -2159 },
    ],
  },
  {
    name: 'triple-mixed',
    monitors: [
      { bounds: { x: -1920, y: -120, width: 1920, height: 1200 }, workArea: { x: -1920, y: -120, width: 1920, height: 1160 }, dpi: 96 },
      { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1392 }, dpi: 120, primary: true },
      { bounds: { x: 2560, y: -200, width: 3840, height: 2160 }, workArea: { x: 2560, y: -200, width: 3840, height: 2064 }, dpi: 192 },
    ],
    physicalPoints: [
      { x: -1, y: -120 },
      { x: 2560, y: 0 },
      { x: 6399, y: 1959 },
      { x: 100, y: -50 },
    ],
    dipPoints: [
      { x: 2048, y: -100 },
      { x: -0.5, y: -120 },
      { x: 4000, y: 900 },
    ],
    dipRects: [{ x: 1900, y: 300, width: 408, height: 408 }],
    activations: [
      { x: -1915, y: -115 },
      { x: 2562, y: -198 },
      { x: 6390, y: 1850 },
    ],
  },
  {
    name: 'corner-touch',
    monitors: [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, dpi: 96, primary: true },
      { bounds: { x: 1920, y: 1080, width: 1280, height: 1024 }, workArea: { x: 1920, y: 1080, width: 1280, height: 984 }, dpi: 120 },
    ],
    physicalPoints: [
      { x: 1920, y: 1080 },
      { x: 1919, y: 1079 },
      { x: 2500, y: 500 },
    ],
    dipPoints: [{ x: 1920, y: 1080 }],
    dipRects: [{ x: 1800, y: 1000, width: 408, height: 408 }],
    activations: [{ x: 1925, y: 1085 }],
  },
  {
    name: 'gap-fallback',
    monitors: [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, dpi: 96, primary: true },
      { bounds: { x: 2000, y: 0, width: 1920, height: 1080 }, workArea: { x: 2000, y: 0, width: 1920, height: 1032 }, dpi: 144 },
    ],
    physicalPoints: [
      { x: 1950, y: 500 },
      { x: 1970, y: 500 },
      { x: 2000, y: 0 },
    ],
    dipPoints: [
      { x: 1960, y: 10 },
      { x: 2000, y: 10 },
    ],
    dipRects: [{ x: 1900, y: 100, width: 200, height: 200 }],
    activations: [{ x: 3910, y: 10 }],
  },
  {
    name: 'grid-2x2-mixed',
    monitors: [
      { bounds: { x: 1920, y: 1080, width: 1920, height: 1080 }, workArea: { x: 1920, y: 1080, width: 1920, height: 1040 }, dpi: 96 },
      { bounds: { x: 0, y: 1080, width: 1920, height: 1080 }, workArea: { x: 0, y: 1080, width: 1920, height: 1040 }, dpi: 120 },
      { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 }, dpi: 144 },
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, dpi: 96, primary: true },
    ],
    physicalPoints: [
      { x: 1920, y: 1080 },
      { x: 1919, y: 1080 },
      { x: 1920, y: 1079 },
      { x: 3839, y: 2159 },
    ],
    dipPoints: [
      { x: 1930, y: 10 },
      { x: 10, y: 1090 },
      { x: 1930, y: 1090 },
    ],
    dipRects: [{ x: 1700, y: 900, width: 408, height: 408 }],
    activations: [
      { x: 1925, y: 1085 },
      { x: 3835, y: 5 },
    ],
  },
];

/** Robust pointers for a placed wheel: each sector center at mid radius, the center, and outside. */
function wheelPointerOffsets(diameter: number, sectorCount: number): { dx: number; dy: number }[] {
  const ri = innerRadius(diameter, G);
  const ro = outerRadius(diameter);
  const rMid = (ri + ro) / 2;
  const offsets = [{ dx: 0, dy: 0 }];
  for (let i = 0; i < sectorCount; i += 1) {
    const a = (sectorCenterDeg(i, sectorCount, G) * Math.PI) / 180;
    offsets.push({ dx: rMid * Math.cos(a), dy: rMid * Math.sin(a) });
  }
  offsets.push({ dx: ro + 30, dy: 0 });
  return offsets;
}

function macSection() {
  return MAC_LAYOUTS.map((layout) => {
    const primary = layout.screens[0]!.frame;
    const displays = displaysFromAppKitScreens(layout.screens);
    return {
      name: layout.name,
      screens: layout.screens,
      displays: displays.map((d) => ({ bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, primary: d.primary })),
      points: layout.points.map((appKit) => {
        const global = appKitPointToGlobal(appKit, primary);
        return { appKit, global, displayIndex: displayIndexAtPoint(global, displays) };
      }),
      rects: layout.rects.map((appKit) => ({ appKit, global: appKitRectToGlobal(appKit, primary) })),
      wheel: layout.activations.map((activationAppKit) => {
        const placed = placeWheelFromAppKit(activationAppKit, layout.screens, G)!;
        const sectorCount = 8;
        const pointers = wheelPointerOffsets(placed.placement.diameter, sectorCount).map((o) => {
          // Pointer positions in AppKit space (y up), rounded to 0.5 pt like real mouse locations.
          const appKit = {
            x: Math.round((placed.placement.center.x + o.dx + primary.x) * 2) / 2,
            y: Math.round((primary.y + primary.height - (placed.placement.center.y + o.dy)) * 2) / 2,
          };
          return { appKit, sectorCount, ...hitFields(hitTestFromAppKit(appKit, primary, placed.placement, sectorCount, G)) };
        });
        return {
          activationAppKit,
          diameter: G.diameter,
          displayIndex: placed.displayIndex,
          activation: placed.activation,
          center: placed.placement.center,
          placementDiameter: placed.placement.diameter,
          windowFrame: placed.placement.windowFrame,
          windowFrameAppKit: placed.windowFrameAppKit,
          shifted: placed.placement.shifted,
          pointers,
        };
      }),
    };
  });
}

function winSection() {
  return WIN_LAYOUTS.map((layout) => {
    const displays = displaysFromWin32Monitors(layout.monitors);
    return {
      name: layout.name,
      monitors: layout.monitors,
      displays: displays.map((d) => ({ bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, primary: d.primary })),
      virtualScreen: virtualScreenBounds(layout.monitors),
      physicalToDip: layout.physicalPoints.map((physical) => {
        const r = physicalToDipPoint(physical, displays)!;
        return { physical, dip: r.value, displayIndex: r.displayIndex };
      }),
      dipToPhysical: layout.dipPoints.map((dip) => {
        const r = dipToPhysicalPoint(dip, displays)!;
        return { dip, physical: r.value, displayIndex: r.displayIndex };
      }),
      rects: layout.dipRects.map((dip) => {
        const none = dipToPhysicalRect(dip, displays, 'none')!;
        return {
          dip,
          displayIndex: none.displayIndex,
          physical: none.value,
          nearest: dipToPhysicalRect(dip, displays, 'nearest')!.value,
          enclosing: dipToPhysicalRect(dip, displays, 'enclosing')!.value,
        };
      }),
      wheel: layout.activations.map((activationPhysical) => {
        const placed = placeWheelFromPhysical(activationPhysical, displays, G)!;
        const display = displays[placed.displayIndex]!;
        const sectorCount = 7;
        const pointers = wheelPointerOffsets(placed.placement.diameter, sectorCount).map((o) => {
          // Physical pointer positions are integers (POINTL).
          const physical = {
            x: Math.round(placed.centerPhysical.x + o.dx * display.scaleFactor),
            y: Math.round(placed.centerPhysical.y + o.dy * display.scaleFactor),
          };
          return { physical, sectorCount, ...hitFields(hitTestFromPhysical(physical, display, placed.placement, sectorCount, G)) };
        });
        return {
          activationPhysical,
          diameter: G.diameter,
          displayIndex: placed.displayIndex,
          activation: placed.activation,
          center: placed.placement.center,
          placementDiameter: placed.placement.diameter,
          windowFrame: placed.placement.windowFrame,
          windowFramePhysical: placed.windowFramePhysical,
          centerPhysical: placed.centerPhysical,
          shifted: placed.placement.shifted,
          pointers,
        };
      }),
    };
  });
}

const LOOKUP_DISPLAYS: readonly Rect[] = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 1920, y: 0, width: 1280, height: 1024 },
  { x: -1440, y: -900, width: 1440, height: 900 },
];

const LOOKUP_POINTS: readonly { point: Point; note: string }[] = [
  { point: { x: 960, y: 540 }, note: 'inside display 0' },
  { point: { x: 1920, y: 500 }, note: 'shared edge belongs to the right display' },
  { point: { x: 1919.999, y: 500 }, note: 'just left of the shared edge' },
  { point: { x: 3200, y: 100 }, note: 'right edge of the rightmost display (outside, distance 0)' },
  { point: { x: 2500, y: 1050 }, note: 'below the shorter display: nearest' },
  { point: { x: -100, y: -50 }, note: 'inside the negative display' },
  { point: { x: 0, y: -1 }, note: 'on the right edge of the negative display' },
  { point: { x: 1920, y: 1080 }, note: 'bottom-right corner of display 0' },
  { point: { x: -5000, y: 5000 }, note: 'far away' },
  { point: { x: 1920, y: 1050 }, note: 'gap below display 1, equidistant (0) to display 0' },
];

function lookupSection() {
  const cases = LOOKUP_POINTS.map(({ point, note }) => ({
    displays: LOOKUP_DISPLAYS,
    point,
    expect: displayIndexAtPoint(
      point,
      LOOKUP_DISPLAYS.map((bounds) => ({ bounds })),
    ),
    note,
  }));
  const tie: Rect[] = [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 200, y: 0, width: 100, height: 100 },
  ];
  cases.push({
    displays: tie,
    point: { x: 150, y: 50 },
    expect: displayIndexAtPoint(
      { x: 150, y: 50 },
      tie.map((bounds) => ({ bounds })),
    ),
    note: 'equidistant: lower index wins',
  });
  cases.push({ displays: [], point: { x: 0, y: 0 }, expect: displayIndexAtPoint({ x: 0, y: 0 }, []), note: 'no displays' });
  return cases;
}

function clampSection() {
  const area = { x: -1536, y: 0, width: 1536, height: 825.6 };
  const rects: Rect[] = [
    { x: -1600, y: -20, width: 480, height: 360 },
    { x: -100, y: 700, width: 480, height: 360 },
    { x: -1000, y: 300, width: 480, height: 360 },
    { x: -2000, y: -500, width: 2000, height: 1000 },
    { x: 10, y: 10, width: 1536, height: 825.6 },
  ];
  return rects.map((rect) => ({ rect, area, clamp: clampRectIntoArea(rect, area), fit: fitRectIntoArea(rect, area) }));
}

function roundingSection() {
  const values = [-2.5, -1.5, -0.5, -0.4999, 0, 0.4999, 0.5, 1.5, 2.5, 2.4999, -2.5001, 1919.5, -1920.5];
  const rects: Rect[] = [
    { x: 0.5, y: 0.5, width: 10, height: 10 },
    { x: -0.5, y: -1.5, width: 2, height: 3 },
    { x: 1.0000001, y: 2.9999999, width: 3.9999998, height: 1.0000002 },
    { x: 150.29999999999998, y: 10.1, width: 612, height: 612.0000000000001 },
  ];
  return {
    roundHalfUp: values.map((value) => ({ value, expect: roundHalfUp(value) })),
    rects: rects.map((rect) => ({ rect, nearest: roundRect(rect, 'nearest'), enclosing: roundRect(rect, 'enclosing') })),
  };
}

// ------------------------------------------------------------------ document

const COMMENT = [
  'OrbitDrop wheel golden vectors. GENERATED by scripts/gen-golden.mjs from the TypeScript reference',
  '(packages/core/src/{geometry,coords,selection,capabilities}.ts). Do not edit by hand: run `node scripts/gen-golden.mjs`.',
  'packages/core/test/golden.test.ts fails when this file drifts from the reference implementation.',
  'Consumers: native/macos (Swift) and native/windows (C++) unit tests load this file from the repository root',
  '(tests/fixtures/wheel-golden.json), parse it with any JSON parser and run every case of every section.',
  'Sections hold their test cases in "cases"; the reference result of a case is in "expect" (hitTest/coords cases name',
  'their results directly: zone/index, global, dip, physical...). "kind", "point", "name" and "note" are labels for messages.',
  'Space: global DIP, origin top-left of the primary display, x right, y DOWN; angles in degrees, positive = clockwise,',
  "0 deg = right, -90 deg = up (12 o'clock). hitTest dx/dy are pointer minus wheel center in that y-down space: on macOS",
  'negate AppKit dy (or hit-test in a flipped view). Rectangles are {x, y, width, height}, half-open for containment.',
  'Precision: use IEEE-754 double (Swift Double/CGFloat, C++ double). Compare numbers with |a - b| <= tolerance.dip;',
  'booleans, indices, zones and strings exactly. Every hitTest point is >= 0.01 DIP from the dead-zone and outer radius',
  'and >= 0.01 deg and >= 0.01 DIP (perpendicular) from every sector boundary, so float32 or reordered math cannot flip it.',
  'Rounding: roundHalfUp(x) = floor(x + 0.5) (NOT C++ std::round / Swift .rounded()); enclosing pixel rects use',
  'floor(v + 1e-6) for left/top and ceil(v - 1e-6) for right/bottom.',
];

const SCHEMA = {
  formatVersion: ['Integer; bumped on incompatible layout changes of this file.'],
  tolerance: ['{ dip }: absolute tolerance for every non-integer number in expected values.'],
  geometry: ['contracts DEFAULT_WHEEL_GEOMETRY. Cases that override a field say so (placement.diameter, arming.armDistance).'],
  derived: [
    '[{ diameter, outerRadius = d/2, innerRadius = d/2 * innerRadiusRatio, sectorOuterRadius = d/2 - ringInset }].',
    'sectorOuterRadius is for drawing only; hit-testing uses outerRadius.',
  ],
  hitTest: [
    'cases: [{ n: sectorCount, d: diameter, dx, dy, zone: "center" | "outside" | "sector", index (only for "sector"), kind }].',
    'r = hypot(dx, dy); non-finite -> outside; r <= innerRadius -> center; r > d/2 -> outside; n < 1 -> outside;',
    'else n = trunc(n), span = 360/n, rel = normalize(atan2deg(dy, dx) - startAngleDeg + span/2) into [0, 360),',
    'index = min(n - 1, floor(rel / span)). The thin ring (sectorOuterRadius..d/2) and the gaps belong to the sectors.',
  ],
  hitTestNonFinite: ['cases: like hitTest, but dx/dy may be the strings "NaN", "Infinity", "-Infinity" (JSON has no such numbers).'],
  placement: [
    'cases: [{ workAreaName, point, diameter: configured g.diameter (other fields = geometry), activation, workArea,',
    '          expect: { center, diameter, windowFrame, shifted } }].',
    'smallest = min(minDiameter, diameter); D = max(smallest, min(diameter, min(w, h) - 2*edgePadding));',
    'per axis lo = start + D/2 + edgePadding, hi = start + length - D/2 - edgePadding,',
    'center = (lo > hi or activation not finite) ? start + length/2 : clamp(activation, lo, hi);',
    'windowFrame = square of side D + 2*windowMargin centered on center; shifted = (center != activation).',
  ],
  arming: [
    'cases: [{ armDistance (overrides geometry), activation, pointer, passedCenter, expect: boolean }].',
    'armed = passedCenter || hypot(pointer - activation) >= armDistance.',
  ],
  selection: [
    'extensionMaps: { name: { ".ext": "pdf" | "image/<fmt>" } } = the `extensions` field of the helper configure message for a build.',
    'cases: [{ map: name in extensionMaps, paths, expect: MenuKey | null, note }]  (core menuKeyForPaths).',
    'Empty list -> null. Per path: empty, or ending in "/" or "\\" (a folder) -> null; name = text after the last "/" or "\\";',
    'ext = name from its last "." (none when that dot is the first or the last character), lower-cased ASCII only (A-Z);',
    'ext missing from the map (own keys only) or mapped to anything but "pdf" / "image/<fmt>" -> null.',
    'Then: only PDFs -> "pdf"; one image format -> "image/<fmt>"; several image formats -> "images"; PDFs and images -> "mixed".',
    'Work on UTF-16 code units or Unicode scalars: never normalize, never iterate grapheme clusters (Swift: use',
    'path.unicodeScalars or utf16, not Character), compare extensions code unit by code unit.',
  ],
  fileCount: [
    'multiFileReason: string; cases: [{ name, fileCount, sectors: [{ actionId, enabled, batch, reason? }], expect: [{ actionId, enabled, reason? }] }].',
    'fileCount <= 1 -> unchanged; else every enabled sector with batch = false gets enabled = false and reason = multiFileReason;',
    'sectors that are already disabled keep their own reason.',
  ],
  'coords.mac': [
    '[{ name, screens: NSScreen.screens order, screens[0] = primary: [{ frame, visibleFrame, backingScaleFactor }] (AppKit coordinates),',
    '   displays: [{ bounds, workArea, scaleFactor, primary }] (global DIP), points: [{ appKit, global, displayIndex }], rects: [{ appKit, global }],',
    '   wheel: [{ activationAppKit, diameter, displayIndex, activation (global), center, placementDiameter, windowFrame (global),',
    '             windowFrameAppKit, shifted, pointers: [{ appKit, sectorCount, zone, index? }] }] }].',
    'AppKit -> global: (x - primary.x, primary.y + primary.height - y); a rect flips its bottom edge: y = primary.y + primary.height - (y + height).',
    'wheel: display = first containing the global activation (half-open), else nearest; placeWheel in its workArea.',
  ],
  'coords.win': [
    '[{ name, monitors: [{ bounds: rcMonitor, workArea: rcWork (physical px), dpi, primary? }],',
    '   displays: [{ bounds, workArea, scaleFactor, primary }] (global DIP), virtualScreen (union of physical bounds),',
    '   physicalToDip: [{ physical, dip, displayIndex }] (monitor by physical containment, else nearest),',
    '   dipToPhysical: [{ dip, physical, displayIndex }] (display by DIP containment, else nearest),',
    '   rects: [{ dip, displayIndex (largest DIP overlap), physical (unrounded), nearest, enclosing }],',
    '   wheel: [{ activationPhysical, diameter, displayIndex, activation (DIP), center, placementDiameter, windowFrame (DIP),',
    '             windowFramePhysical (enclosing), centerPhysical, shifted, pointers: [{ physical, sectorCount, zone, index? }] }] }].',
    'Per monitor: dip = dipOrigin + (physical - physicalOrigin) / (dpi / 96). Wheel pointers convert with the wheel monitor.',
    'Layout (displaysFromWin32Monitors): scale = dpi/96 (invalid dpi -> 1). Primary = flagged, else the monitor containing (0,0),',
    'else the first; its dipOrigin = physicalOrigin / scale. Rank monitors by (top, left, input index). Breadth-first from the',
    'primary: for each placed P (queue order) and each unplaced C (rank order) that touches P - first matching of: C.left == P.right,',
    'C.right == P.left, C.top == P.bottom, C.bottom == P.top, with the other axis ranges overlapping or touching (corners count) -',
    'place C on that DIP edge of P (right: x = P.dipRight; left: x = P.dipX - C.width/sC; bottom/top likewise) and queue it.',
    'Along the edge: begins equal -> same DIP begin; else ends equal -> same DIP end; else a = max(C.begin, P.begin) and',
    'C.dipBegin = P.dipBegin + (a - P.begin)/sP - (a - C.begin)/sC. Monitors not reached (gaps): repeatedly take the unplaced',
    'monitor closest (rect distance) to any placed one (rank order on ties), set C.dipOrigin = P.dipOrigin + (C.origin - P.origin)/sP',
    'for that nearest placed P, queue it and continue breadth-first. workArea keeps its physical offset / scale.',
  ],
  'coords.displayForPoint': [
    '[{ displays: Rect[], point, expect: index | -1, note }]: first display containing the point (half-open), else the smallest',
    'distance to the closed rectangle, ties -> lower index.',
  ],
  'coords.clamp': ['[{ rect, area, clamp: moved inside (centered on an axis where it is larger), fit: shrunk to the area keeping its center, then clamped }].'],
  'coords.rounding': ['{ roundHalfUp: [{ value, expect }], rects: [{ rect, nearest (each edge roundHalfUp), enclosing }] }.'],
};

export function generateWheelGolden() {
  return {
    $comment: COMMENT,
    schema: SCHEMA,
    formatVersion: GOLDEN_FORMAT_VERSION,
    tolerance: { dip: 1e-6 },
    geometry: G,
    derived: HIT_DIAMETERS.map((d) => ({ diameter: d, outerRadius: outerRadius(d), innerRadius: innerRadius(d, G), sectorOuterRadius: sectorOuterRadius(d, G) })),
    hitTest: { cases: hitCases() },
    hitTestNonFinite: { cases: hitNonFiniteCases() },
    placement: { cases: placementCases() },
    arming: { cases: armingCases() },
    selection: selectionSection(),
    fileCount: fileCountSection(),
    coords: {
      mac: macSection(),
      win: winSection(),
      displayForPoint: lookupSection(),
      clamp: clampSection(),
      rounding: roundingSection(),
    },
  };
}

export type WheelGolden = ReturnType<typeof generateWheelGolden>;

// ------------------------------------------------------------------ serialization

const INLINE_LIMIT = 160;
/** Elements of arrays of objects (test cases) stay on one line up to this length. */
const CASE_LINE_LIMIT = 600;

function inline(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`).join(', ')}}`;
}

function format(value: unknown, indent: string): string {
  const flat = inline(value);
  if (value === null || typeof value !== 'object' || indent.length + flat.length <= INLINE_LIMIT) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const caseList = value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
    const element = (v: unknown): string => {
      const line = inline(v);
      return caseList && inner.length + line.length <= CASE_LINE_LIMIT ? line : format(v, inner);
    };
    return `[\n${value.map((v) => inner + element(v)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${format(v, inner)}`).join(',\n')}\n${indent}}`;
}

/** Stable, diff-friendly JSON: small objects (one test case) on one line. Ends with a newline. */
export function serializeGolden(golden: unknown): string {
  return `${format(golden, '')}\n`;
}
