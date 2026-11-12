/**
 * OS-level close of an editor with unsaved work, in the real app. The window
 * close button, ⌘W (File › Close Window → performClose:) and Alt+F4 all reach
 * main as the BrowserWindow 'close' event — here started with
 * BrowserWindow.close(), which takes the same path (no synthesized OS input).
 * Main holds such a close back and the renderer asks with the same in-window
 * dialog as × / Esc: one dialog however often it comes, keep editing keeps
 * the work, closing without saving writes nothing. A crashed renderer is
 * loaded again once (closed on a second crash) and stays closable; quitting
 * the app is never held back.
 */
import { readdir } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { editorWindowOf, hooks, launchApp, makeJpeg, type Launched } from './support';

test.describe.configure({ mode: 'serial' });

let launched: Launched;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched?.close();
});

const TITLE = '저장하지 않고 닫을까요?';

async function openEditor(actionId: 'tool.annotate' | 'tool.redact', name: string): Promise<{ editorId: string; page: Page; windowId: number }> {
  const photo = await makeJpeg(launched.work, name, 800, 600);
  const result = await hooks(launched.app).submit([photo], actionId);
  if (result.kind !== 'editor') throw new Error(`expected an editor, got ${result.kind}`);
  const page = await editorWindowOf(launched.app, result.editorId);
  const record = (await hooks(launched.app).windows()).find((w) => w.context.kind === 'editor' && w.context.editorId === result.editorId);
  if (!record) throw new Error('editor window not registered');
  return { editorId: result.editorId, page, windowId: record.windowId };
}

/** What the close button, ⌘W and Alt+F4 do: BrowserWindow 'close' (performClose: / WM_CLOSE). */
const osClose = (windowId: number): Promise<void> =>
  launched.app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.fromId(id)?.close();
  }, windowId);

const crash = (windowId: number): Promise<void> =>
  launched.app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.fromId(id)?.webContents.forcefullyCrashRenderer();
  }, windowId);

/**
 * Evaluate in the window's current page from main (also after its renderer was replaced). While the
 * renderer is gone executeJavaScript never settles, so it is bounded: undefined = not there (yet).
 */
const inPage = (windowId: number, js: string): Promise<unknown> =>
  launched.app.evaluate(async ({ BrowserWindow }, args) => {
    const contents = BrowserWindow.fromId(args.id)?.webContents;
    if (!contents) return undefined;
    return Promise.race([contents.executeJavaScript(args.js).catch(() => undefined), new Promise((resolve) => setTimeout(() => resolve(undefined), 1000))]);
  }, { id: windowId, js });

/**
 * A click whose effect is closing its own window. On Windows the window (and Playwright's page) can
 * be gone before the click call returns ("Target page … has been closed"); that is the expected
 * result, not an error. The callers check from main that the window really closed.
 */
async function clickThatClosesThePage(page: Page, target: Locator): Promise<void> {
  try {
    await target.click();
  } catch (error) {
    if (!page.isClosed() && !/has been closed/.test(String(error))) throw error;
  }
}

async function editorRecord(editorId: string) {
  return (await hooks(launched.app).windows()).find((w) => w.context.kind === 'editor' && w.context.editorId === editorId);
}

test('macOS: File › Close Window (⌘W) is in the application menu', async () => {
  test.skip(process.platform !== 'darwin', 'macOS only (Windows closes with Alt+F4, no menu)');
  const items = await launched.app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).flatMap((top) => (top.submenu?.items ?? []).map((item) => ({ top: top.role ?? null, role: item.role ?? null, accelerator: item.accelerator ?? null }))),
  );
  expect(items).toContainEqual({ top: 'filemenu', role: 'close', accelerator: 'CommandOrControl+W' });
  expect(items).toContainEqual({ top: 'appmenu', role: 'quit', accelerator: 'CommandOrControl+Q' });
});

test('an editor with nothing unsaved closes at once', async () => {
  const { editorId, windowId } = await openEditor('tool.annotate', 'clean.jpg');
  expect((await editorRecord(editorId))?.unsaved).toBe(false);
  await osClose(windowId);
  await expect.poll(async () => (await editorRecord(editorId)) === undefined).toBe(true);
});

test('unsaved annotations: an OS close asks like ×, once; keep editing keeps them; closing without saving writes nothing', async () => {
  const { editorId, page, windowId } = await openEditor('tool.annotate', 'notes.jpg');
  const before = (await readdir(launched.work)).sort();
  await page.getByRole('button', { name: '화살표 추가' }).click();
  await expect(page.getByText('주석 1개')).toBeVisible();
  await expect.poll(async () => (await editorRecord(editorId))?.unsaved).toBe(true);

  await osClose(windowId);
  const dialog = page.getByRole('alertdialog', { name: TITLE });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '계속 편집' })).toBeFocused();
  await osClose(windowId); // ⌘W again while it asks
  await page.waitForTimeout(300);
  await expect(page.getByRole('alertdialog')).toHaveCount(1);
  expect(await editorRecord(editorId)).toBeDefined();

  await dialog.getByRole('button', { name: '계속 편집' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByText('주석 1개')).toBeVisible();
  expect((await editorRecord(editorId))?.unsaved).toBe(true);

  await osClose(windowId);
  await clickThatClosesThePage(page, page.getByRole('alertdialog', { name: TITLE }).getByRole('button', { name: '저장하지 않고 닫기' }));
  await expect.poll(async () => (await editorRecord(editorId)) === undefined).toBe(true);
  expect((await readdir(launched.work)).sort()).toEqual(before); // nothing written
  expect((await hooks(launched.app).jobs()).filter((j) => j.actionId === 'tool.annotate')).toEqual([]);
});

test('unsaved redactions: the OS close is held back too; a crashed renderer is loaded again and stays closable', async () => {
  const { editorId, page, windowId } = await openEditor('tool.redact', 'secret.jpg');
  await page.getByRole('button', { name: '영역 추가' }).click();
  await expect.poll(async () => (await editorRecord(editorId))?.unsaved).toBe(true);
  await osClose(windowId);
  await expect(page.getByRole('alertdialog', { name: TITLE })).toBeVisible();
  expect(await editorRecord(editorId)).toBeDefined();

  // The renderer dies with the dialog open: the window must not stay a blank panel nobody can close.
  // Main loads it again (the editor session is still there; the unsaved regions went with the renderer).
  await crash(windowId);
  await expect.poll(async () => (await editorRecord(editorId))?.unsaved).toBe(false);
  // (Playwright keeps its Page of a crashed target; the reloaded page is checked from main.)
  await expect.poll(() => inPage(windowId, `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('영역 추가'))`)).toBe(true);
  expect(await inPage(windowId, `document.querySelectorAll('[role="alertdialog"]').length`)).toBe(0);
  await osClose(windowId); // nothing unsaved any more: closes at once
  await expect.poll(async () => (await editorRecord(editorId)) === undefined).toBe(true);
});

// The crash policy of windows/crash.ts: the first crash brings the view back, the second shows only the
// crash screen, the third closes the window.
test('a renderer that keeps crashing: the view comes back once, then only a crash screen, then the window closes', async () => {
  const { editorId, windowId } = await openEditor('tool.annotate', 'crashy.jpg');
  await crash(windowId);
  await expect.poll(() => inPage(windowId, `Boolean(document.querySelector('.editor-view'))`)).toBe(true); // reloaded once, view back
  await crash(windowId);
  // Second crash: reloaded again, but the page shows only the crash screen (it can still be closed).
  await expect.poll(() => inPage(windowId, `Boolean(document.querySelector('.crash-view [data-window-failure]'))`)).toBe(true);
  expect(await inPage(windowId, `Boolean(document.querySelector('.editor-view'))`)).toBe(false);
  expect(await editorRecord(editorId)).toBeDefined();
  await crash(windowId);
  // Third crash: the window is closed instead of reloaded again (main tells the user with a notification).
  await expect.poll(async () => (await editorRecord(editorId)) === undefined).toBe(true);
});

test('a hung renderer cannot keep its window open: a close it does not answer lets the next one through', async () => {
  const { editorId, page, windowId } = await openEditor('tool.annotate', 'hung.jpg');
  await page.getByRole('button', { name: '화살표 추가' }).click();
  await expect.poll(async () => (await editorRecord(editorId))?.unsaved).toBe(true);
  // The renderer's main thread stops for 9 s: it can neither show the dialog nor acknowledge the request.
  expect(await inPage(windowId, `setTimeout(() => { const end = Date.now() + 9000; while (Date.now() < end) {} }, 50); true`)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await osClose(windowId);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await editorRecord(editorId)).toBeDefined(); // held back: a responsive renderer would ask now
  await new Promise((resolve) => setTimeout(resolve, 5000)); // CLOSE_ACK_MS without an acknowledgement
  await osClose(windowId);
  await expect.poll(async () => (await editorRecord(editorId)) === undefined, { timeout: 15_000 }).toBe(true);
});

test('quitting the app is never held back by an editor with unsaved work', async () => {
  const { editorId, page, windowId } = await openEditor('tool.annotate', 'quit.jpg');
  await page.getByRole('button', { name: '화살표 추가' }).click();
  await expect.poll(async () => (await editorRecord(editorId))?.unsaved).toBe(true);
  /** An OS close of the guarded editor (optionally right after the quit started): was it held back? */
  const closeHeldBack = (afterQuit: boolean): Promise<boolean | null> =>
    launched.app.evaluate(({ app, BrowserWindow }, args) => {
      const window = BrowserWindow.fromId(args.id);
      if (!window) return null;
      let prevented: boolean | null = null;
      window.once('close', (event) => {
        prevented = event.defaultPrevented; // runs after main's own listener
      });
      if (args.afterQuit) app.quit(); // main's quit sequence starts synchronously
      window.close();
      return prevented;
    }, { id: windowId, afterQuit });
  expect(await closeHeldBack(false)).toBe(true); // an OS close is held back (the editor asks)…
  await expect(page.getByRole('alertdialog', { name: TITLE })).toBeVisible();
  const child = launched.app.process();
  const started = Date.now();
  expect(await closeHeldBack(true)).toBe(false); // …but not once the app quits
  await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 20_000 }).toBe(true);
  expect(Date.now() - started).toBeLessThan(15_000);
});
