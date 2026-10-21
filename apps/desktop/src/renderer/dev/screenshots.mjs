#!/usr/bin/env node
/**
 * Renderer screenshots from the dev harness (mock OrbitApi) with Playwright's
 * bundled headless Chromium — no Electron windows, no OS input.
 *
 *   node apps/desktop/src/renderer/dev/screenshots.mjs                 # official set → docs/screenshots
 *   node apps/desktop/src/renderer/dev/screenshots.mjs --out <dir> --only crop,picker-tools
 *   node apps/desktop/src/renderer/dev/screenshots.mjs --url http://127.0.0.1:5199   # reuse a running server
 *
 * The viewport is set to the size the view asked for via orbit.resizeWindow()
 * (or main's default window size for resizable windows), so each image shows
 * exactly what the window would contain.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../../..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

/** name → query, default size for windows that don't call resizeWindow, optional interaction. */
export const SHOTS = [
  { name: 'picker-convert-pdf', query: 'view=picker&menu=pdf&mode=convert', hover: 'convert.jpeg' },
  { name: 'picker-tools', query: 'view=picker&menu=jpg&mode=tools', hover: 'tool.crop' },
  { name: 'picker-convert-jpg', query: 'view=picker&menu=jpg&mode=convert', hover: 'convert.heic' },
  { name: 'crop', query: 'view=editor&tool=crop', crop: true },
  { name: 'add-background', query: 'view=editor&tool=addBackground' },
  { name: 'jobs', query: 'view=jobs', size: { width: 460, height: 640 } },
  { name: 'settings', query: 'view=settings', size: { width: 560, height: 640 }, tab: 'output' },
  { name: 'settings-drag', query: 'view=settings&helper=needsPermission', size: { width: 560, height: 700 }, tab: 'drag' },
  { name: 'dropzone', query: 'view=dropzone' },
  { name: 'compress', query: 'view=editor&tool=compress' },
  { name: 'metadata', query: 'view=editor&tool=metadata' },
  { name: 'edit', query: 'view=editor&tool=edit' },
  { name: 'annotate', query: 'view=editor&tool=annotate', annotate: true },
  { name: 'redact', query: 'view=editor&tool=redact', redact: true },
  { name: 'pdf-order', query: 'view=editor&tool=pdf' },
  { name: 'about', query: 'view=about' },
  { name: 'picker-tools-dark', query: 'view=picker&menu=jpg&mode=tools', hover: 'tool.addBackground', colorScheme: 'dark' },
  { name: 'picker-tools-en-hc', query: 'view=picker&menu=jpg&mode=tools&lang=en&hc=on', hover: 'tool.redact' },
];

/** Drag inside an element, in fractions of its box (page-level mouse events via CDP, not OS input). */
async function dragIn(page, locator, from, to) {
  const box = await locator.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 6 });
  await page.mouse.up();
}

async function drawAnnotations(page) {
  const canvas = page.locator('.stage-canvas').first();
  await page.getByRole('radio', { name: '사각형' }).click();
  await dragIn(page, canvas, [0.06, 0.4], [0.3, 0.66]);
  await page.getByRole('radio', { name: '화살표' }).click();
  await dragIn(page, canvas, [0.62, 0.2], [0.42, 0.42]);
  await page.getByRole('radio', { name: '텍스트' }).click();
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.1);
    await page.keyboard.type('여기서 일몰 감상!');
    await page.keyboard.press('Enter');
  }
  await page.getByRole('radio', { name: '선택' }).click();
}

async function drawRedactions(page) {
  const canvas = page.locator('.stage-canvas').first();
  await dragIn(page, canvas, [0.08, 0.44], [0.27, 0.53]);
  await dragIn(page, canvas, [0.55, 0.62], [0.9, 0.9]);
  // The second (selected) region becomes a mosaic; the first stays a solid box.
  await page.getByRole('radio', { name: '모자이크' }).first().click();
}

/** Fit the viewport to the size the view last requested via orbit.resizeWindow (repeat until stable). */
async function fitViewport(page, fixed) {
  let requested = null;
  for (let i = 0; i < 6; i += 1) {
    const next = await page.evaluate(() => window.__orbitMockSize ?? null);
    if (!next || fixed) break;
    if (requested && next.width === requested.width && next.height === requested.height) break;
    requested = next;
    await page.setViewportSize({ width: next.width, height: next.height });
    await page.waitForTimeout(350);
  }
  return requested;
}

async function startServer() {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: resolve(here, 'vite.config.mts'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'warn' });
  await server.listen();
  const address = server.httpServer.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function main() {
  const out = resolve(repo, arg('out', 'docs/screenshots'));
  const prefix = arg('prefix', 'desktop-renderer-');
  const only = arg('only', '')?.split(',').filter(Boolean) ?? [];
  await mkdir(out, { recursive: true });
  let server = null;
  let base = arg('url', null);
  if (!base) ({ server, base } = await startServer());
  const browser = await chromium.launch({ headless: true });
  try {
    for (const shot of SHOTS) {
      if (only.length && !only.includes(shot.name)) continue;
      const context = await browser.newContext({
        viewport: shot.size ?? { width: 600, height: 760 },
        // A 16" MacBook Pro work area, so editors size their stage like on a real display.
        screen: { width: 1728, height: 1117 },
        deviceScaleFactor: 2,
        colorScheme: shot.colorScheme ?? 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => console.error(`[${shot.name}] page error:`, error.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.error(`[${shot.name}] console:`, msg.text());
      });
      await page.goto(`${base}/dev/index.html?${shot.query}&shot=1`);
      await page.waitForSelector('.view', { timeout: 15000 });
      await page.waitForTimeout(700);
      if (shot.tab) {
        await page.getByRole('tab').nth(['general', 'output', 'drag', 'processing', 'accessibility', 'about'].indexOf(shot.tab)).click();
        await page.waitForTimeout(300);
      }
      // Size the viewport to what the view requested from main.
      let requested = await fitViewport(page, shot.size);
      if (shot.hover) {
        const sector = page.locator(`[data-action="${shot.hover}"] > path`);
        const box = await sector.boundingBox();
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      }
      if (shot.annotate) await drawAnnotations(page);
      if (shot.redact) await drawRedactions(page);
      if (shot.crop) {
        // 1:1 like the reference recording.
        await page.getByRole('radio', { name: '1:1' }).click();
      }
      await page.waitForTimeout(500);
      if (shot.annotate || shot.redact || shot.crop) requested = (await fitViewport(page, shot.size)) ?? requested;
      const file = resolve(out, `${prefix}${shot.name}.png`);
      await page.screenshot({ path: file, fullPage: !requested });
      console.log('saved', file, requested ? `${requested.width}x${requested.height}` : 'full page');
      await context.close();
    }
  } finally {
    await browser.close();
    if (server) await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
