#!/usr/bin/env node
/**
 * Verifies the renderer inside the real built Electron app, through
 * desktop-main's ORBITDROP_E2E hooks (no tray, no helper, windows never take
 * focus). Clicks are delivered to pages by Playwright/CDP — no OS input.
 * Outputs are decoded with sharp (sizes, pixels, metadata) and PDFs re-read with
 * pdf-lib; screenshots go to --out (default: a temp dir).
 *
 *   cd apps/desktop && ../../node_modules/.bin/electron-vite build
 *   node apps/desktop/src/renderer/dev/electron-verify.mjs [--out dir] [--prefix name-] [--only picker,crop,background,...]
 *
 * Windows appear briefly (inactive) and are closed at the end.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(appDir, 'package.json'));
const { _electron: electron } = require('@playwright/test');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const args = process.argv.slice(2);
const outDir = args.includes('--out') ? resolve(args[args.indexOf('--out') + 1]) : join(tmpdir(), 'orbitdrop-renderer-verify');
const prefix = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : '';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const want = (name) => !only || only.includes(name);

const results = [];
const problems = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function makePdf(dir) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Title: Nurse Turnover: Retention of the Staff', { x: 54, y: 730, size: 15, font: bold });
  for (let i = 0; i < 38; i += 1) {
    page.drawText(`${i % 9 === 0 ? 'Section ' + (i / 9 + 1) + '. ' : ''}The relationship between leadership and staff retention, line ${i + 1}.`, { x: 54, y: 700 - i * 16, size: 10, font, color: rgb(0.25, 0.27, 0.3) });
  }
  const path = join(dir, 'Page 001.pdf');
  await writeFile(path, await doc.save());
  return path;
}

async function makePhoto(dir, name, width, height, orientation) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b4c8c"/><stop offset="0.6" stop-color="#f08a5d"/><stop offset="1" stop-color="#ffd29d"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${width * 0.68}" cy="${height * 0.5}" r="${height * 0.12}" fill="#fff1d6"/>
    <path d="M0 ${height * 0.7} Q ${width * 0.25} ${height * 0.45} ${width * 0.5} ${height * 0.66} T ${width} ${height * 0.62} V ${height} H 0 Z" fill="#3f3456"/>
    <rect x="${width * 0.08}" y="${height * 0.08}" width="${width * 0.2}" height="${height * 0.08}" rx="${height * 0.02}" fill="#ffffff"/>
  </svg>`;
  const path = join(dir, name);
  let img = sharp(Buffer.from(svg));
  if (name.endsWith('.png')) await img.png().toFile(path);
  else await img.jpeg({ quality: 88 }).withMetadata(orientation ? { orientation } : {}).toFile(path);
  return path;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const userData = await mkdtemp(join(tmpdir(), 'orbitdrop-r-data-'));
  const work = await mkdtemp(join(tmpdir(), 'orbitdrop-r-files-'));
  const pdf = await makePdf(work);
  const photo = await makePhoto(work, 'IMG_2041.jpg', 1600, 1200);
  const png = await makePhoto(work, 'receipt.png', 900, 1200);
  const extra = await makePhoto(work, 'IMG_2042.jpg', 1200, 900);
  const exifPhoto = join(work, 'IMG_EXIF.jpg');
  await sharp(await readFile(photo)).withExif({ IFD0: { Make: 'OrbitDrop', Model: 'Verify', Copyright: 'test' } }).jpeg({ quality: 88 }).toFile(exifPhoto);
  const gif = join(work, 'sticker.gif');
  await sharp({ create: { width: 320, height: 200, channels: 3, background: '#2F5BF6' } }).gif().toFile(gif);

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [appDir],
    cwd: appDir,
    env: { ...process.env, ORBITDROP_E2E: '1', ORBITDROP_USER_DATA_DIR: userData },
    timeout: 60_000,
  });
  const watch = (page) => {
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error' || /Content Security Policy|Refused to/i.test(text)) problems.push(`console ${msg.type()}: ${text.slice(0, 300)}`);
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  };
  app.on('window', watch);
  for (const page of app.windows()) watch(page);

  const hooks = (name, ...a) => app.evaluate(async (_e, [n, x]) => globalThis.__orbitdrop[n](...x), [name, a]);
  const windowOf = async (kind, timeout = 20_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const page of app.windows()) {
        if (page.isClosed()) continue;
        try {
          const ctx = await page.evaluate(() => window.orbit?.getWindowContext());
          if (ctx?.kind === kind) return page;
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`no ${kind} window`);
  };
  const waitClosed = async (page, timeout = 10_000) => {
    const start = Date.now();
    while (!page.isClosed() && Date.now() - start < timeout) await new Promise((r) => setTimeout(r, 100));
    return page.isClosed();
  };
  const jobIds = async () => new Set((await hooks('jobs')).map((j) => j.jobId));
  const waitJob = async (known, actionId, timeout = 90_000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const job = (await hooks('jobs')).find((j) => !known.has(j.jobId) && j.actionId === actionId);
      if (job && ['completed', 'failed', 'cancelled'].includes(job.state)) return job;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`job ${actionId} did not finish`);
  };
  const shot = async (page, name) => {
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(outDir, `${prefix}${name}.png`) });
  };
  const sizeOf = (page) => page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const meta = async (path) => {
    const m = await sharp(path).metadata();
    return { format: m.format, width: m.width, height: m.height, orientation: m.orientation, exif: Boolean(m.exif) };
  };
  /** RGBA of one pixel of an image file. */
  const pixel = async (path, x, y) => {
    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const i = (Math.floor(y) * info.width + Math.floor(x)) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const near = (a, b, tolerance) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tolerance);
  /** Whether any pixel of a short horizontal run is close to `color` (strokes land within a few px of their position). */
  const anyNear = async (path, xs, y, color, tolerance) => {
    for (const x of xs) if (near(await pixel(path, x, y), color, tolerance)) return true;
    return false;
  };
  const range = (from, to, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
  const ACCENT = [242, 85, 44]; // #F2552C, the first annotation colour
  const clickSector = async (page, label) => {
    const sector = page.getByRole('menuitem', { name: label, exact: true });
    await sector.waitFor({ state: 'visible' });
    const box = await sector.locator('path').first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  const openTool = async (file, label) => {
    await hooks('openPicker', [file], 'tools');
    const picker = await windowOf('picker');
    await clickSector(picker, label);
    const editor = await windowOf('editor');
    await editor.locator('.editor-view').waitFor();
    return { picker, editor };
  };

  try {
    // 1. PDF → JPG from the picker wheel
    if (want('picker')) {
      const known = await jobIds();
      await hooks('openPicker', [pdf], 'convert');
      const picker = await windowOf('picker');
      await picker.getByRole('menu', { name: '변환 메뉴' }).waitFor();
      const labels = await picker.getByRole('menuitem').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
      check('picker: PDF convert menu order DOCX, JPG, PNG, TXT', JSON.stringify(labels) === JSON.stringify(['DOCX', 'JPG', 'PNG', 'TXT']), JSON.stringify(labels));
      const box = await picker.getByRole('menuitem', { name: 'JPG', exact: true }).locator('path').boundingBox();
      await picker.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const fit = await picker.evaluate(() => {
        const r = document.querySelector('.view').getBoundingClientRect();
        return { w: innerWidth, h: innerHeight, cw: Math.ceil(r.width), ch: Math.ceil(r.height) };
      });
      check('picker: window sized to its content', Math.abs(fit.w - fit.cw) <= 1 && Math.abs(fit.h - fit.ch) <= 1, JSON.stringify(fit));
      await shot(picker, 'picker-pdf');
      await picker.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      check('picker: closes after submit', await waitClosed(picker));
      const job = await waitJob(known, 'convert.jpeg');
      const m = await meta(join(work, 'Page 001.jpg'));
      check('PDF → JPG output', job.state === 'completed' && m.format === 'jpeg', `${job.state} ${m.width}×${m.height}`);
    }

    // 2. Crop 1:1 (keyboard in the picker this time)
    if (want('crop')) {
      const page001 = join(work, 'Page 001.jpg');
      const known = await jobIds();
      await hooks('openPicker', [page001], 'tools');
      const picker = await windowOf('picker');
      const menu = picker.getByRole('menu', { name: '도구 메뉴' });
      await menu.waitFor();
      await shot(picker, 'picker-tools');
      await menu.focus();
      await picker.keyboard.press('End');
      await picker.keyboard.press('ArrowLeft'); // CROP
      // Enter submits; main may close the picker before the key-up arrives.
      await picker.keyboard.press('Enter').catch(() => undefined);
      const editor = await windowOf('editor');
      const opened = await editor.evaluate(async () => {
        const ctx = await window.orbit.getWindowContext();
        return ctx.kind === 'editor' ? (await window.orbit.getEditor(ctx.editorId)).actionId : ctx.kind;
      });
      check('picker: keyboard (End, ArrowLeft, Enter) opens Crop', opened === 'tool.crop', opened);
      await editor.getByRole('radio', { name: '1:1', exact: true }).click();
      await editor.waitForFunction(() => document.querySelector('.stage-canvas img')?.complete === true);
      const w = await editor.getByLabel('너비').inputValue();
      check('crop: 1:1 fills the page width', w === String((await meta(page001)).width), `W=${w}`);
      await shot(editor, 'crop');
      check('crop: editor width 520', (await sizeOf(editor)).w === 520, JSON.stringify(await sizeOf(editor)));
      await editor.locator('.btn-primary').click();
      check('crop: editor closes on Apply', await waitClosed(editor));
      const job = await waitJob(known, 'tool.crop');
      const cropped = join(work, 'Page 001 Cropped.jpg');
      const m = await meta(cropped);
      const page = await meta(page001);
      // 1:1 is the centred square of the page: output (x, y) is page (x, y + offset).
      const offset = Math.round((page.height - m.height) / 2);
      const points = [[m.width / 2, 200], [m.width / 2, 900], [120, m.height - 60]];
      const matches = [];
      for (const [x, y] of points) matches.push(near(await pixel(cropped, x, y), await pixel(page001, x, y + offset), 16));
      check(
        'crop output: 2550×2550, the centred square of the page (pixels match)',
        job.state === 'completed' && m.width === 2550 && m.height === 2550 && matches.every(Boolean),
        `${job.state} ${m.width}×${m.height} offset=${offset} ${JSON.stringify(matches)}`,
      );
    }

    // 3. Add Background
    if (want('background')) {
      const src = join(work, (await readdir(work)).includes('Page 001 Cropped.jpg') ? 'Page 001 Cropped.jpg' : 'IMG_2041.jpg');
      const known = await jobIds();
      const { editor } = await openTool(src, '배경 추가');
      await editor.locator('img[alt="처리 결과 미리보기"]').waitFor({ timeout: 30_000 });
      const src1 = await editor.locator('img[alt="처리 결과 미리보기"]').getAttribute('src');
      check('add bg: processor preview via orbit-preview://', (src1 ?? '').startsWith('orbit-preview://'), src1 ?? '');
      await shot(editor, 'add-background');
      await editor.getByRole('radio', { name: '16:9', exact: true }).click();
      await editor.getByText('선택한 비율에 맞추느라').waitFor({ timeout: 15_000 });
      await editor.waitForFunction((prev) => document.querySelector('img[alt="처리 결과 미리보기"]')?.getAttribute('src') !== prev, src1, { timeout: 15_000 });
      await shot(editor, 'add-background-16x9');
      const out = await editor.locator('.editor-meta strong').first().textContent();
      check('add bg: output size shown', /출력 \d+ × \d+ px/.test(out ?? ''), out ?? '');
      await editor.locator('.btn-primary').click();
      check('add bg: editor closes on save', await waitClosed(editor));
      const job = await waitJob(known, 'tool.addBackground');
      const name = job.outputs[0]?.name ?? '';
      const m = await meta(join(work, name));
      check('add bg output PNG 16:9', job.state === 'completed' && m.format === 'png' && Math.abs(m.width / m.height - 16 / 9) < 0.01, `${name} ${m.width}×${m.height}`);
    }

    // 4. P1 editors
    if (want('compress')) {
      const known = await jobIds();
      const { editor } = await openTool(photo, '압축');
      await editor.getByText('예상').first().waitFor();
      await editor.waitForFunction(() => /KB|MB/.test(document.body.innerText.split('예상')[1] ?? ''), null, { timeout: 30_000 });
      await shot(editor, 'compress');
      await editor.locator('.btn-primary').click();
      await editor.getByText('압축 결과').waitFor({ timeout: 30_000 }).catch(() => undefined);
      const job = await waitJob(known, 'tool.compress');
      await editor.waitForTimeout(600);
      await shot(editor, 'compress-result');
      check('compress: job completed, result view shown', job.state === 'completed' && !editor.isClosed(), job.state);
      await editor.keyboard.press('Escape').catch(() => undefined);
      check('compress: result view closes with Esc', await waitClosed(editor));
    }
    if (want('metadata')) {
      const known = await jobIds();
      const { editor } = await openTool(exifPhoto, '메타데이터');
      await editor.getByText('파일 크기').waitFor({ timeout: 20_000 });
      const shown = await editor.getByText('OrbitDrop Verify').count();
      await shot(editor, 'metadata');
      await editor.getByRole('button', { name: '메타데이터 제거' }).click();
      const job = await waitJob(known, 'tool.metadata');
      const before = await meta(exifPhoto);
      const after = await meta(join(work, job.outputs[0]?.name ?? 'missing'));
      check(
        'metadata: inspected EXIF shown; strip writes a copy without EXIF, same size',
        shown > 0 && job.state === 'completed' && before.exif && !after.exif && after.width === before.width && after.height === before.height,
        `camera shown=${shown} ${job.state} exif ${before.exif}→${after.exif} ${after.width}×${after.height}`,
      );
    }
    if (want('edit')) {
      const known = await jobIds();
      const { editor } = await openTool(photo, '편집');
      await editor.getByRole('button', { name: '오른쪽으로 90° 회전' }).click();
      await editor.waitForTimeout(900);
      await shot(editor, 'edit');
      await editor.locator('.btn-primary').click();
      const job = await waitJob(known, 'tool.edit');
      const m = await meta(join(work, job.outputs[0]?.name ?? 'missing'));
      check('edit: rotate 90 → 1200×1600', job.state === 'completed' && m.width === 1200 && m.height === 1600, `${m.width}×${m.height}`);
    }
    if (want('annotate')) {
      const known = await jobIds();
      const { editor } = await openTool(photo, '주석');
      await editor.waitForFunction(() => document.querySelector('.stage-canvas img')?.complete === true);
      const canvas = editor.locator('.stage-canvas').first();
      const box = await canvas.boundingBox();
      await editor.getByRole('radio', { name: '사각형' }).click();
      await editor.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.5);
      await editor.mouse.down();
      await editor.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.8, { steps: 5 });
      await editor.mouse.up();
      await editor.getByRole('radio', { name: '텍스트' }).click();
      await editor.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.12);
      await editor.keyboard.type('한글 주석 테스트');
      await editor.keyboard.press('Enter');
      // Closing with unsaved annotations asks first (in-window); Esc keeps editing.
      await editor.getByRole('button', { name: '취소하고 닫기' }).click();
      const dialog = editor.getByRole('alertdialog', { name: '저장하지 않고 닫을까요?' });
      const asked = await dialog.waitFor({ timeout: 5000 }).then(() => true, () => false);
      await shot(editor, 'annotate-unsaved');
      await editor.keyboard.press('Escape');
      const kept = (await dialog.count()) === 0 && !editor.isClosed();
      check('annotate: closing with unsaved shapes asks in the window; Esc keeps editing', asked && kept, `asked=${asked} kept=${kept}`);
      await shot(editor, 'annotate');
      await editor.locator('.btn-primary').click();
      const job = await waitJob(known, 'tool.annotate');
      const out = join(work, job.outputs[0]?.name ?? 'missing');
      const m = await meta(out);
      // The rectangle's left edge runs along x = 10 % of the image, from 50 % to 80 % of its height.
      const edge = await anyNear(out, range(150, 172, 2), 780, ACCENT, 48);
      const untouched = near(await pixel(out, 1400, 300), await pixel(photo, 1400, 300), 18);
      check(
        'annotate: saved 1600×1200 with the rectangle drawn in the accent colour, the rest unchanged',
        job.state === 'completed' && m.width === 1600 && m.height === 1200 && edge && untouched,
        `${job.state} ${m.width}×${m.height} edge=${edge} untouched=${untouched}`,
      );
    }
    if (want('annotate-keys')) {
      // Keyboard only: "사각형 추가" inserts a centred rectangle; arrows move it, Option+arrows resize it.
      const known = await jobIds();
      const { editor } = await openTool(extra, '주석');
      await editor.waitForFunction(() => document.querySelector('.stage-canvas img')?.complete === true);
      await editor.getByRole('button', { name: '사각형 추가' }).click();
      const focused = await editor.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      for (let i = 0; i < 10; i += 1) await editor.keyboard.press('ArrowRight');
      await editor.keyboard.press('Alt+ArrowDown');
      await shot(editor, 'annotate-keyboard');
      await editor.locator('.btn-primary').click();
      const job = await waitJob(known, 'tool.annotate');
      const out = join(work, job.outputs[0]?.name ?? 'missing');
      // 1200×900 shown at 464×348 (3 px per key): the left edge moves from ≈ 412 to ≈ 442.
      const moved = await anyNear(out, range(430, 456, 2), 450, ACCENT, 48);
      const notAtStart = !(await anyNear(out, range(404, 418, 2), 450, ACCENT, 48));
      check('annotate (keyboard): inserted rectangle moved by the arrow keys is in the saved image', focused === '주석 캔버스' && job.state === 'completed' && moved && notAtStart, `focus=${focused} ${job.state} moved=${moved} oldEdgeClear=${notAtStart}`);
    }
    if (want('redact')) {
      const known = await jobIds();
      const { editor } = await openTool(photo, '가리기');
      const canvas = editor.locator('.stage-canvas').first();
      await canvas.waitFor();
      const box = await canvas.boundingBox();
      await editor.mouse.move(box.x + box.width * 0.08, box.y + box.height * 0.08);
      await editor.mouse.down();
      await editor.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.17, { steps: 5 });
      await editor.mouse.up();
      await editor.locator('img[alt="처리 결과 미리보기"]').waitFor({ timeout: 20_000 }).catch(() => undefined);
      await shot(editor, 'redact');
      await editor.locator('.btn-primary').click();
      const job = await waitJob(known, 'tool.redact');
      const out = join(work, job.outputs[0]?.name ?? 'missing');
      const m = await meta(out);
      // The region spans 8–30 % × 8–17 % of the image: its centre is solid black, far away nothing changed.
      const inside = await pixel(out, 1600 * 0.19, 1200 * 0.125);
      const outside = near(await pixel(out, 1400, 1000), await pixel(photo, 1400, 1000), 18);
      check(
        'redact: saved 1600×1200, the region is solid black, the rest unchanged',
        job.state === 'completed' && m.width === 1600 && m.height === 1200 && near(inside, [0, 0, 0], 12) && outside,
        `${job.state} ${m.width}×${m.height} inside=${inside.slice(0, 3)} outsideSame=${outside}`,
      );
    }
    if (want('pdf')) {
      const known = await jobIds();
      await hooks('openPicker', [photo, extra, png], 'convert');
      const picker = await windowOf('picker');
      await clickSector(picker, 'PDF');
      const editor = await windowOf('editor');
      await editor.getByText('페이지 순서').waitFor();
      // Each row gets a small thumbnail over orbit-preview:// (fitted into its 40 px box).
      const thumbs = await editor
        .waitForFunction(
          () => {
            const imgs = [...document.querySelectorAll('.pdf-thumb img')];
            return imgs.length >= 3 && imgs.every((img) => img.complete && img.naturalWidth > 0) ? imgs.map((img) => ({ src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight })) : null;
          },
          null,
          { timeout: 20_000 },
        )
        .then((handle) => handle.jsonValue(), () => []);
      check(
        'images → PDF order: a thumbnail per file over orbit-preview://, at most 160 px',
        thumbs.length === 3 && thumbs.every((t) => t.src.startsWith('orbit-preview://') && Math.max(t.w, t.h) <= 160),
        JSON.stringify(thumbs.map((t) => [t.w, t.h])),
      );
      await shot(editor, 'pdf-order');
      await editor.locator('.btn-primary').click();
      const job = await waitJob(known, 'convert.pdf');
      let pages = [];
      try {
        const doc = await PDFDocument.load(await readFile(join(work, job.outputs[0]?.name ?? 'missing')));
        pages = doc.getPages().map((page) => Math.round((page.getWidth() / page.getHeight()) * 100) / 100);
      } catch {
        pages = [];
      }
      // Files in selection order: 1600×1200, 1200×900 (4:3) and 900×1200 (3:4), one page each, at the image size.
      check('images → PDF: 3 pages in order with the images’ proportions', job.state === 'completed' && JSON.stringify(pages) === JSON.stringify([1.33, 1.33, 0.75]), `${job.state} pages=${JSON.stringify(pages)} ${JSON.stringify(job.error)}`);
    }
    if (want('compress-batch')) {
      // Several files: a real per-file estimate (an actual encode) for each, then the final sizes.
      const known = await jobIds();
      await hooks('openPicker', [photo, extra, png], 'tools');
      const picker = await windowOf('picker');
      await clickSector(picker, '압축');
      const batch = await windowOf('editor');
      const estimates = await batch
        .waitForFunction(
          () => {
            const rows = [...document.querySelectorAll('.compress-estimate')];
            return rows.length === 3 && rows.every((row) => !row.hasAttribute('data-pending') && /KB|MB/.test(row.textContent ?? '')) ? rows.map((row) => row.textContent) : null;
          },
          null,
          { timeout: 60_000 },
        )
        .then((handle) => handle.jsonValue(), () => []);
      const totals = await batch.locator('.compress-sizes').first().textContent();
      await shot(batch, 'compress-batch');
      check('compress (3 files): an estimate per file and totals', estimates.length === 3 && /원본 합계/.test(totals ?? '') && /예상 합계/.test(totals ?? ''), `${JSON.stringify(estimates)} ${totals}`);
      await batch.locator('.btn-primary').click();
      await batch.getByText('압축 결과').waitFor({ timeout: 30_000 });
      const jobs = [];
      for (let i = 0; i < 3; i += 1) jobs.push(await waitJob(new Set([...known, ...jobs.map((j) => j.jobId)]), 'tool.compress'));
      const sizes = await Promise.all(jobs.map(async (j) => (await stat(join(work, j.outputs[0]?.name ?? 'missing')).catch(() => ({ size: -1 }))).size));
      const total = await batch.getByText(/합계 .* → /).waitFor({ timeout: 10_000 }).then(() => true, () => false);
      await shot(batch, 'compress-batch-results');
      check(
        'compress (3 files): every job completed, outputs on disk match their reported sizes, total shown',
        jobs.every((j, i) => j.state === 'completed' && j.outputs[0]?.bytes === sizes[i]) && total,
        `${jobs.map((j) => j.state)} sizes=${sizes} total=${total}`,
      );
      await batch.keyboard.press('Escape').catch(() => undefined);
      await waitClosed(batch);
    }
    if (want('format')) {
      // 'Keep input format' on a GIF: the processor reports PNG and the editor says so.
      const { editor } = await openTool(gif, '압축');
      const note = await editor.getByText('원본 형식으로 저장하면 GIF 파일은 PNG로 저장됩니다.').waitFor({ timeout: 20_000 }).then(() => true, () => false);
      await shot(editor, 'compress-gif');
      check('compress: “original format” on a GIF is explained as PNG', note);
      await editor.keyboard.press('Escape').catch(() => undefined);
      await waitClosed(editor);
    }

    // 5. Other windows
    for (const kind of ['jobs', 'settings', 'dropzone', 'about', 'welcome']) {
      if (!want(kind)) continue;
      await hooks('openWindow', kind);
      const page = await windowOf(kind);
      await page.locator('.view').first().waitFor();
      await page.waitForTimeout(500);
      await shot(page, kind);
      const content = {
        jobs: async () => {
          const cards = await page.locator('li.job-card').count();
          const listed = (await hooks('jobs')).length;
          return [cards > 0 && cards === Math.min(listed, 200), `${cards} cards / ${listed} jobs`];
        },
        settings: async () => {
          const tabs = await page.getByRole('tab').count();
          return [tabs === 6, `${tabs} tabs`];
        },
        dropzone: async () => [(await page.getByText('파일을 여기에 놓으세요').count()) > 0, 'prompt'],
        about: async () => {
          const info = await page.evaluate(() => window.orbit.getAppInfo());
          return [(await page.getByText(`버전 ${info.version}`).count()) > 0, `version ${info.version}`];
        },
        // First-run welcome (automation never opens it by itself): heading and the platform's tools keys.
        welcome: async () => {
          const heading = await page.getByRole('heading', { name: 'OrbitDrop에 오신 것을 환영합니다' }).count();
          const keys = await page.locator('.welcome-key-row dt').allTextContents();
          return [heading > 0 && keys.length === 2, `keys ${JSON.stringify(keys)}`];
        },
      };
      const [ok, detail] = await content[kind]();
      check(`${kind}: window shows its content`, ok, `${detail} ${JSON.stringify(await sizeOf(page))}`);
      if (kind === 'jobs') {
        // Retry: a job made to time out (E2E fault hook) runs again from its card, through the real processors.
        await hooks('failNextJobs', ['TIMEOUT']);
        const submitted = await hooks('submit', [extra], 'convert.webp');
        const failedJob = await hooks('waitForJob', submitted.jobIds[0]);
        const known = await jobIds();
        const card = page.locator('li.job-card').filter({ hasText: 'IMG_2042.jpg' }).filter({ has: page.locator('.job-state', { hasText: '실패' }) });
        await card.getByRole('button', { name: '다시 시도' }).click();
        const retried = await waitJob(known, 'convert.webp');
        const webp = await meta(join(work, 'IMG_2042.webp'));
        await shot(page, 'jobs-retried');
        check(
          'jobs: a timed-out job is retried from its card → real WebP 1200×900',
          failedJob.state === 'failed' && failedJob.error?.code === 'TIMEOUT' && retried.state === 'completed' && webp.format === 'webp' && webp.width === 1200 && webp.height === 900,
          `${failedJob.state}/${failedJob.error?.code} → ${retried.state} ${webp.format} ${webp.width}×${webp.height}`,
        );
        // Clear finished: the list empties, every output file stays on disk.
        const outputs = (await hooks('jobs')).flatMap((j) => j.outputs.map((o) => o.name));
        await page.getByRole('button', { name: '끝난 작업 지우기' }).click();
        const emptied = await page.getByText('아직 작업이 없습니다.').waitFor({ timeout: 5000 }).then(() => true, () => false);
        const files = await readdir(work);
        const left = (await hooks('jobs')).length;
        await shot(page, 'jobs-cleared');
        check('jobs: “clear finished” empties the list; all output files stay', emptied && left === 0 && outputs.length > 0 && outputs.every((name) => files.includes(name)), `jobs left=${left} outputs=${outputs.length} kept=${outputs.filter((n) => files.includes(n)).length}`);
      }
      if (kind === 'dropzone') {
        // A File that is not on disk: preload finds no path, main is never asked, the UI explains it.
        await page.evaluate(() => {
          const target = document.querySelector('.dropzone-view');
          const dt = new DataTransfer();
          dt.items.add(new File(['x'], 'memory.jpg', { type: 'image/jpeg' }));
          for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        });
        const shown = await page.getByText('실제 파일이 아닌 항목은 바로 처리할 수 없습니다', { exact: false }).waitFor({ timeout: 5000 }).then(() => true, () => false);
        check('dropzone: in-memory File → localized VIRTUAL_FILE via preload', shown);
      }
      if (kind === 'settings') {
        await page.getByRole('radio', { name: 'English' }).click();
        const english = await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 5000 }).then(() => true, () => false);
        const persisted = (await hooks('updateSettings', {}))?.locale;
        check('settings: language switch applies live and persists in main', english && persisted === 'en', `persisted=${persisted}`);
        await page.getByRole('radio', { name: '한국어' }).click();
        await page.getByRole('heading', { name: '설정' }).waitFor({ timeout: 5000 }).catch(() => undefined);
        // The wheel-size preview follows the slider at once; the value is saved (debounced).
        await page.getByRole('tab', { name: '드래그' }).click();
        const preview = page.locator('svg[data-diameter]');
        const before = Number(await preview.getAttribute('data-diameter'));
        await page.getByRole('slider', { name: '휠 크기' }).focus();
        for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight');
        const live = Number(await preview.getAttribute('data-diameter'));
        await page.waitForTimeout(500);
        const saved = (await hooks('updateSettings', {}))?.globalDrag?.wheelDiameter;
        await shot(page, 'settings-wheel-preview');
        check('settings: wheel preview follows the slider live and the size is saved', live === before + 5 && saved === before + 5, `${before} → live ${live}, saved ${saved}`);
        // High contrast while the OS is dark: the dark high-contrast token set (white on black).
        await page.getByRole('tab', { name: '접근성' }).click();
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.getByRole('radiogroup', { name: '고대비' }).getByRole('radio', { name: '켜기' }).click();
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'highContrastDark', null, { timeout: 5000 }).catch(() => undefined);
        const theme = await page.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color]);
        await shot(page, 'settings-hc-dark');
        check('settings: high contrast in dark mode uses the dark high-contrast set', theme[0] === 'highContrastDark' && theme[1] === 'rgb(0, 0, 0)' && theme[2] === 'rgb(255, 255, 255)', theme.join(' '));
        await page.getByRole('radiogroup', { name: '고대비' }).getByRole('radio', { name: '시스템 설정 따름' }).click();
        await page.emulateMedia({ colorScheme: null });
      }
      await page.evaluate(() => window.orbit.closeWindow());
    }
  } catch (error) {
    check('script', false, error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    await app.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(problems.length ? `renderer console problems (${problems.length}):\n  ${problems.join('\n  ')}` : 'no renderer console errors / CSP violations');
  process.exit(failed.length ? 1 : 0);
}

main();
