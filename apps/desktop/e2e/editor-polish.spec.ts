/**
 * Polish-pass editor features through the real preload bridge, validated IPC
 * and processor workers — independent of the renderer's markup:
 *  - images → PDF: per-file thumbnails served over orbit-preview://, bounded
 *    in size, refused for files outside the editor, released with the editor;
 *  - batch Compress: per-file estimates (real encodes) equal the bytes the
 *    jobs then write; an estimate request older than the newest one answers
 *    stale; 'keep input format' reports what it resolves to (GIF → PNG).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import type { CompressOptions, EstimateOutcome, OrbitApi, PreviewOutcome, SubmitActionResult, ThumbnailResponse } from '@orbitdrop/contracts';
import { editorWindowOf, hooks, imageMeta, launchApp, makeJpeg, windowOf, type Launched } from './support';

declare global {
  interface Window {
    orbit: OrbitApi;
  }
}

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

async function editorFor(paths: string[], actionId: 'convert.pdf' | 'tool.compress'): Promise<{ editorId: string; fileIds: string[] }> {
  const selection = await hooks(launched.app).registerPaths(paths);
  const submitted: SubmitActionResult = await jobsPage.evaluate(({ selectionId, action }) => window.orbit.submitAction({ selectionId, actionId: action }), {
    selectionId: selection.selectionId,
    action: actionId,
  });
  if (submitted.kind !== 'editor') throw new Error(`expected an editor, got ${submitted.kind}`);
  return { editorId: submitted.editorId, fileIds: selection.files.map((f) => f.fileId) };
}

test('images → PDF: one small thumbnail per file over orbit-preview://, released when the editor closes', async () => {
  const wide = await makeJpeg(launched.work, 'wide.jpg', 1600, 900);
  const tall = await makeJpeg(launched.work, 'tall.jpg', 900, 1600);
  const square = await makeJpeg(launched.work, 'square.jpg', 1000, 1000);
  const { editorId, fileIds } = await editorFor([wide, tall, square], 'convert.pdf');
  const editor = await editorWindowOf(launched.app, editorId);

  const flow = await jobsPage.evaluate(
    async ({ id, files }) => {
      const load = (url: string) =>
        new Promise<{ ok: boolean; width: number; height: number }>((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ ok: true, width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => resolve({ ok: false, width: 0, height: 0 });
          img.src = url;
        });
      const thumbs: ThumbnailResponse[] = await Promise.all(files.map((fileId) => window.orbit.getEditorThumbnail({ editorId: id, fileId, maxEdge: 120 })));
      const images = await Promise.all(thumbs.map((thumb) => load(thumb.url)));
      const again = await window.orbit.getEditorThumbnail({ editorId: id, fileId: files[0]!, maxEdge: 120 });
      const outside = await window.orbit.getEditorThumbnail({ editorId: id, fileId: 'f_not_in_this_editor', maxEdge: 120 }).then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      const tooLarge = await window.orbit.getEditorThumbnail({ editorId: id, fileId: files[0]!, maxEdge: 4000 }).then(
        () => 'resolved',
        (e: Error) => e.message,
      );
      return { thumbs, images, again, outside, tooLarge };
    },
    { id: editorId, files: fileIds },
  );

  expect(flow.thumbs.map((t) => t.fileId)).toEqual(fileIds);
  for (const [index, thumb] of flow.thumbs.entries()) {
    expect(thumb.url).toMatch(/^orbit-preview:\/\/p\//);
    expect(JSON.stringify(thumb)).not.toContain(launched.work);
    const image = flow.images[index]!;
    expect(image.ok).toBe(true);
    expect(Math.max(image.width, image.height)).toBe(120);
    expect([image.width, image.height]).toEqual([thumb.width, thumb.height]);
  }
  // Orientation and aspect follow the source files (16:9, 9:16, 1:1).
  expect(flow.images[0]!.width).toBeGreaterThan(flow.images[0]!.height);
  expect(flow.images[1]!.width).toBeLessThan(flow.images[1]!.height);
  expect(flow.images[2]!.width).toBe(flow.images[2]!.height);
  expect(flow.again.url).toBe(flow.thumbs[0]!.url); // cached per editor + file + size
  expect(flow.outside).toMatch(/^INVALID_OPTIONS: /);
  expect(flow.tooLarge).toBe('INVALID_OPTIONS: Invalid request'); // > THUMBNAIL_MAX_EDGE fails the zod schema

  // Closing the editor releases its preview tokens: the thumbnail URLs stop resolving.
  await editor.evaluate((id) => window.orbit.cancelEditor(id), editorId).catch(() => undefined);
  await expect
    .poll(async () => (await hooks(launched.app).windows()).some((w) => w.context.kind === 'editor' && w.context.editorId === editorId))
    .toBe(false);
  const afterClose = await jobsPage.evaluate(
    (url) =>
      new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        // A new query string defeats the renderer's memory cache; the protocol ignores it.
        img.src = `${url}?after-close`;
      }),
    flow.thumbs[1]!.url,
  );
  expect(afterClose).toBe(false);
});

test('batch Compress: per-file estimates equal the bytes the jobs write, older requests answer stale', async () => {
  const paths = [
    await makeJpeg(launched.work, 'batch-a.jpg', 1600, 1200),
    await makeJpeg(launched.work, 'batch-b.jpg', 1200, 900),
    await makeJpeg(launched.work, 'batch-c.jpg', 900, 900),
  ];
  const { editorId, fileIds } = await editorFor(paths, 'tool.compress');
  await editorWindowOf(launched.app, editorId);
  const options: CompressOptions = { format: 'jpeg', quality: 45, maxEdge: null, pngMode: 'palette', keepMetadata: false };

  const flow = await jobsPage.evaluate(
    async ({ id, files, opts }) => {
      // A high seq so the editor window's own estimate requests count as older.
      const base = 1_000_000;
      const estimates: EstimateOutcome[] = await Promise.all(files.map((fileId) => window.orbit.requestEstimate({ editorId: id, fileId, seq: base + 1, options: opts })));
      const older = await window.orbit.requestEstimate({ editorId: id, fileId: files[0]!, seq: base, options: opts });
      const badOptions = await window.orbit.requestEstimate({ editorId: id, fileId: files[0]!, seq: base + 2, options: { ...opts, quality: 500 } });
      const committed = await window.orbit.commitEditor({ editorId: id, options: opts });
      return { estimates, older, badOptions, committed };
    },
    { id: editorId, files: fileIds, opts: options },
  );

  expect(flow.older).toMatchObject({ ok: false, stale: true });
  expect(flow.badOptions).toMatchObject({ ok: false, error: { code: 'INVALID_OPTIONS' } });
  expect(flow.committed.kind).toBe('jobs');
  if (flow.committed.kind !== 'jobs') return;
  expect(flow.committed.jobIds).toHaveLength(3);
  const jobs = await Promise.all(flow.committed.jobIds.map((jobId) => hooks(launched.app).waitForJob(jobId)));
  for (const [index, estimate] of flow.estimates.entries()) {
    expect(estimate).toMatchObject({ ok: true, fileId: fileIds[index], outputFormat: 'jpeg' });
    if (!estimate.ok) continue;
    const job = jobs.find((j) => j.inputName === `batch-${'abc'[index]}.jpg`)!;
    expect(job.state).toBe('completed');
    // The estimate is a real encode with the same options: the job writes exactly that many bytes.
    expect(job.outputs[0]!.bytes).toBe(estimate.estimatedBytes);
    const meta = await imageMeta(join(launched.work, job.outputs[0]!.name));
    expect([meta.width, meta.height]).toEqual([estimate.outputWidth, estimate.outputHeight]);
  }
});

test("Compress 'keep input format' reports what it resolves to (GIF → PNG)", async () => {
  const gif = join(launched.work, 'anim.gif');
  await writeFile(gif, await sharp({ create: { width: 320, height: 200, channels: 3, background: '#2F5BF6' } }).gif().toBuffer());
  const { editorId, fileIds } = await editorFor([gif], 'tool.compress');
  await editorWindowOf(launched.app, editorId);
  const options: CompressOptions = { format: 'input', quality: 75, maxEdge: null, pngMode: 'palette', keepMetadata: false };
  const flow = await jobsPage.evaluate(
    async ({ id, file, opts }) => {
      const preview: PreviewOutcome = await window.orbit.requestPreview({ editorId: id, seq: 1_000_000, options: opts, maxEdge: 256 });
      const estimate: EstimateOutcome = await window.orbit.requestEstimate({ editorId: id, fileId: file, seq: 1_000_000, options: opts });
      await window.orbit.cancelEditor(id);
      return { preview, estimate };
    },
    { id: editorId, file: fileIds[0]!, opts: options },
  );
  expect(flow.preview).toMatchObject({ ok: true, outputFormat: 'png' });
  expect(flow.estimate).toMatchObject({ ok: true, outputFormat: 'png' });
});
