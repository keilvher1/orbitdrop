import '../zod-jitless';
import '../styles/base.css';
import './harness.css';
import { bootstrap } from '../app/bootstrap';
import { createMockOrbit, scenarioFromQuery } from './mockOrbit';

/**
 * DEV HARNESS entry (src/renderer/dev/index.html): renders any renderer view
 * against the mock OrbitApi in a normal browser.
 *   /dev/index.html                              → gallery of scenarios
 *   /dev/index.html?view=picker&menu=jpg&mode=tools
 *   /dev/index.html?view=editor&tool=crop        (crop, addBackground, compress, metadata, edit, annotate, redact, pdf)
 *   /dev/index.html?view=jobs | settings | dropzone | about   (&update=idle|checking|downloading|downloaded|upToDate|error|unsupported)
 * Common: lang=ko|en, platform=darwin|win32, helper=<HelperStatus state>,
 * rm / hc = system|on|off, latency=<ms>, shot=1 (no toasts, for screenshots).
 */

const GALLERY: readonly { readonly group: string; readonly links: readonly (readonly [string, string])[] }[] = [
  {
    group: 'Picker',
    links: [
      ['PDF · convert', 'view=picker&menu=pdf&mode=convert'],
      ['JPG · convert', 'view=picker&menu=jpg&mode=convert'],
      ['JPG · tools', 'view=picker&menu=jpg&mode=tools'],
      ['3 images (batch)', 'view=picker&menu=images&mode=tools'],
      ['PDF + image', 'view=picker&menu=mixed'],
      ['Unsupported', 'view=picker&menu=unsupported'],
      ['JPG · tools · English', 'view=picker&menu=jpg&mode=tools&lang=en'],
    ],
  },
  {
    group: 'Editors',
    links: [
      ['Crop', 'view=editor&tool=crop'],
      ['Add Background', 'view=editor&tool=addBackground'],
      ['Compress', 'view=editor&tool=compress'],
      ['Compress (PNG, not smaller)', 'view=editor&tool=compress&image=logo'],
      ['Metadata', 'view=editor&tool=metadata'],
      ['Edit', 'view=editor&tool=edit'],
      ['Annotate', 'view=editor&tool=annotate'],
      ['Redact', 'view=editor&tool=redact'],
      ['Images → PDF order', 'view=editor&tool=pdf'],
    ],
  },
  {
    group: 'Windows',
    links: [
      ['Jobs', 'view=jobs'],
      ['Jobs (empty)', 'view=jobs&jobs=empty'],
      ['Settings', 'view=settings'],
      ['Settings (needs permission)', 'view=settings&helper=needsPermission'],
      ['Drop Zone', 'view=dropzone'],
      ['About', 'view=about'],
      ['About (update downloaded)', 'view=about&update=downloaded'],
      ['About (update: development build)', 'view=about&update=unsupported'],
    ],
  },
];

function renderGallery(root: HTMLElement): void {
  document.title = 'OrbitDrop dev harness';
  const wrap = document.createElement('main');
  wrap.className = 'harness-gallery';
  const h1 = document.createElement('h1');
  h1.textContent = 'OrbitDrop renderer — dev harness (mock OrbitApi)';
  wrap.append(h1);
  for (const section of GALLERY) {
    const h2 = document.createElement('h2');
    h2.textContent = section.group;
    const ul = document.createElement('ul');
    for (const [label, query] of section.links) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `?${query}`;
      a.textContent = label;
      const dark = document.createElement('a');
      dark.href = `?${query}&lang=en`;
      dark.textContent = 'en';
      dark.className = 'harness-alt';
      li.append(a, ' ', dark);
      ul.append(li);
    }
    wrap.append(h2, ul);
  }
  root.append(wrap);
}

function installToasts(): void {
  const host = document.createElement('div');
  host.className = 'harness-toasts';
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  window.addEventListener('orbit-mock', (event) => {
    const toast = document.createElement('div');
    toast.className = 'harness-toast';
    toast.textContent = String((event as CustomEvent<string>).detail);
    host.append(toast);
    setTimeout(() => toast.remove(), 2600);
  });
}

/**
 * Headless browsers report screen.availHeight = viewport height, which would
 * make editors shrink their stage every time the screenshot viewport is fitted.
 * Pin a laptop-sized work area (override with ?screenH=).
 */
function pinScreenHeight(): void {
  const height = Number(new URLSearchParams(window.location.search).get('screenH') ?? 1000) || 1000;
  try {
    Object.defineProperty(window.screen, 'availHeight', { configurable: true, get: () => height });
  } catch {
    // Read-only in some browsers; the harness still works, only sizing differs.
  }
}

const root = document.getElementById('root');
if (root !== null) {
  pinScreenHeight();
  const scenario = scenarioFromQuery(window.location.search);
  if (scenario === null) {
    renderGallery(root);
  } else {
    document.title = `OrbitDrop · ${scenario.view}`;
    if (new URLSearchParams(window.location.search).get('shot') !== '1') installToasts();
    void bootstrap(root, createMockOrbit(scenario));
  }
}
