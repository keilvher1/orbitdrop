#!/usr/bin/env node
/**
 * Checks the static website in site/ before it is published. Node built-ins only (no install
 * needed), so the Pages workflow runs it too.
 *
 *   node site/scripts/check.mjs
 *
 * Checks
 *  - every internal link, image, stylesheet and script resolves to a file in site/ with the exact
 *    letter case (GitHub Pages is case-sensitive), and every #anchor exists on its target page
 *    (the site is served under /orbitdrop/);
 *  - every page has <html lang>, a <title> and a meta description, and exactly one <h1>;
 *  - every <img> has alt text (alt="" only with aria-hidden="true"), its width/height match the
 *    file, and every inline <svg> is either named (role="img" + accessible name) or aria-hidden;
 *  - ids are unique and ARIA/label references point at existing ids;
 *  - no URL outside the allow-list appears in any text file (any extension, any letter case,
 *    protocol-relative included): github.com/keilvher1/orbitdrop…, the maintainer's profile
 *    https://github.com/keilvher1 (code signing roles), api.github.com, docs.github.com, the
 *    SignPath attribution https://about.signpath.io and https://signpath.org (home pages only),
 *    Anthropic's API terms and privacy policy (exact pages, named by the privacy statement's
 *    optional Claude analysis section) and the site's own https://keilvher1.github.io/orbitdrop/;
 *  - no inline scripts, inline styles or event-handler attributes (the pages' CSP forbids them);
 *  - 404.html uses root-absolute links only (GitHub Pages serves it at any depth);
 *  - screenshots stay within 300 KB, the generated <!-- build:… --> blocks are filled in;
 *  - text colours from the design tokens reach 4.5:1 on the backgrounds they are used on.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://keilvher1.github.io';
const BASE = '/orbitdrop/';
const MAX_SHOT_BYTES = 300 * 1024;
const XML_NAMESPACES = new Set(['http://www.sitemaps.org/schemas/sitemap/0.9', 'http://www.w3.org/1999/xhtml', 'http://www.w3.org/2000/svg']);

const errors = [];
const notes = [];
const error = (file, message) => errors.push(`${file}: ${message}`);

// ------------------------------------------------------------------------------------------ files

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path.relative(SITE, full) === 'scripts') continue; // tooling, not published
      out.push(...walk(full));
    } else out.push(full);
  }
  return out;
}

const files = walk(SITE);
const rel = (file) => path.relative(SITE, file).split(path.sep).join('/');
const htmlFiles = files.filter((f) => f.endsWith('.html'));
// Every file without NUL bytes counts as text, whatever its extension, so no new file escapes the URL scan.
const textFiles = files.filter((f) => !readFileSync(f).includes(0));

/** URL path a file is served at, e.g. site/en/index.html → /orbitdrop/en/ */
function servedPath(file) {
  const r = rel(file);
  if (r === 'index.html') return BASE;
  if (r.endsWith('/index.html')) return BASE + r.slice(0, -'index.html'.length);
  return BASE + r;
}

/**
 * True when every segment exists with exactly this spelling. GitHub Pages is case-sensitive; a
 * Mac's disk usually is not, so stat() alone would accept href="Privacy/".
 */
function existsExactly(parts) {
  let dir = SITE;
  for (const part of parts) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    if (!entries.includes(part)) return false;
    dir = path.join(dir, part);
  }
  return true;
}

/** Site file for a URL path under /orbitdrop/, or null. */
function fileForPath(pathname) {
  if (!pathname.startsWith(BASE)) return null;
  let r;
  try {
    r = decodeURIComponent(pathname.slice(BASE.length));
  } catch {
    return null;
  }
  if (r === '' || r.endsWith('/')) r += 'index.html';
  const parts = r.split('/');
  const full = path.join(SITE, ...parts);
  if (!full.startsWith(SITE + path.sep) || !existsExactly(parts)) return null;
  try {
    const s = statSync(full);
    if (s.isFile()) return full;
    if (s.isDirectory() && existsExactly([...parts, 'index.html'])) return path.join(full, 'index.html');
  } catch {
    return null;
  }
  return null;
}

// ------------------------------------------------------------------------------------------ HTML

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/**
 * Tags with attributes and line numbers, read the way an HTML tokenizer does (so attributes that
 * are not separated by whitespace, such as src="a"alt="", are still seen). Comments are blanked
 * first, keeping line breaks.
 */
function parseTags(source) {
  const text = source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  const newlines = [];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) newlines.push(i);
  const lineAt = (index) => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid] < index) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
  const space = (ch) => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';
  const tags = [];
  const start = /<(\/?)([a-zA-Z][\w:-]*)/g;
  let m;
  while ((m = start.exec(text))) {
    const attrs = {};
    let j = start.lastIndex;
    while (j < text.length) {
      while (j < text.length && space(text[j])) j++;
      if (text[j] === '>') {
        j++;
        break;
      }
      if (text[j] === '/') {
        j++;
        continue;
      }
      let k = j;
      while (k < text.length && !space(text[k]) && !'=>/'.includes(text[k])) k++;
      const name = text.slice(j, k).toLowerCase();
      j = k;
      while (j < text.length && space(text[j])) j++;
      let value = '';
      if (text[j] === '=') {
        j++;
        while (j < text.length && space(text[j])) j++;
        const quote = text[j];
        if (quote === '"' || quote === "'") {
          const end = text.indexOf(quote, j + 1);
          value = text.slice(j + 1, end === -1 ? text.length : end);
          j = end === -1 ? text.length : end + 1;
        } else {
          k = j;
          while (k < text.length && !space(text[k]) && text[k] !== '>') k++;
          value = text.slice(j, k);
          j = k;
        }
      }
      if (name) attrs[name] = decode(value);
      else if (j < text.length && text[j] !== '>') j++; // stray character: skip it
    }
    tags.push({ name: m[2].toLowerCase(), closing: m[1] === '/', attrs, index: m.index, line: lineAt(m.index) });
    start.lastIndex = Math.max(j, start.lastIndex);
  }
  return { text, tags };
}

const pages = new Map(); // file → { tags, ids }
for (const file of htmlFiles) {
  const source = readFileSync(file, 'utf8');
  const parsed = parseTags(source);
  const ids = new Map();
  for (const tag of parsed.tags) {
    if (tag.closing || tag.attrs.id === undefined) continue;
    if (ids.has(tag.attrs.id)) error(rel(file), `duplicate id "${tag.attrs.id}" (lines ${ids.get(tag.attrs.id)} and ${tag.line})`);
    else ids.set(tag.attrs.id, tag.line);
  }
  pages.set(file, { source, ...parsed, ids });
}

// ------------------------------------------------------------------------------------------ URLs

/** Hosts allowed with their home page only: the attribution the code signing policy must carry. */
const HOME_PAGE_ONLY = new Set(['about.signpath.io', 'signpath.org']);

/** Exact pages allowed: the policies that apply to the optional Claude analysis (privacy statement). */
const EXACT_PAGES = new Set(['https://www.anthropic.com/legal/commercial-terms', 'https://www.anthropic.com/legal/privacy']);

function isAllowedExternal(url) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (url.hostname === 'github.com') {
    // The repository, and the maintainer's profile as such (code signing roles), nothing else on github.com.
    return /^\/keilvher1\/orbitdrop(?:[/?#.-]|$)/.test(url.pathname) || (url.pathname === '/keilvher1' && !url.search && !url.hash);
  }
  if (HOME_PAGE_ONLY.has(url.hostname)) return url.pathname === '/' && !url.search && !url.hash;
  if (EXACT_PAGES.has(`${url.origin}${url.pathname}`)) return !url.search && !url.hash;
  return url.hostname === 'api.github.com' || url.hostname === 'docs.github.com';
}

const externalSeen = new Map(); // url → first file

/**
 * Validate one URL reference. Internal references must exist (and their #anchor too);
 * external ones must be on the allow-list.
 */
function checkReference(file, line, raw, { pageUrl, requireAbsolutePath = false, kind = 'link' }) {
  const value = raw.trim();
  if (value === '') return error(rel(file), `line ${line}: empty ${kind}`);
  if (/^(javascript|data|vbscript|file):/i.test(value)) return error(rel(file), `line ${line}: forbidden URL scheme in ${kind}: ${value}`);
  if (/^(mailto|tel):/i.test(value)) return error(rel(file), `line ${line}: ${kind} uses ${value.split(':')[0]}: (not on the allow-list)`);
  let url;
  try {
    url = new URL(value, ORIGIN + pageUrl);
  } catch {
    return error(rel(file), `line ${line}: invalid URL ${value}`);
  }
  const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//');
  if (url.origin !== ORIGIN) {
    if (!isAllowedExternal(url)) return error(rel(file), `line ${line}: external URL not allowed: ${value}`);
    if (!externalSeen.has(url.href)) externalSeen.set(url.href, rel(file));
    return;
  }
  if (requireAbsolutePath && !isAbsolute && !value.startsWith('/') && !value.startsWith('#')) {
    return error(rel(file), `line ${line}: relative ${kind} "${value}" breaks when GitHub Pages serves this page at another path`);
  }
  if (!url.pathname.startsWith(BASE) && url.pathname !== BASE.slice(0, -1)) {
    return error(rel(file), `line ${line}: ${kind} leaves the project site: ${value}`);
  }
  const target = fileForPath(url.pathname === BASE.slice(0, -1) ? BASE : url.pathname);
  if (!target) return error(rel(file), `line ${line}: ${kind} target missing: ${value}`);
  if (url.hash.length > 1) {
    const page = pages.get(target);
    const id = decodeURIComponent(url.hash.slice(1));
    if (!page) return error(rel(file), `line ${line}: #${id} points into a non-HTML file: ${value}`);
    if (!page.ids.has(id)) return error(rel(file), `line ${line}: anchor #${id} not found in ${rel(target)}`);
  }
}

/**
 * Every http(s) URL written anywhere in a text file must be allowed (namespace URIs aside), in any
 * letter case, and so must protocol-relative URLs in quotes ('//host/…').
 */
function scanUrls(file, text) {
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  const re = /https?:\/\/[^\s"'<>()\\`]+/gi;
  let m;
  while ((m = re.exec(text))) {
    const found = m[0].replace(/[.,;:]+$/, '');
    const before = text.slice(Math.max(0, m.index - 16), m.index);
    if (XML_NAMESPACES.has(found) && /xmlns(?::\w+)?=["']$/.test(before)) continue;
    let url;
    try {
      url = new URL(found);
    } catch {
      error(rel(file), `line ${lineOf(m.index)}: unparseable URL ${found}`);
      continue;
    }
    if (url.origin === ORIGIN) {
      const target = fileForPath(url.pathname);
      if (url.protocol !== 'https:') error(rel(file), `line ${lineOf(m.index)}: own URL must use https: ${found}`);
      else if (!target) error(rel(file), `line ${lineOf(m.index)}: own URL has no file behind it: ${found}`);
      else if (url.hash.length > 1) {
        const id = decodeURIComponent(url.hash.slice(1));
        if (!pages.get(target)?.ids.has(id)) error(rel(file), `line ${lineOf(m.index)}: anchor #${id} not found in ${rel(target)}`);
      }
      continue;
    }
    if (!isAllowedExternal(url)) error(rel(file), `line ${lineOf(m.index)}: external URL not allowed: ${found}`);
    else if (!externalSeen.has(url.href)) externalSeen.set(url.href, rel(file));
  }
  for (const p of text.matchAll(/["'`(]\s*(\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s"'`)]*)/gi)) {
    const url = new URL('https:' + p[1]);
    if (url.origin === ORIGIN) continue;
    if (!isAllowedExternal(url)) error(rel(file), `line ${lineOf(p.index)}: protocol-relative URL not allowed: ${p[1]}`);
  }
}

for (const file of textFiles) {
  const text = readFileSync(file, 'utf8');
  scanUrls(file, text);
  if (file.endsWith('.css')) {
    for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      checkReference(file, text.slice(0, m.index).split('\n').length, m[2], { pageUrl: servedPath(file), kind: 'CSS url()' });
    }
    if (/@import/.test(text)) error(rel(file), '@import is not allowed (one stylesheet, no external requests)');
  }
}

// ------------------------------------------------------------------------------------------ pages

/** Image size from the file header (PNG, WebP). */
function imageSize(file) {
  const b = readFileSync(file);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

const URL_ATTRS = ['href', 'src', 'action', 'poster', 'data', 'xlink:href', 'formaction', 'cite'];
const REF_ATTRS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'aria-errormessage', 'aria-details', 'for', 'headers', 'list'];

for (const [file, page] of pages) {
  const name = rel(file);
  const pageUrl = servedPath(file);
  const is404 = name === '404.html';
  const { tags, source } = page;
  const open = tags.filter((t) => !t.closing);

  // lang, title, description, h1
  const html = open.find((t) => t.name === 'html');
  if (!html || !/^(ko|en)(-[A-Z]{2})?$/.test(html.attrs.lang ?? '')) error(name, '<html> needs lang="ko" or lang="en"');
  const title = source.match(/<title>([\s\S]*?)<\/title>/);
  if (!title || decode(title[1]).trim().length < 5) error(name, 'missing or empty <title>');
  const description = open.find((t) => t.name === 'meta' && t.attrs.name === 'description');
  if (!description || (description.attrs.content ?? '').trim().length < 30) error(name, 'missing or too short <meta name="description">');
  if (!open.some((t) => t.name === 'meta' && t.attrs.name === 'viewport')) error(name, 'missing viewport meta');
  const h1s = open.filter((t) => t.name === 'h1').length;
  if (h1s !== 1) error(name, `expected exactly one <h1>, found ${h1s}`);
  if (!open.some((t) => t.name === 'main')) error(name, 'missing <main> landmark');
  for (const t of open) {
    if (t.attrs.lang !== undefined && !/^(ko|en)$/.test(t.attrs.lang)) error(name, `line ${t.line}: unexpected lang="${t.attrs.lang}"`);
  }

  // generated blocks filled in
  for (const m of source.matchAll(/<!-- build:([\w:-]+) -->([\s\S]*?)<!-- \/build:\1 -->/g)) {
    if (m[2].trim() === '') error(name, `<!-- build:${m[1]} --> is empty: run node site/scripts/build-assets.mjs`);
  }

  // CSP hygiene
  for (const t of open) {
    if (t.name === 'script' && !t.attrs.src) error(name, `line ${t.line}: inline <script> (the CSP only allows script files)`);
    if (t.name === 'style') error(name, `line ${t.line}: inline <style> (the CSP only allows the stylesheet file)`);
    if (t.attrs.style !== undefined) error(name, `line ${t.line}: style="" attribute (the CSP only allows the stylesheet file)`);
    for (const attr of Object.keys(t.attrs)) if (/^on[a-z]+$/.test(attr)) error(name, `line ${t.line}: event handler attribute ${attr}`);
    if (t.attrs.target === '_blank' && !/noopener/.test(t.attrs.rel ?? '')) error(name, `line ${t.line}: target=_blank without rel=noopener`);
  }

  // URL attributes
  for (const t of open) {
    for (const attr of URL_ATTRS) {
      if (t.attrs[attr] === undefined) continue;
      checkReference(file, t.line, t.attrs[attr], { pageUrl, requireAbsolutePath: is404, kind: `${t.name} ${attr}` });
    }
    if (t.attrs.srcset !== undefined) {
      for (const candidate of t.attrs.srcset.split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) checkReference(file, t.line, url, { pageUrl, requireAbsolutePath: is404, kind: `${t.name} srcset` });
      }
    }
    if (t.name === 'meta' && /^https?:\/\//.test(t.attrs.content ?? '')) {
      checkReference(file, t.line, t.attrs.content, { pageUrl, kind: `meta ${t.attrs.property ?? t.attrs.name}` });
    }
  }

  // images
  for (const t of open.filter((x) => x.name === 'img')) {
    if (t.attrs.alt === undefined) error(name, `line ${t.line}: <img src="${t.attrs.src}"> has no alt attribute`);
    else if (t.attrs.alt.trim() === '' && t.attrs['aria-hidden'] !== 'true') {
      error(name, `line ${t.line}: <img src="${t.attrs.src}"> has empty alt without aria-hidden="true" (mark decorative images explicitly)`);
    } else if (t.attrs.alt.trim() !== '' && /\.(png|jpe?g|webp|gif)$/i.test(t.attrs.alt.trim())) {
      error(name, `line ${t.line}: alt text looks like a file name: "${t.attrs.alt}"`);
    }
    if (!t.attrs.width || !t.attrs.height) error(name, `line ${t.line}: <img src="${t.attrs.src}"> needs width and height (layout shift)`);
    const url = t.attrs.src ? new URL(t.attrs.src, ORIGIN + pageUrl) : null;
    const target = url && url.origin === ORIGIN ? fileForPath(url.pathname) : null;
    if (target && /\.(png|webp)$/.test(target) && t.attrs.width && t.attrs.height) {
      const size = imageSize(target);
      if (size && size.width * Number(t.attrs.height) !== size.height * Number(t.attrs.width)) {
        error(name, `line ${t.line}: width/height ${t.attrs.width}×${t.attrs.height} do not match ${rel(target)} (${size.width}×${size.height})`);
      }
    }
  }

  // inline SVG
  for (const t of open.filter((x) => x.name === 'svg')) {
    if (t.attrs['aria-hidden'] === 'true') continue;
    if (t.attrs.role !== 'img') error(name, `line ${t.line}: inline <svg> needs role="img" and a name, or aria-hidden="true"`);
    else if (!t.attrs['aria-label'] && !t.attrs['aria-labelledby']) error(name, `line ${t.line}: <svg role="img"> has no aria-label/aria-labelledby`);
  }

  // id references
  for (const t of open) {
    for (const attr of REF_ATTRS) {
      if (t.attrs[attr] === undefined) continue;
      for (const id of t.attrs[attr].split(/\s+/).filter(Boolean)) {
        if (!page.ids.has(id)) error(name, `line ${t.line}: ${attr} points at missing id "${id}"`);
      }
    }
    if (t.name === 'a' && t.attrs.href === undefined && t.attrs.id === undefined) error(name, `line ${t.line}: <a> without href`);
  }
}

// ------------------------------------------------------------------------------------------ assets

for (const file of files) {
  const r = rel(file);
  const size = statSync(file).size;
  if (r.startsWith('assets/shots/') && size > MAX_SHOT_BYTES) error(r, `${(size / 1024).toFixed(0)} KB is over the 300 KB limit`);
}

// unused files (not an error: reported so stale outputs are noticed)
const referenced = new Set();
for (const file of textFiles) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/(?:href|src|srcset|content)="([^"]+)"/g)) {
    for (const part of m[1].split(',')) {
      const value = part.trim().split(/\s+/)[0];
      try {
        const url = new URL(value, ORIGIN + servedPath(file));
        const target = url.origin === ORIGIN ? fileForPath(url.pathname) : null;
        if (target) referenced.add(target);
      } catch {
        /* not a URL */
      }
    }
  }
}
for (const file of files) {
  const r = rel(file);
  if (file.endsWith('.html') || ['robots.txt', 'sitemap.xml'].includes(r)) continue;
  if (!referenced.has(file)) notes.push(`not referenced by any page: ${r}`);
}

// ------------------------------------------------------------------------------------------ contrast

function parseColour(value) {
  const v = value.trim();
  let m = v.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  }
  m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const channel = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const css = readFileSync(path.join(SITE, 'assets', 'site.css'), 'utf8');
const block = css.match(/\/\* build:tokens[\s\S]*?\/\* \/build:tokens \*\//);
if (!block) error('assets/site.css', 'build:tokens block missing');
else {
  const [lightPart, darkPart = ''] = block[0].split('@media (prefers-color-scheme: dark)');
  const vars = (part) => Object.fromEntries([...part.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], parseColour(m[2])]));
  const themes = { light: vars(lightPart), dark: vars(darkPart) };
  // [text, background, minimum]; backgrounds with alpha are composited over the page background.
  const PAIRS = [
    ...['bg', 'surface', 'surface-muted'].flatMap((bg) => [
      ['text', bg, 4.5],
      ['text-muted', bg, 4.5],
      ['link', bg, 4.5],
      ['link-hover', bg, 4.5],
    ]),
    ['accent-text', 'accent', 4.5],
    ['accent-text', 'accent-hover', 4.5],
    ['accent-text', 'accent-pressed', 4.5],
    ['warning-text', 'warning-bg', 4.5],
    ['accent', 'bg', 3], // the large hero headline only
    ['focus', 'bg', 3], // focus outline (non-text)
    ['focus', 'surface', 3],
    ['w-text', 'w-sector', 4.5],
    ['w-active-text', 'w-active', 4.5],
    ['w-capsule-text', 'w-capsule', 4.5],
  ];
  for (const [theme, v] of Object.entries(themes)) {
    for (const [fgName, bgName, min] of PAIRS) {
      if (!v[fgName] || !v[bgName] || !v.bg) {
        error('assets/site.css', `${theme}: token --${!v[fgName] ? fgName : bgName} missing`);
        continue;
      }
      const bg = over(v[bgName], v.bg);
      const fg = over(v[fgName], bg);
      const r = ratio(fg, bg);
      if (r < min) error('assets/site.css', `${theme}: --${fgName} on --${bgName} is ${r.toFixed(2)}:1 (needs ${min}:1)`);
    }
  }
}

// ------------------------------------------------------------------------------------------ report

console.log(`checked ${htmlFiles.length} pages, ${textFiles.length} text files, ${files.length} files in site/`);
console.log(`external URLs (${externalSeen.size}, all on the allow-list):`);
for (const [url, file] of [...externalSeen].sort()) console.log(`  ${url}  (${file})`);
for (const note of notes) console.log(`note: ${note}`);
const problems = [...new Set(errors)]; // the attribute check and the text scan can report the same URL
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const e of problems) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('ok');
