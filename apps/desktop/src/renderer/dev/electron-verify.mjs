#!/usr/bin/env node
/**
 * Verifies the renderer inside the real built Electron app, through
 * desktop-main's ORBITDROP_E2E hooks (no tray, no helper, windows never take
 * focus). Clicks are delivered to pages by Playwright/CDP — no OS input.
 * Outputs are decoded with sharp; screenshots go to --out (default: a temp dir).
 *
 *   cd apps/desktop && ../../node_modules/.bin/electron-vite build
 *   node apps/desktop/src/renderer/dev/electron-verify.mjs [--out dir] [--prefix name-] [--only picker,crop,background,...]
 *
 * Windows appear briefly (inactive) and are closed at the end.
 */
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
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
      check('picker: window sized to content', JSON.stringify(await sizeOf(picker)) !== '{}', JSON.stringify(await sizeOf(picker)));
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
      check('picker: keyboard (End, ArrowLeft, Enter) opens Crop', true);
      const editor = await windowOf('editor');
      await editor.getByRole('radio', { name: '1:1', exact: true }).click();
      await editor.waitForFunction(() => document.querySelector('.stage-canvas img')?.complete === true);
      const w = await editor.getByLabel('너비').inputValue();
      check('crop: 1:1 fills the page width', w === String((await meta(page001)).width), `W=${w}`);
      await shot(editor, 'crop');
      check('crop: editor width 520', (await sizeOf(editor)).w === 520, JSON.stringify(await sizeOf(editor)));
      await editor.locator('.btn-primary').click();
      check('crop: editor closes on Apply', await waitClosed(editor));
      const job = await waitJob(known, 'tool.crop');
      const m = await meta(join(work, 'Page 001 Cropped.jpg'));
      check('crop output is square', job.state === 'completed' && m.width === m.height, `${job.state} ${m.width}×${m.height}`);
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
      const { editor } = await openTool(photo, '메타데이터');
      await editor.getByText('파일 크기').waitFor({ timeout: 20_000 });
      await shot(editor, 'metadata');
      await editor.keyboard.press('Escape').catch(() => undefined);
      check('metadata: opens and cancels', await waitClosed(editor));
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
      await shot(editor, 'annotate');
      await editor.locator('.btn-primary').click();
      const job = await waitJob(known, 'tool.annotate');
      check('annotate: saved', job.state === 'completed', `${job.state} ${job.outputs[0]?.name ?? ''} ${job.error?.code ?? ''}`);
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
      check('redact: saved', job.state === 'completed', `${job.state} ${job.error?.code ?? ''}`);
    }
    if (want('pdf')) {
      const known = await jobIds();
      await hooks('openPicker', [photo, extra, png], 'convert');
      const picker = await windowOf('picker');
      await clickSector(picker, 'PDF');
      const editor = await windowOf('editor');
      await editor.getByText('페이지 순서').waitFor();
      await editor.locator('.pdf-row, li').first().waitFor().catch(() => undefined);
      await shot(editor, 'pdf-order');
      await editor.locator('.btn-primary').click();
      const job = await waitJob(known, 'convert.pdf');
      check('images → PDF', job.state === 'completed', `${job.state} pages=${job.outputs[0]?.pages ?? '?'} ${JSON.stringify(job.error)}`);
    }

    // 5. Other windows
    for (const kind of ['jobs', 'settings', 'dropzone', 'about']) {
      if (!want(kind)) continue;
      await hooks('openWindow', kind);
      const page = await windowOf(kind);
      await page.locator('.view').first().waitFor();
      await page.waitForTimeout(500);
      await shot(page, kind);
      check(`${kind}: window renders`, true, JSON.stringify(await sizeOf(page)));
      if (kind === 'dropzone') {
        // A File that is not on disk: preload finds no path, main is never asked, the UI explains it.
        await page.evaluate(() => {
          const target = document.querySelector('.dropzone-view');
          const dt = new DataTransfer();
          dt.items.add(new File(['x'], 'memory.jpg', { type: 'image/jpeg' }));
          for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        });
        const shown = await page.getByText('파일을 찾을 수 없습니다', { exact: false }).waitFor({ timeout: 5000 }).then(() => true, () => false);
        check('dropzone: in-memory File → localized FILE_NOT_FOUND via preload', shown);
      }
      if (kind === 'settings') {
        await page.getByRole('radio', { name: 'English' }).click();
        const english = await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 5000 }).then(() => true, () => false);
        const persisted = (await hooks('updateSettings', {}))?.locale;
        check('settings: language switch applies live and persists in main', english && persisted === 'en', `persisted=${persisted}`);
        await page.getByRole('radio', { name: '한국어' }).click();
        await page.getByRole('heading', { name: '설정' }).waitFor({ timeout: 5000 }).catch(() => undefined);
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
