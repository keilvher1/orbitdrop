/**
 * The whole main-process pipeline driven from a real sandboxed renderer through
 * the preload bridge (window.orbit) and validated IPC — independent of the
 * renderer's markup: PDF → JPG, Crop 1:1, Add Background → PNG, with the real
 * processors in utility processes. Outputs are decoded and measured.
 */
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorContext, FileSelection, OrbitApi, PreviewOutcome, SubmitActionResult, WheelMenu } from '@orbitdrop/contracts';
import { editorWindowOf, hooks, imageMeta, launchApp, makePdf, pixel, windowOf, type Launched } from './support';

declare global {
  interface Window {
    orbit: OrbitApi;
  }
}

const ORBIT_API_KEYS = [
  'platform',
  'getWindowContext',
  'closeWindow',
  'resizeWindow',
  'openWindow',
  'getAppInfo',
  'getCapabilities',
  'getSettings',
  'updateSettings',
  'onSettingsChanged',
  'getHelperStatus',
  'onHelperStatusChanged',
  'openFileDialog',
  'registerDroppedFiles',
  'getSelection',
  'getMenu',
  'submitAction',
  'getEditor',
  'requestPreview',
  'inspectImage',
  'commitEditor',
  'cancelEditor',
  'pickBackgroundImage',
  'listJobs',
  'onJobsChanged',
  'cancelJob',
  'retryJobElsewhere',
  'revealOutput',
  'openOutput',
  'openExternal',
  'getEditorThumbnail',
  'requestEstimate',
  'clearFinishedJobs',
  'retryJob',
  'setCloseGuard',
  'onCloseRequested',
  'getUpdateState',
  'onUpdateStateChanged',
  'checkForUpdates',
  'restartToUpdate',
];

test.describe.configure({ mode: 'serial' });

let launched: Launched;
let jobsPage: Page;

test.beforeAll(async () => {
  launched = await launchApp();
  await hooks(launched.app).openWindow('jobs');
  jobsPage = await windowOf(launched.app, 'jobs');
});

test.afterAll(async () => {
  await launched?.close();
});

test('the renderer sees exactly OrbitApi and no Node or Electron internals', async () => {
  const surface = await jobsPage.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      keys: Object.keys(window.orbit).sort(),
      platform: window.orbit.platform,
      require: typeof w.require,
      process: typeof w.process,
      module: typeof w.module,
      ipcRenderer: typeof w.ipcRenderer,
      electron: typeof w.electron,
    };
  });
  expect(surface.keys).toEqual([...ORBIT_API_KEYS].sort());
  expect(surface).toMatchObject({ platform: process.platform, require: 'undefined', process: 'undefined', module: 'undefined', ipcRenderer: 'undefined', electron: 'undefined' });
  const info = await jobsPage.evaluate(() => window.orbit.getAppInfo());
  expect(info).toMatchObject({ name: 'OrbitDrop', packaged: false, locale: 'ko' });
  expect(await jobsPage.evaluate(() => window.orbit.getWindowContext())).toEqual({ kind: 'jobs' });
  const status = await jobsPage.evaluate(() => window.orbit.getHelperStatus());
  expect(status.state).toBe('unavailable'); // the helper is not started in automation runs
});

test('capabilities come from the real engine probe', async () => {
  const caps = await jobsPage.evaluate(() => window.orbit.getCapabilities());
  expect(caps.probe.errors).toEqual([]);
  expect(caps.probe.pdfRender).toBe(true);
  for (const id of ['convert.jpeg', 'convert.png', 'convert.webp', 'tool.crop', 'tool.addBackground'] as const) expect(caps.actions[id].enabled, id).toBe(true);
});

test('PDF → JPG: selection without paths, PDF menu order, real 300 DPI JPEG next to the original', async () => {
  const pdf = await makePdf(launched.work);
  const selection = await hooks(launched.app).registerPaths([pdf]);
  const result = await jobsPage.evaluate(async (selectionId) => {
    const changes: number[] = [];
    const off = window.orbit.onJobsChanged((jobs) => changes.push(jobs.length));
    const sel: FileSelection = await window.orbit.getSelection(selectionId);
    const menu: WheelMenu = await window.orbit.getMenu(selectionId, 'convert');
    const submitted: SubmitActionResult = await window.orbit.submitAction({ selectionId, actionId: 'convert.jpeg' });
    await new Promise((r) => setTimeout(r, 300));
    off();
    return { sel, menu, submitted, changes: changes.length };
  }, selection.selectionId);
  expect(JSON.stringify(result.sel)).not.toContain(launched.work);
  expect(result.sel.files[0]).toMatchObject({ name: 'Page 001.pdf', format: 'pdf', kind: 'pdf' });
  expect(result.menu.sectors.map((s) => s.label)).toEqual(['DOCX', 'JPG', 'PNG', 'TXT']);
  expect(result.submitted.kind).toBe('jobs');
  expect(result.changes).toBeGreaterThan(0);
  if (result.submitted.kind !== 'jobs') return;
  const job = await hooks(launched.app).waitForJob(result.submitted.jobIds[0]!);
  expect(job.state).toBe('completed');
  expect(job.outputs[0]).toMatchObject({ name: 'Page 001.jpg', format: 'jpeg' });
  expect(await imageMeta(join(launched.work, 'Page 001.jpg'))).toEqual({ format: 'jpeg', width: 2550, height: 3300 });
  const listed = await jobsPage.evaluate(() => window.orbit.listJobs());
  expect(listed.find((j) => j.jobId === job.jobId)?.outputs[0]?.outputId).toBe(job.outputs[0]!.outputId);
});

test('Crop 1:1 through an editor session: context, seq-ordered preview served over orbit-preview://, commit', async () => {
  const jpg = join(launched.work, 'Page 001.jpg');
  const selection = await hooks(launched.app).registerPaths([jpg]);
  const submitted = await jobsPage.evaluate((selectionId) => window.orbit.submitAction({ selectionId, actionId: 'tool.crop' }), selection.selectionId);
  expect(submitted.kind).toBe('editor');
  if (submitted.kind !== 'editor') return;
  await windowOf(launched.app, 'editor'); // main opened the editor window

  const flow = await jobsPage.evaluate(async (editorId) => {
    const loadImage = (url: string) =>
      new Promise<{ ok: boolean; width: number; height: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ ok: true, width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ ok: false, width: 0, height: 0 });
        img.src = url;
      });
    const context: EditorContext = await window.orbit.getEditor(editorId);
    const source = await loadImage(context.source.url);
    const rect = { x: 0, y: 0, width: 2550, height: 2550 };
    // A high seq so the editor window's own requests count as older.
    const base = 1_000_000;
    const superseded = window.orbit.requestPreview({ editorId, seq: base + 1, options: { rect, aspect: '1:1' }, maxEdge: 600 });
    const latest = window.orbit.requestPreview({ editorId, seq: base + 2, options: { rect, aspect: '1:1' }, maxEdge: 600 });
    const [first, second] = (await Promise.all([superseded, latest])) as [PreviewOutcome, PreviewOutcome];
    const older = await window.orbit.requestPreview({ editorId, seq: 1, options: { rect, aspect: '1:1' } });
    const preview = second.ok ? await loadImage(second.url) : null;
    const bogus = await loadImage('orbit-preview://p/AAAAAAAAAAAAAAAAAAAAAAAA');
    const committed = await window.orbit.commitEditor({ editorId, options: { rect, aspect: '1:1' } });
    return { context, source, first, second, older, preview, bogus, committed };
  }, submitted.editorId);

  expect(flow.context.image).toMatchObject({ orientedWidth: 2550, orientedHeight: 3300 });
  expect(flow.context.defaults).toMatchObject({ rect: { x: 0, y: 0, width: 2550, height: 3300 } });
  expect(flow.source.ok).toBe(true);
  expect(Math.max(flow.source.width, flow.source.height)).toBeLessThanOrEqual(1600);
  expect(flow.first).toMatchObject({ ok: false, stale: true });
  expect(flow.second).toMatchObject({ ok: true });
  expect(flow.older).toMatchObject({ ok: false, stale: true });
  expect(flow.preview).toMatchObject({ ok: true });
  expect(flow.preview!.width).toBe(flow.preview!.height);
  expect(flow.bogus.ok).toBe(false);
  expect(flow.committed.kind).toBe('jobs');
  if (flow.committed.kind !== 'jobs') return;
  const job = await hooks(launched.app).waitForJob(flow.committed.jobIds[0]!);
  expect(job.state).toBe('completed');
  expect(job.outputs[0]?.name).toBe('Page 001 Cropped.jpg');
  expect(await imageMeta(join(launched.work, 'Page 001 Cropped.jpg'))).toEqual({ format: 'jpeg', width: 2550, height: 2550 });
});

test('Add Background → PNG: layout respects the 2400 px limit, background and image are where they should be', async () => {
  const cropped = join(launched.work, 'Page 001 Cropped.jpg');
  const selection = await hooks(launched.app).registerPaths([cropped]);
  const submitted = await jobsPage.evaluate((selectionId) => window.orbit.submitAction({ selectionId, actionId: 'tool.addBackground' }), selection.selectionId);
  if (submitted.kind !== 'editor') throw new Error(`expected an editor, got ${submitted.kind}`);
  const spec = { background: { kind: 'preset', presetId: 'ember' }, padding: 240, cornerRadius: 96, shadow: 24, ratio: 'auto', maxEdge: 2400, format: 'png', quality: 92 };
  const flow = await jobsPage.evaluate(
    async ({ editorId, options }) => {
      const preview = await window.orbit.requestPreview({ editorId, seq: 1_000_000, options, maxEdge: 800 });
      const committed = await window.orbit.commitEditor({ editorId, options });
      return { preview, committed };
    },
    { editorId: submitted.editorId, options: spec },
  );
  expect(flow.preview).toMatchObject({ ok: true });
  if (!flow.preview.ok || flow.committed.kind !== 'jobs') throw new Error('preview or commit failed');
  const job = await hooks(launched.app).waitForJob(flow.committed.jobIds[0]!);
  expect(job.state).toBe('completed');
  expect(job.outputs[0]?.name).toBe('Page 001 Cropped With Background.png');
  const path = join(launched.work, 'Page 001 Cropped With Background.png');
  const meta = await imageMeta(path);
  expect(meta.format).toBe('png');
  expect(meta.width).toBe(meta.height); // square content + equal padding in 'auto'
  expect(meta.width).toBeLessThanOrEqual(2400);
  expect(flow.preview.outputWidth).toBe(meta.width);
  const corner = await pixel(path, 2, 2);
  const center = await pixel(path, meta.width / 2, meta.height / 2);
  expect(corner[3]).toBe(255);
  expect(corner[0]! + corner[1]! + corner[2]!).toBeLessThan(700); // saturated gradient, not white
  expect(center[0]! + center[1]! + center[2]!).toBeGreaterThan(600); // the white page
});

test('closing an editor right after its commit leaves the committed job running to completion', async () => {
  const jpg = join(launched.work, 'Page 001.jpg');
  const selection = await hooks(launched.app).registerPaths([jpg]);
  const submitted = await jobsPage.evaluate((selectionId) => window.orbit.submitAction({ selectionId, actionId: 'tool.compress' }), selection.selectionId);
  if (submitted.kind !== 'editor') throw new Error(`expected an editor, got ${submitted.kind}`);
  const editor = await editorWindowOf(launched.app, submitted.editorId);
  const committed = await jobsPage.evaluate(
    (editorId) => window.orbit.commitEditor({ editorId, options: { format: 'jpeg', quality: 40 } }),
    submitted.editorId,
  );
  if (committed.kind !== 'jobs') throw new Error(`expected jobs, got ${committed.kind}`);
  // What the renderer does after a successful commit (Compress: after showing the result).
  await editor.evaluate(() => window.orbit.closeWindow()).catch(() => undefined);
  await expect
    .poll(async () => (await hooks(launched.app).windows()).some((w) => w.context.kind === 'editor' && w.context.editorId === submitted.editorId))
    .toBe(false);
  const job = await hooks(launched.app).waitForJob(committed.jobIds[0]!);
  expect(job.state).toBe('completed');
  expect(job.outputs[0]?.name).toBe('Page 001 Compressed.jpg');
  expect(await imageMeta(join(launched.work, 'Page 001 Compressed.jpg'))).toEqual({ format: 'jpeg', width: 2550, height: 3300 });
});

test('the renderer cannot navigate, open windows, open arbitrary URLs or pass bad payloads', async () => {
  const before = launched.app.windows().length;
  const results = await jobsPage.evaluate(async () => {
    const opened = window.open('https://example.com/');
    const external = await window.orbit.openExternal('https://example.com/');
    const badId = await window.orbit.getSelection('../../etc/passwd').then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    const fake = await window.orbit.registerDroppedFiles([new File(['x'], 'fake.png', { type: 'image/png' })]).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    const permission = await Notification.requestPermission();
    return { opened: opened === null, external, badId, fake, permission };
  });
  expect(results.opened).toBe(true);
  expect(results.external).toBe(false);
  expect(results.badId).toMatch(/^INVALID_OPTIONS: /);
  expect(results.fake).toMatch(/^VIRTUAL_FILE: /); // an in-memory File has no path on disk
  expect(results.permission).toBe('denied');
  await jobsPage.evaluate(() => {
    window.location.href = 'https://example.com/';
  });
  await jobsPage.waitForTimeout(500);
  expect(jobsPage.url()).toMatch(/^file:\/\/.*\/out\/renderer\/index\.html/);
  expect(launched.app.windows().length).toBe(before);
});
