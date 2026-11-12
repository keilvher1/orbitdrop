#!/usr/bin/env node
/**
 * Generated parts of the OrbitDrop website (site/).
 *
 *   node site/scripts/build-assets.mjs
 *
 * Needs the workspace dependencies (`pnpm install --frozen-lockfile` at the repository root) for
 * sharp and lucide-react, and Node 22.18+ or 24: it imports the app's own TypeScript sources with
 * Node's built-in type stripping, so the website draws the wheel exactly like the app does.
 * Everything it writes is committed — GitHub Pages serves site/ as it is and never runs this.
 *
 * Writes
 *   site/assets/site.css                 colour block between the build:tokens markers, from
 *                                        packages/contracts/design-tokens.json
 *   site/index.html, site/en/index.html  inline SVG between <!-- build:… --> markers: the convert
 *                                        and tools wheels (apps/desktop/src/renderer/src/wheel/
 *                                        sectorPath.ts, packages/contracts/src/{geometry,actions,menus}.ts)
 *                                        and the tool icons (Lucide, as in the app's ActionIcon.tsx)
 *   site/assets/icons/*.png              favicons and app icons from apps/desktop/build/icon.png
 *   site/assets/og-ko.png, og-en.png     1200×630 Open Graph images rendered from an SVG
 *   site/assets/shots/*.webp, *.png      screenshots from docs/screenshots (each file ≤ 300 KB)
 *   site/assets/licenses/lucide.txt      licence of the Lucide icon shapes
 *
 * Text in the Open Graph images is rendered with the fonts installed on this computer (Apple SD
 * Gothic Neo on macOS); run it on a Mac to reproduce the committed images.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node warns once per type-stripped TypeScript file and about the app's typeless package.json.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  if (warning.name === 'ExperimentalWarning' && /type strip/i.test(warning.message)) return;
  console.warn(`${warning.name}: ${warning.message}`);
});

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SITE, '..');
const repoPath = (...parts) => path.join(REPO, ...parts);
const sitePath = (...parts) => path.join(SITE, ...parts);
const MAX_SHOT_BYTES = 300 * 1024;

function fail(message) {
  console.error(`build-assets: ${message}`);
  process.exit(1);
}

const require = createRequire(repoPath('package.json'));
let sharp;
try {
  sharp = require('sharp');
} catch {
  fail('sharp is not installed — run `pnpm install --frozen-lockfile` at the repository root first.');
}

const importRepo = (relative) => import(pathToFileURL(repoPath(relative)).href);

// ---------------------------------------------------------------------------------------------
// The app's own geometry, labels, menu order and colours
// ---------------------------------------------------------------------------------------------

const { sectorShape } = await importRepo('apps/desktop/src/renderer/src/wheel/sectorPath.ts');
const { DEFAULT_WHEEL_GEOMETRY: G } = await importRepo('packages/contracts/src/geometry.ts');
const { ACTIONS } = await importRepo('packages/contracts/src/actions.ts');
const TOKENS = JSON.parse(await readFile(repoPath('packages/contracts/design-tokens.json'), 'utf8'));

// menus.ts imports './actions' without an extension, which Node cannot load, so read the arrays.
const menusSource = await readFile(repoPath('packages/contracts/src/menus.ts'), 'utf8');
function menuOrder(name) {
  const match = menusSource.match(new RegExp(`export const ${name}: readonly ActionId\\[\\] = \\[([^\\]]*)\\]`));
  if (!match) fail(`could not read ${name} from packages/contracts/src/menus.ts`);
  const ids = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const id of ids) if (!(id in ACTIONS)) fail(`${name} names an unknown action: ${id}`);
  return ids;
}
const IMAGE_CONVERT_ORDER = menuOrder('IMAGE_CONVERT_ORDER');
const IMAGE_TOOLS_ORDER = menuOrder('IMAGE_TOOLS_ORDER');
// menus.ts baseMenuOrder: an image's convert menu is the image list without the input's own format.
const JPG_MENU = IMAGE_CONVERT_ORDER.filter((id) => id !== 'convert.jpeg');

// Tool icons: the same Lucide shapes the renderer uses (components/ActionIcon.tsx).
const actionIconSource = await readFile(repoPath('apps/desktop/src/renderer/src/components/ActionIcon.tsx'), 'utf8');
const iconBlock = actionIconSource.match(/ACTION_ICONS[^=]*=\s*\{([^}]*)\}/);
if (!iconBlock) fail('could not read ACTION_ICONS from ActionIcon.tsx');
const lucideRoot = path.dirname(require.resolve('lucide-react/package.json', { paths: [repoPath('apps/desktop')] }));
const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2').toLowerCase();
const ICONS = {};
for (const [, iconId, component] of iconBlock[1].matchAll(/(\w+):\s*(\w+)/g)) {
  const file = path.join(lucideRoot, 'dist', 'esm', 'icons', `${kebab(component)}.mjs`);
  const { __iconData } = await import(pathToFileURL(file).href);
  if (!__iconData?.node) fail(`unexpected Lucide module layout: ${file}`);
  ICONS[iconId] = __iconData.node;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const escapeXml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const num = (value) => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/** '#RRGGBB' stays as is; '#RRGGBBAA' becomes rgba() so SVG renderers without 8-digit hex agree. */
function colour(hex) {
  const h = hex.replace('#', '');
  if (h.length === 6) return `#${h.toUpperCase()}`;
  const [r, g, b, a] = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(3))})`;
}
const LIGHT = TOKENS.color.light;
const DARK = TOKENS.color.dark;

/** Port of labelFontSize/estimateLabelEm from apps/desktop/src/renderer/src/wheel/Wheel.tsx (TSX, not importable). */
function estimateLabelEm(label) {
  let em = 0;
  for (const ch of label) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xac00 && code <= 0xd7a3) em += 0.98;
    else if (ch === ' ') em += 0.3;
    else if (/[A-Z0-9]/.test(ch)) em += 0.68;
    else em += 0.58;
  }
  return em;
}
function labelFontSize(label, labelRadius, count, gap, base) {
  const half = Math.min(80, 180 / Math.max(1, count)) * (Math.PI / 180);
  const available = 2 * labelRadius * Math.sin(half) - gap - 16;
  const em = estimateLabelEm(label) + 0.03 * label.length;
  const fitted = em > 0 ? available / em : base;
  return Math.max(11, Math.min(base, Math.floor(fitted * 10) / 10));
}

function iconMarkup(iconId, extra = '') {
  const node = ICONS[iconId];
  if (!node) fail(`no icon for ${iconId}`);
  return node
    .map(([tag, attrs]) => {
      const list = Object.entries(attrs)
        .filter(([key]) => key !== 'key')
        .map(([key, value]) => `${key}="${escapeXml(value)}"`)
        .join(' ');
      return `<${tag} ${list}${extra}/>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------------------------
// Wheel SVG
// ---------------------------------------------------------------------------------------------

const DIAMETER = G.diameter;
const HALF = DIAMETER / 2;
const OUTER = DIAMETER / 2 - G.ringInset; // core sectorOuterRadius()
const INNER = (DIAMETER / 2) * G.innerRadiusRatio; // core innerRadius()
const LABEL_RADIUS = (OUTER + INNER) / 2;
const ICON_SIZE = TOKENS.font.wheelIconSize;
const SVG_FONT = "'Apple SD Gothic Neo', 'Helvetica Neue', 'Segoe UI', 'Malgun Gothic', 'Noto Sans KR', sans-serif";

/** Full wedge (no gaps) used as the hover target, so the pointer never "falls through" between sectors. */
function wedgePath(index, count) {
  const span = 360 / count;
  const centre = G.startAngleDeg + index * span;
  const a0 = ((centre - span / 2) * Math.PI) / 180;
  const a1 = ((centre + span / 2) * Math.PI) / 180;
  const p = (r, a) => `${num(r * Math.cos(a))} ${num(r * Math.sin(a))}`;
  const large = span > 180 ? 1 : 0;
  return `M ${p(INNER, a0)} L ${p(HALF, a0)} A ${HALF} ${HALF} 0 ${large} 1 ${p(HALF, a1)} L ${p(INNER, a1)} A ${num(INNER)} ${num(INNER)} 0 ${large} 0 ${p(INNER, a0)} Z`;
}

/** Centre capsule and the caption pill under the disc (both helpers draw one), sized to the text. */
function capsuleGroup(text, index, isDefault) {
  const capMax = Math.max(G.capsuleWidth, 2 * INNER - 10);
  const capW = Math.min(capMax, Math.max(G.capsuleWidth, estimateLabelEm(text) * TOKENS.font.capsuleSize + 28));
  const capH = G.capsuleHeight;
  const pillH = 26;
  const pillW = Math.max(56, estimateLabelEm(text) * 13 + 26);
  const pillY = HALF + 6;
  const hidden = isDefault ? '' : ' visibility="hidden"';
  return [
    `<g class="w-cap c${index}${isDefault ? ' is-default' : ''}"${hidden}>`,
    `<rect class="w-capsule" x="${num(-capW / 2)}" y="${num(-capH / 2)}" width="${num(capW)}" height="${capH}" rx="${capH / 2}" fill="${colour(LIGHT.capsule)}"/>`,
    `<text class="w-capsule-text" x="0" y="0" dy="0.35em" text-anchor="middle" font-size="${TOKENS.font.capsuleSize}" fill="${colour(LIGHT.capsuleText)}">${escapeXml(text)}</text>`,
    `<rect class="w-capsule" x="${num(-pillW / 2)}" y="${pillY}" width="${num(pillW)}" height="${pillH}" rx="${pillH / 2}" fill="${colour(LIGHT.capsule)}"/>`,
    `<text class="w-caption-text" x="0" y="${pillY + pillH / 2}" dy="0.35em" text-anchor="middle" font-size="13" fill="${colour(LIGHT.capsuleText)}">${escapeXml(text)}</text>`,
    '</g>',
  ].join('');
}

/**
 * The radial menu as an SVG fragment centred on (0, 0): disc, sectors, centre capsule and the caption
 * pill below the disc. Classes carry the theme (site.css swaps the colours for dark mode and forced
 * colours); the presentation attributes are the light theme, used by renderers without the stylesheet.
 */
function wheelBody({ id, actions, active, locale }) {
  const count = actions.length;
  const parts = [];
  parts.push(
    `<defs><filter id="${id}-shadow" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB">` +
      `<feDropShadow class="w-shadow" dx="0" dy="10" stdDeviation="11" flood-color="#7A2E00" flood-opacity="${Number((0x40 / 255).toFixed(3))}"/></filter></defs>`,
  );
  parts.push(
    `<circle class="w-disc" r="${num(HALF - G.ringWidth / 2)}" fill="${colour(LIGHT.wheelDisc)}" stroke="${colour(LIGHT.wheelRing)}" stroke-width="${G.ringWidth}" filter="url(#${id}-shadow)"/>`,
  );
  actions.forEach((actionId, index) => {
    const action = ACTIONS[actionId];
    const label = action.wheelLabel[locale];
    const shape = sectorShape({
      index,
      count,
      innerRadius: INNER,
      outerRadius: OUTER,
      gap: G.sectorGap,
      cornerRadius: G.sectorCornerRadius,
      startAngleDeg: G.startAngleDeg,
    });
    const isActive = actionId === active;
    const fontSize = labelFontSize(label, LABEL_RADIUS, count, G.sectorGap, TOKENS.font.wheelLabelSize);
    const fg = isActive ? LIGHT.sectorActiveText : LIGHT.sectorText;
    const iconColour = colour(isActive ? LIGHT.sectorActiveText : LIGHT.sectorIcon);
    // Same placement as Wheel.tsx: icon above the label point, label 10 below it.
    const icon = action.icon
      ? `<g class="w-icon" transform="translate(${-ICON_SIZE / 2} ${-ICON_SIZE - 3}) scale(${num(ICON_SIZE / 24)})" fill="none" stroke="${iconColour}" color="${iconColour}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(action.icon)}</g>`
      : '';
    parts.push(
      `<g class="w-sector s${index}${isActive ? ' is-active' : ''}" data-action="${actionId}">` +
        `<path class="w-hit" d="${wedgePath(index, count)}" fill="transparent"/>` +
        `<path class="w-shape" d="${shape.path}" fill="${colour(isActive ? LIGHT.sectorActive : LIGHT.sector)}"/>` +
        `<g transform="translate(${num(shape.labelPoint.x)} ${num(shape.labelPoint.y)})">${icon}` +
        `<text class="w-label" x="0" y="${icon ? 10 : 0}" dy="0.35em" text-anchor="middle" font-size="${fontSize}" letter-spacing="${TOKENS.font.wheelLabelTracking}" fill="${colour(fg)}">${escapeXml(label)}</text></g>` +
        '</g>',
    );
  });
  actions.forEach((actionId, index) => parts.push(capsuleGroup(ACTIONS[actionId].wheelLabel[locale], index, actionId === active)));
  return parts.join('');
}

/** What the hero adds on top of the wheel: the file being dragged, the pointer and the Shift key. */
function heroOverlay(id) {
  // Pointer tip inside the PNG sector (top), the drag image around it like Finder draws it.
  return [
    `<g class="w-drag" aria-hidden="true">`,
    `<defs><linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3B4C8C"/><stop offset="0.62" stop-color="#E08A62"/><stop offset="1" stop-color="#F3B47E"/></linearGradient>`,
    `<filter id="${id}-lift" x="-30%" y="-30%" width="160%" height="170%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#2B1D14" flood-opacity="0.3"/></filter></defs>`,
    `<g transform="translate(62 -160)" filter="url(#${id}-lift)">`,
    `<rect x="-29" y="-23" width="58" height="46" rx="5" fill="#FFFFFF"/>`,
    `<rect x="-26" y="-20" width="52" height="40" rx="2.5" fill="url(#${id}-sky)"/>`,
    `<circle cx="9" cy="-3" r="7.5" fill="#FDEBD2"/>`,
    `<path d="M-26 9 C-15 -1 -3 -1 7 7 C13 11 20 11 26 5 L26 20 L-26 20 Z" fill="#3E3452"/>`,
    `<rect class="w-file-name" x="-31" y="27" width="62" height="18" rx="5" fill="#1E5FD6"/>`,
    `<text x="0" y="36" dy="0.35em" text-anchor="middle" font-size="11.5" font-weight="600" fill="#FFFFFF">photo.jpg</text>`,
    `</g>`,
    `<path class="w-pointer" transform="translate(44 -152) scale(1.15)" d="M0 0 L0 16.6 L3.9 13 L6.5 19 L9.2 17.9 L6.7 12 L12 12 Z" fill="#111111" stroke="#FFFFFF" stroke-width="1.3" stroke-linejoin="round"/>`,
    `</g>`,
    `<g class="w-key" transform="translate(-200 172)" aria-hidden="true">`,
    `<rect class="w-key-base" x="-52" y="-22" width="104" height="48" rx="11" fill="#E9D3C1"/>`,
    `<rect class="w-key-top" x="-52" y="-26" width="104" height="47" rx="11" fill="#FFFFFF" stroke="#EBD7C6"/>`,
    `<text class="w-key-text" x="0" y="-2.5" dy="0.35em" text-anchor="middle" font-size="18" font-weight="700" fill="#2B1D14">⇧ Shift</text>`,
    `</g>`,
  ].join('');
}

function wheelSvg({ id, viewBox, title, desc, body }) {
  return (
    `<svg class="wheel-art" id="${id}" viewBox="${viewBox}" role="img" aria-labelledby="${id}-title ${id}-desc" focusable="false" ` +
    `font-family="${escapeXml(SVG_FONT)}" font-weight="700">` +
    `<title id="${id}-title">${escapeXml(title)}</title><desc id="${id}-desc">${escapeXml(desc)}</desc>${body}</svg>`
  );
}

const sectorList = (actions, locale) => actions.map((id) => ACTIONS[id].wheelLabel[locale]).join(', ');

const COPY = {
  ko: {
    heroTitle: 'OrbitDrop 변환 휠',
    heroDesc: (labels) =>
      `JPG 파일을 끌며 Shift를 누르면 포인터 옆에 나타나는 원형 메뉴입니다. 맨 위에서 시계 방향으로 ${labels} 칸이 있고, 포인터가 올라간 PNG 칸이 주황색으로 강조되어 있으며 가운데 캡슐에 PNG가 표시됩니다.`,
    toolsTitle: 'OrbitDrop 도구 휠',
    toolsDesc: (labels) =>
      `이미지를 끌며 Option+Shift를 누르면 나타나는 도구 메뉴입니다. 맨 위에서 시계 방향으로 ${labels} 칸이 있고, 자르기 칸이 주황색으로 강조되어 있습니다.`,
  },
  en: {
    heroTitle: 'The OrbitDrop convert wheel',
    heroDesc: (labels) =>
      `The radial menu that appears next to the pointer when you press Shift while dragging a JPG file. Clockwise from the top it offers ${labels}; the PNG sector under the pointer is highlighted in orange and the centre capsule reads PNG.`,
    toolsTitle: 'The OrbitDrop tools wheel',
    toolsDesc: (labels) =>
      `The tools menu that appears when you press Option+Shift while dragging an image. Clockwise from the top it offers ${labels}; the CROP sector is highlighted in orange.`,
  },
};

function heroWheel(locale) {
  const id = 'hero-wheel';
  return wheelSvg({
    id,
    viewBox: '-258 -206 516 436',
    title: COPY[locale].heroTitle,
    desc: COPY[locale].heroDesc(sectorList(JPG_MENU, locale)),
    body: wheelBody({ id, actions: JPG_MENU, active: 'convert.png', locale }) + heroOverlay(id),
  });
}

function toolsWheel(locale) {
  const id = 'tools-wheel';
  return wheelSvg({
    id,
    viewBox: '-196 -196 392 428',
    title: COPY[locale].toolsTitle,
    desc: COPY[locale].toolsDesc(sectorList(IMAGE_TOOLS_ORDER, locale)),
    body: wheelBody({ id, actions: IMAGE_TOOLS_ORDER, active: 'tool.crop', locale }),
  });
}

/** Small inline icon for the tool list (decorative: the tool name follows it). */
function toolIcon(iconId) {
  return `<svg class="tool-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(iconId)}</svg>`;
}

// ---------------------------------------------------------------------------------------------
// Inject generated markup into the pages and the stylesheet
// ---------------------------------------------------------------------------------------------

function replaceBlocks(source, file, render) {
  let count = 0;
  const out = source.replace(/(<!-- build:([\w:-]+) -->)[\s\S]*?(<!-- \/build:\2 -->)/g, (_, open, name, close) => {
    count += 1;
    return `${open}${render(name)}${close}`;
  });
  if (count === 0) fail(`${file}: no <!-- build:… --> markers`);
  return out;
}

async function injectPage(relative, locale) {
  const file = sitePath(relative);
  const source = await readFile(file, 'utf8');
  const out = replaceBlocks(source, relative, (name) => {
    if (name === 'wheel-hero') return heroWheel(locale);
    if (name === 'wheel-tools') return toolsWheel(locale);
    if (name.startsWith('icon:')) return toolIcon(name.slice('icon:'.length));
    fail(`${relative}: unknown marker build:${name}`);
  });
  await writeFile(file, out);
  return relative;
}

function tokenBlock() {
  const pick = (t, accentLink) => ({
    bg: t.windowBg,
    surface: t.surface,
    'surface-muted': t.surfaceMuted,
    border: t.border,
    text: t.text,
    'text-muted': t.textMuted,
    accent: t.accent,
    'accent-hover': t.accentHover,
    'accent-pressed': t.accentPressed,
    'accent-text': t.accentText,
    // Link text on the page background: the accent itself is only 4.2:1 on the light background.
    link: accentLink ? t.accent : t.accentPressed,
    'link-hover': accentLink ? t.accentHover : t.text,
    focus: t.focusRing,
    success: t.success,
    'warning-bg': t.warningBg,
    'warning-border': t.warningBorder,
    'warning-text': t.warningText,
    'w-disc': t.wheelDisc,
    'w-ring': t.wheelRing,
    'w-shadow': t.wheelShadow,
    'w-sector': t.sector,
    'w-sector-hover': t.sectorHover,
    'w-text': t.sectorText,
    'w-icon': t.sectorIcon,
    'w-active': t.sectorActive,
    'w-active-text': t.sectorActiveText,
    'w-capsule': t.capsule,
    'w-capsule-text': t.capsuleText,
  });
  const lines = (vars) =>
    Object.entries(vars)
      .map(([name, value]) => `  --${name}: ${colour(value)};`)
      .join('\n');
  const dark = lines(pick(DARK, true)).replace(/^/gm, '  ');
  return [
    '/* build:tokens — generated by site/scripts/build-assets.mjs from packages/contracts/design-tokens.json */',
    ':root {',
    lines(pick(LIGHT, false)),
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :root {',
    dark,
    '  }',
    '}',
    '/* /build:tokens */',
  ].join('\n');
}

async function injectTokens() {
  const file = sitePath('assets', 'site.css');
  const source = await readFile(file, 'utf8');
  const pattern = /\/\* build:tokens[\s\S]*?\/\* \/build:tokens \*\//;
  if (!pattern.test(source)) fail('site/assets/site.css: no build:tokens markers');
  await writeFile(file, source.replace(pattern, tokenBlock()));
}

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------

const written = [];
async function record(file) {
  const { size } = await stat(file);
  written.push({ file: path.relative(REPO, file), size });
  return size;
}

const ICON_SOURCE = repoPath('apps/desktop/build/icon.png');
// icon.svg draws the rounded square at (100, 100) with size 824 on a 1024 canvas (macOS grid);
// favicons use just the square so they are not lost in the transparent margin.
const SQUARE = { left: 96, top: 96, width: 832, height: 832 };

async function buildIcons() {
  const dir = sitePath('assets', 'icons');
  await mkdir(dir, { recursive: true });
  const square = await sharp(ICON_SOURCE).extract(SQUARE).png().toBuffer();
  const outputs = [
    ['favicon-16.png', 16, square],
    ['favicon-32.png', 32, square],
    ['icon-64.png', 64, square],
    ['icon-192.png', 192, square],
    ['app-icon-256.png', 256, ICON_SOURCE],
  ];
  for (const [name, size, input] of outputs) {
    const file = path.join(dir, name);
    await sharp(input).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9, effort: 10 }).toFile(file);
    await record(file);
  }
  // iOS masks the touch icon itself and shows transparency as black: give it the icon's own cream.
  const touch = path.join(dir, 'apple-touch-icon.png');
  await sharp(ICON_SOURCE)
    .extract({ left: 100, top: 100, width: 824, height: 824 })
    .flatten({ background: '#FDEBDC' })
    .resize(180, 180, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(touch);
  await record(touch);
}

const OG_COPY = {
  ko: {
    lines: ['파일을 끌다가 Shift,', '원하는 형식에 놓으세요.'],
    sub: '무료 오픈 소스 · macOS · Windows(베타)',
    foot: '모든 처리는 내 컴퓨터에서 — 업로드도, 계정도 없습니다.',
  },
  en: {
    lines: ['Drag a file, press Shift,', 'drop it on a format.'],
    sub: 'Free and open source · macOS · Windows (beta)',
    foot: 'Everything runs on your computer — no upload, no account.',
  },
};

async function buildOgImages() {
  const icon = await sharp(ICON_SOURCE).resize(132, 132, { kernel: 'lanczos3' }).png().toBuffer();
  for (const locale of ['ko', 'en']) {
    const copy = OG_COPY[locale];
    const id = `og-${locale}`;
    const font = `font-family="${escapeXml(SVG_FONT)}"`;
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" ${font}>`,
      '<defs>',
      `<linearGradient id="${id}-wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F8714E"/><stop offset="0.55" stop-color="#F5A04B"/><stop offset="1" stop-color="#EA7A97"/></linearGradient>`,
      `<radialGradient id="${id}-glow" cx="0.18" cy="0.12" r="0.9"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.9"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`,
      '</defs>',
      `<rect width="1200" height="630" fill="${LIGHT.windowBg}"/>`,
      `<rect width="1200" height="630" fill="url(#${id}-glow)"/>`,
      `<rect x="640" y="34" width="526" height="562" rx="40" fill="url(#${id}-wall)"/>`,
      `<g transform="translate(903 300) scale(1.2)" font-weight="700">${wheelBody({ id, actions: JPG_MENU, active: 'convert.png', locale })}${heroOverlay(id).replace(/<g class="w-key"[\s\S]*$/, '')}</g>`,
      `<text x="72" y="292" font-size="74" font-weight="800" fill="${LIGHT.text}" letter-spacing="-1.5">OrbitDrop</text>`,
      ...copy.lines.map(
        (line, i) =>
          `<text x="74" y="${372 + i * 56}" font-size="${locale === 'ko' ? 44 : 42}" font-weight="700" fill="${i === 0 ? LIGHT.text : LIGHT.accentPressed}" letter-spacing="-0.5">${escapeXml(line)}</text>`,
      ),
      `<text x="75" y="522" font-size="25" font-weight="600" fill="${LIGHT.textMuted}">${escapeXml(copy.sub)}</text>`,
      `<text x="75" y="560" font-size="22" font-weight="500" fill="${LIGHT.textMuted}">${escapeXml(copy.foot)}</text>`,
      '</svg>',
    ].join('');
    const file = sitePath('assets', `og-${locale}.png`);
    await sharp(Buffer.from(svg))
      .composite([{ input: icon, left: 62, top: 72 }])
      .png({ compressionLevel: 9, effort: 10, palette: true, quality: 95 })
      .toFile(file);
    await record(file);
  }
}

/** Screenshots used on the pages. `width` is the largest pixel width kept (2× of the display size where the source allows). */
const SHOTS = [
  { src: 'vm-macos14-01-finder-drag-shift-wheel.png', out: 'finder-convert-wheel', width: 500 },
  { src: 'vm-macos14-03-tools-wheel-crop.png', out: 'finder-tools-wheel', width: 500 },
  { src: 'desktop-renderer-electron-crop.png', out: 'crop-editor', width: 760 },
  { src: 'desktop-renderer-electron-add-background-16x9.png', out: 'add-background-editor', width: 760 },
  { src: 'vm-macos14-06-results-on-desktop.png', out: 'results-next-to-original', width: 510 },
  { src: 'vm-macos14-13-drop-zone-picker.png', out: 'drop-zone', width: 400 },
];

async function encodeWithin(pipelineFor, attempts, label) {
  for (const options of attempts) {
    const buffer = await pipelineFor(options);
    if (buffer.length <= MAX_SHOT_BYTES) return buffer;
  }
  fail(`${label} stays above ${MAX_SHOT_BYTES} bytes`);
}

async function buildShots() {
  const dir = sitePath('assets', 'shots');
  await mkdir(dir, { recursive: true });
  const manifest = [];
  for (const shot of SHOTS) {
    const source = repoPath('docs', 'screenshots', shot.src);
    const base = () => sharp(source).resize({ width: shot.width, withoutEnlargement: true, kernel: 'lanczos3' });
    const webp = await encodeWithin(
      (o) => base().webp({ quality: o.quality, effort: 6, smartSubsample: true }).toBuffer(),
      [{ quality: 82 }, { quality: 74 }, { quality: 66 }],
      `${shot.out}.webp`,
    );
    const png = await encodeWithin(
      (o) => base().png({ palette: true, colours: o.colours, quality: 90, effort: 10, compressionLevel: 9, dither: 0.8 }).toBuffer(),
      [{ colours: 256 }, { colours: 160 }, { colours: 96 }, { colours: 64 }],
      `${shot.out}.png`,
    );
    const { width, height } = await sharp(png).metadata();
    await writeFile(path.join(dir, `${shot.out}.webp`), webp);
    await writeFile(path.join(dir, `${shot.out}.png`), png);
    await record(path.join(dir, `${shot.out}.webp`));
    await record(path.join(dir, `${shot.out}.png`));
    manifest.push(`${shot.out}: ${width}×${height} (from docs/screenshots/${shot.src})`);
  }
  return manifest;
}

async function copyLucideLicence() {
  const dir = sitePath('assets', 'licenses');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'lucide.txt');
  await copyFile(path.join(lucideRoot, 'LICENSE'), file);
  await record(file);
}

// ---------------------------------------------------------------------------------------------

// `--preview <dir>`: render the two wheels to PNG (light theme, as an SVG renderer without the
// stylesheet sees them) to check the artwork without a browser. Writes nothing in site/.
const previewAt = process.argv.indexOf('--preview');
if (previewAt !== -1) {
  const dir = path.resolve(process.argv[previewAt + 1] ?? '.');
  await mkdir(dir, { recursive: true });
  for (const [name, svg, width] of [
    ['hero-ko', heroWheel('ko'), 1032],
    ['tools-ko', toolsWheel('ko'), 784],
    ['tools-en', toolsWheel('en'), 784],
  ]) {
    const standalone = svg.replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" `);
    const file = path.join(dir, `${name}.png`);
    await sharp(Buffer.from(standalone)).flatten({ background: '#F6A04B' }).png().toFile(file);
    console.log(file);
  }
  process.exit(0);
}

await injectTokens();
const pages = [await injectPage('index.html', 'ko'), await injectPage(path.join('en', 'index.html'), 'en')];
await buildIcons();
await buildOgImages();
const shots = await buildShots();
await copyLucideLicence();

console.log(`tokens → site/assets/site.css; wheels and icons → ${pages.map((p) => `site/${p}`).join(', ')}`);
for (const line of shots) console.log(`shot ${line}`);
for (const { file, size } of written) console.log(`${(size / 1024).toFixed(1).padStart(7)} KB  ${file}`);
