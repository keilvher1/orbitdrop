import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, OrbitError, type PreviewKind, type PreviewRequest, type PreviewResult, type ProcessorInput } from '@orbitdrop/contracts';
import { EditorSessions } from '../../src/main/editor/sessions';
import { PreviewStore, tokenFromPreviewUrl } from '../../src/main/preview/store';
import { deferred, imageInfo, tick, type Deferred } from './helpers';

/**
 * Background work of editor sessions: file-list thumbnails (images → PDF order
 * editor) and per-file Compress estimates, both through one shared limiter.
 */

const inputs: ProcessorInput[] = ['a', 'b', 'c', 'd'].map((n) => ({ fileId: `f_${n}`, path: `/in/${n}.jpg`, displayName: `${n}.jpg`, sourceDir: '/in', format: 'jpeg', bytes: 100 }));
const files = inputs.map((i) => ({ fileId: i.fileId, name: i.displayName, ext: '.jpg', format: 'jpeg', kind: 'image', bytes: 100 }) as const);

interface Call {
  readonly request: PreviewRequest;
  readonly d: Deferred<PreviewResult>;
}

function fakePool() {
  const calls: Call[] = [];
  const pool = {
    // Like ProcessorPool.preview: an abort of the request's signal rejects it with CANCELLED.
    preview: vi.fn((request: PreviewRequest, signal?: AbortSignal) => {
      const d = deferred<PreviewResult>();
      calls.push({ request, d });
      signal?.addEventListener('abort', () => d.reject(new OrbitError('CANCELLED', 'Preview superseded')), { once: true });
      return d.promise;
    }),
    cancelPreview: vi.fn(),
    inspect: vi.fn(async () => imageInfo(400, 300)),
    clearPreviewCaches: vi.fn(),
  };
  const of = (kind: PreviewKind): Call[] => calls.filter((c) => c.request.kind === kind);
  return { pool, calls, of };
}

const thumb = (width: number, height: number): PreviewResult => ({ data: new Uint8Array(width), mime: 'image/jpeg', width, height, sourceWidth: width * 10, sourceHeight: height * 10 });
const estimate = (bytes: number): PreviewResult => ({
  data: new Uint8Array(0),
  mime: 'image/png',
  width: 0,
  height: 0,
  sourceWidth: 400,
  sourceHeight: 300,
  outputWidth: 400,
  outputHeight: 300,
  estimatedBytes: bytes,
  outputFormat: 'jpeg',
});

function setup(actionId: 'convert.pdf' | 'tool.compress' = 'convert.pdf', options: { keepThumbnails?: number } = {}) {
  const { pool, calls, of } = fakePool();
  const store = new PreviewStore();
  const editors = new EditorSessions({ pool, store, settings: () => DEFAULT_SETTINGS, ...(options.keepThumbnails ? { keepThumbnails: options.keepThumbnails } : {}) });
  const session = editors.create({ actionId, files, inputs, origin: { source: 'test', sessionId: null } });
  of('source')[0]!.d.resolve({ data: new Uint8Array(10), mime: 'image/jpeg', width: 160, height: 120, sourceWidth: 400, sourceHeight: 300 });
  return { editors, session, pool, calls, of, store, editorId: session.editorId };
}

const compressOptions = { format: 'jpeg', quality: 60, maxEdge: null, pngMode: 'palette', keepMetadata: false };

describe('thumbnails', () => {
  it('renders once per file and size, as orbit-preview URLs owned by the editor and released when it closes', async () => {
    const { editors, of, store, editorId } = setup();
    const first = editors.thumbnail({ editorId, fileId: 'f_a', maxEdge: 80 });
    const twin = editors.thumbnail({ editorId, fileId: 'f_a', maxEdge: 80 });
    await tick();
    expect(of('thumbnail')).toHaveLength(1);
    expect(of('thumbnail')[0]!.request).toMatchObject({ kind: 'thumbnail', input: inputs[0], maxEdge: 80, options: {} });
    of('thumbnail')[0]!.d.resolve(thumb(80, 60));
    const [a, b] = await Promise.all([first, twin]);
    expect(a).toEqual({ fileId: 'f_a', url: expect.stringMatching(/^orbit-preview:\/\/p\//), width: 80, height: 60 });
    expect(b).toEqual(a);
    const token = tokenFromPreviewUrl(a.url)!;
    expect(store.get(token)?.owner).toBe(editorId);
    // Cached: no new render for the same file and size.
    expect(await editors.thumbnail({ editorId, fileId: 'f_a', maxEdge: 80 })).toEqual(a);
    expect(of('thumbnail')).toHaveLength(1);
    // Default and maximum edge.
    const unfinished = [editors.thumbnail({ editorId, fileId: 'f_b' }), editors.thumbnail({ editorId, fileId: 'f_c', maxEdge: 4000 })].map((p) => p.catch((e: unknown) => e));
    await tick();
    expect(of('thumbnail').slice(1).map((c) => c.request.maxEdge)).toEqual([96, 160]);
    editors.dispose(editorId);
    expect(store.has(token)).toBe(false);
    for (const result of await Promise.all(unfinished)) expect(result).toMatchObject({ code: 'CANCELLED' });
  });

  it('refuses files that are not part of the editor', async () => {
    const { editors, editorId } = setup();
    await expect(editors.thumbnail({ editorId, fileId: 'f_other' })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(editors.thumbnail({ editorId: 'ed_unknown', fileId: 'f_a' })).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('runs at most two background renders at once; the editor preview never waits behind them', async () => {
    const { editors, of, editorId } = setup('tool.compress');
    const pending = inputs.map((input) => editors.thumbnail({ editorId, fileId: input.fileId }));
    await tick();
    expect(of('thumbnail')).toHaveLength(2);
    void editors.preview({ editorId, seq: 1, options: compressOptions });
    await tick();
    expect(of('tool.compress')).toHaveLength(1); // started right away
    of('thumbnail')[0]!.d.resolve(thumb(96, 72));
    await pending[0];
    await tick();
    expect(of('thumbnail')).toHaveLength(3);
    for (const call of of('thumbnail').slice(1)) call.d.resolve(thumb(96, 72));
    await tick();
    of('thumbnail')[3]!.d.resolve(thumb(96, 72));
    expect(await Promise.all(pending)).toHaveLength(4);
  });

  it('closing the editor cancels running renders and drops queued ones before they start', async () => {
    const { editors, of, editorId } = setup();
    const pending = inputs.map((input) => editors.thumbnail({ editorId, fileId: input.fileId }).catch((error: unknown) => error));
    await tick();
    expect(of('thumbnail')).toHaveLength(2);
    editors.dispose(editorId);
    const results = await Promise.all(pending);
    for (const result of results) expect(result).toMatchObject({ code: 'CANCELLED' });
    await tick();
    expect(of('thumbnail')).toHaveLength(2); // the queued two never reached the worker
  });

  it('renders again when its token left the store, when a render failed, and keeps a bounded number per editor', async () => {
    const { editors, of, store, editorId } = setup('convert.pdf', { keepThumbnails: 2 });
    const a = editors.thumbnail({ editorId, fileId: 'f_a' });
    await tick();
    of('thumbnail')[0]!.d.resolve(thumb(96, 72));
    const tokenA = tokenFromPreviewUrl((await a).url)!;
    store.release(tokenA); // e.g. evicted by the store's memory limit
    const again = editors.thumbnail({ editorId, fileId: 'f_a' });
    await tick();
    expect(of('thumbnail')).toHaveLength(2);
    of('thumbnail')[1]!.d.resolve(thumb(96, 72));
    const tokenA2 = tokenFromPreviewUrl((await again).url)!;
    expect(tokenA2).not.toBe(tokenA);

    const failing = editors.thumbnail({ editorId, fileId: 'f_b' });
    await tick();
    of('thumbnail')[2]!.d.reject(new OrbitError('IMAGE_CORRUPT', 'Image is damaged: /Users/someone/b.jpg'));
    const error = (await failing.then(
      () => null,
      (e: unknown) => e as OrbitError,
    ))!;
    expect(error).toMatchObject({ code: 'IMAGE_CORRUPT' });
    expect(error.message).not.toContain('/Users/someone');
    const retried = editors.thumbnail({ editorId, fileId: 'f_b' });
    await tick();
    expect(of('thumbnail')).toHaveLength(4); // not cached after the failure
    of('thumbnail')[3]!.d.resolve(thumb(96, 72));
    const tokenB = tokenFromPreviewUrl((await retried).url)!;

    const c = editors.thumbnail({ editorId, fileId: 'f_c' });
    await tick();
    of('thumbnail')[4]!.d.resolve(thumb(96, 72));
    const tokenC = tokenFromPreviewUrl((await c).url)!;
    // keepThumbnails = 2: the least recently requested one (a) was released.
    expect([store.has(tokenA2), store.has(tokenB), store.has(tokenC)]).toEqual([false, true, true]);
  });
});

describe('estimates', () => {
  it('runs the real encode without an image (estimateOnly) and reports bytes, size and format', async () => {
    const { editors, of, editorId } = setup('tool.compress');
    const pending = editors.estimate({ editorId, fileId: 'f_b', seq: 1, options: compressOptions });
    await tick();
    const call = of('tool.compress')[0]!;
    expect(call.request).toMatchObject({ kind: 'tool.compress', input: inputs[1], estimateOnly: true, maxEdge: 64 });
    expect(call.request.options).toMatchObject(compressOptions);
    call.d.resolve(estimate(12_345));
    expect(await pending).toEqual({ ok: true, seq: 1, fileId: 'f_b', estimatedBytes: 12_345, outputWidth: 400, outputHeight: 300, outputFormat: 'jpeg' });
  });

  it('a newer seq cancels older estimates, running or waiting, and answers late ones stale at once', async () => {
    const { editors, of, editorId } = setup('tool.compress');
    const older = inputs.map((input) => editors.estimate({ editorId, fileId: input.fileId, seq: 1, options: compressOptions }));
    await tick();
    expect(of('tool.compress')).toHaveLength(2); // two run, two wait (shared limiter)
    const newer = editors.estimate({ editorId, fileId: 'f_a', seq: 2, options: { ...compressOptions, quality: 40 } });
    for (const outcome of await Promise.all(older)) expect(outcome).toMatchObject({ ok: false, stale: true });
    await tick();
    expect(of('tool.compress')).toHaveLength(3); // only the newer one started after them
    expect(of('tool.compress')[2]!.request.options).toMatchObject({ quality: 40 });
    of('tool.compress')[2]!.d.resolve(estimate(999));
    expect(await newer).toMatchObject({ ok: true, seq: 2, estimatedBytes: 999 });
    expect(await editors.estimate({ editorId, fileId: 'f_b', seq: 1, options: compressOptions })).toMatchObject({ ok: false, stale: true });
    expect(of('tool.compress')).toHaveLength(3);
  });

  it('only Compress has estimates; unknown files, invalid options and processor errors are reported', async () => {
    const pdf = setup('convert.pdf');
    expect(await pdf.editors.estimate({ editorId: pdf.editorId, fileId: 'f_a', seq: 1, options: {} })).toMatchObject({ ok: false, error: { code: 'ENGINE_UNAVAILABLE' } });
    const { editors, of, editorId } = setup('tool.compress');
    expect(await editors.estimate({ editorId, fileId: 'f_other', seq: 1, options: compressOptions })).toMatchObject({ ok: false, error: { code: 'INVALID_OPTIONS' } });
    expect(await editors.estimate({ editorId, fileId: 'f_a', seq: 2, options: { quality: 500 } })).toMatchObject({ ok: false, error: { code: 'INVALID_OPTIONS' } });
    const failing = editors.estimate({ editorId, fileId: 'f_a', seq: 3, options: compressOptions });
    await tick();
    of('tool.compress')[0]!.d.reject(new OrbitError('IMAGE_CORRUPT', 'Damaged: /Users/someone/a.jpg'));
    const outcome = await failing;
    expect(outcome).toMatchObject({ ok: false, seq: 3, fileId: 'f_a', error: { code: 'IMAGE_CORRUPT' } });
    expect(JSON.stringify(outcome)).not.toContain('/Users/someone');
  });

  it('closing the editor answers running estimates stale', async () => {
    const { editors, editorId } = setup('tool.compress');
    const pending = editors.estimate({ editorId, fileId: 'f_a', seq: 1, options: compressOptions });
    await tick();
    editors.dispose(editorId);
    expect(await pending).toMatchObject({ ok: false, stale: true });
  });
});

describe('tool previews', () => {
  it('pass the output format and the warnings of the job through to the renderer', async () => {
    const { editors, of, editorId } = setup('tool.compress');
    const first = editors.preview({ editorId, seq: 1, options: compressOptions });
    await tick();
    of('tool.compress')[0]!.d.resolve({ ...thumb(40, 30), estimatedBytes: 10, outputFormat: 'png', warnings: [{ code: 'OUTPUT_LARGER_THAN_INPUT' }] });
    expect(await first).toMatchObject({ ok: true, outputFormat: 'png', warnings: [{ code: 'OUTPUT_LARGER_THAN_INPUT' }] });
    const second = editors.preview({ editorId, seq: 2, options: compressOptions });
    await tick();
    of('tool.compress')[1]!.d.resolve({ ...thumb(40, 30), warnings: [] });
    const outcome = await second;
    expect(outcome.ok && 'warnings' in outcome).toBe(false); // none → omitted
  });
});
