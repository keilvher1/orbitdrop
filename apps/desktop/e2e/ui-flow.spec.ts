/**
 * The reference recording's flow through the real windows (renderer UI +
 * main + processors): picker wheel → JPG, picker tools → Crop editor (1:1,
 * Apply), picker tools → Add Background editor (Save). Files are generated;
 * windows are opened through main's test hooks (no OS dialogs, no synthesized
 * OS input — clicks are delivered to the page by Playwright). Outputs are
 * decoded and measured; screenshots go to docs/screenshots/desktop-main-*.png.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { isTempFileName } from '@orbitdrop/core/node';
import { hooks, imageMeta, jobIds, launchApp, makePdf, pixel, screenshotDir, waitForNewJob, windowOf, type Launched } from './support';

test.describe.configure({ mode: 'serial' });

let launched: Launched;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched?.close();
});

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400); // let previews and transitions settle
  await page.screenshot({ path: join(screenshotDir, `desktop-main-${name}.png`) });
}

async function chooseSector(page: Page, label: string): Promise<void> {
  const sector = page.getByRole('menuitem', { name: label, exact: true });
  await expect(sector).toBeVisible();
  // The wheel hit-tests the click position (like the native wheel); click the sector's center.
  await sector.click({ force: true });
}

test('PDF → JPG from the picker wheel', async () => {
  const pdf = await makePdf(launched.work);
  const known = await jobIds(launched.app);
  await hooks(launched.app).openPicker([pdf], 'convert');
  const picker = await windowOf(launched.app, 'picker');
  await expect(picker.getByRole('menuitem', { name: 'JPG', exact: true })).toBeVisible();
  await shot(picker, 'picker-pdf');
  await chooseSector(picker, 'JPG');
  const job = await waitForNewJob(launched.app, known, 'convert.jpeg');
  expect(job.state).toBe('completed');
  expect(await imageMeta(join(launched.work, 'Page 001.jpg'))).toEqual({ format: 'jpeg', width: 2550, height: 3300 });
});

test('Crop 1:1 in the crop editor', async () => {
  const jpg = join(launched.work, 'Page 001.jpg');
  const known = await jobIds(launched.app);
  await hooks(launched.app).openPicker([jpg], 'tools');
  const picker = await windowOf(launched.app, 'picker');
  await chooseSector(picker, '자르기');
  const editor = await windowOf(launched.app, 'editor');
  await editor.getByRole('radio', { name: '1:1', exact: true }).click();
  await shot(editor, 'crop-editor');
  await editor.locator('.btn-primary').click();
  const job = await waitForNewJob(launched.app, known, 'tool.crop');
  expect(job.state).toBe('completed');
  const cropped = join(launched.work, 'Page 001 Cropped.jpg');
  // 1:1 on a 2550×3300 page is its centred 2550×2550 square: output (x, y) = page (x, y + 375).
  expect(await imageMeta(cropped)).toEqual({ format: 'jpeg', width: 2550, height: 2550 });
  for (const [x, y] of [
    [1275, 150], // inside the orange title block (page rows 300–800)
    [1275, 1200], // body text area
    [100, 2490], // near the bottom-left corner
  ] as const) {
    const out = await pixel(cropped, x, y);
    const page = await pixel(jpg, x, y + 375);
    for (let c = 0; c < 3; c += 1) expect(Math.abs(out[c]! - page[c]!), `pixel (${x}, ${y}) channel ${c}`).toBeLessThanOrEqual(16);
  }
  const orange = await pixel(cropped, 1275, 150);
  expect(orange[0]! - orange[2]!).toBeGreaterThan(120); // the title block is really there (red ≫ blue)
});

test('Add Background → PNG in the background editor', async () => {
  const cropped = join(launched.work, 'Page 001 Cropped.jpg');
  const known = await jobIds(launched.app);
  await hooks(launched.app).openPicker([cropped], 'tools');
  const picker = await windowOf(launched.app, 'picker');
  await chooseSector(picker, '배경 추가');
  const editor = await windowOf(launched.app, 'editor');
  await expect(editor.locator('.btn-primary')).toBeEnabled();
  await shot(editor, 'background-editor');
  await editor.locator('.btn-primary').click();
  const job = await waitForNewJob(launched.app, known, 'tool.addBackground');
  expect(job.state).toBe('completed');
  expect(job.outputs[0]?.name).toBe('Page 001 Cropped With Background.png');
  const path = join(launched.work, 'Page 001 Cropped With Background.png');
  const meta = await imageMeta(path);
  expect(meta.format).toBe('png');
  expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(2400);
  const corner = await pixel(path, 1, 1);
  expect(corner[3]).toBe(255);
});

test('the four files of the recording exist side by side and the jobs window lists them', async () => {
  await hooks(launched.app).openWindow('jobs');
  const jobsWindow = await windowOf(launched.app, 'jobs');
  await expect(jobsWindow.getByText('Page 001 Cropped With Background.png').first()).toBeVisible();
  await shot(jobsWindow, 'jobs');
  const names = await readdir(launched.work);
  expect(names.filter((n) => isTempFileName(n))).toEqual([]); // no temp files left behind
  expect(names.filter((n) => !n.startsWith('.')).sort()).toEqual(
    ['Page 001 Cropped With Background.png', 'Page 001 Cropped.jpg', 'Page 001.jpg', 'Page 001.pdf'].sort(),
  );
  expect((await readFile(join(launched.work, 'Page 001.pdf'))).subarray(0, 5).toString('latin1')).toBe('%PDF-');
});
