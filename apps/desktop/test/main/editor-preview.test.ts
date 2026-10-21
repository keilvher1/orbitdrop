import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, OrbitError, type PreviewRequest, type PreviewResult, type ProcessorInput } from '@orbitdrop/contracts';
import { EditorSessions } from '../../src/main/editor/sessions';
import { PreviewStore, previewResponse, previewUrl, tokenFromPreviewUrl } from '../../src/main/preview/store';
import { deferred, imageInfo, type Deferred } from './helpers';

const input: ProcessorInput = { fileId: 'f_a', path: '/in/photo.jpg', displayName: 'photo.jpg', sourceDir: '/in', format: 'jpeg', bytes: 100 };
const file = { fileId: 'f_a', name: 'photo.jpg', ext: '.jpg', format: 'jpeg', kind: 'image', bytes: 100 } as const;

function result(width: number): PreviewResult {
  return { data: new Uint8Array(width), mime: 'image/png', width, height: width, sourceWidth: 4000, sourceHeight: 3000, outputWidth: width * 2, outputHeight: width * 2 };
}

function fakePool() {
  const requests: { request: PreviewRequest; d: Deferred<PreviewResult> }[] = [];
  const cancelled: string[] = [];
  const pool = {
    preview: vi.fn((request: PreviewRequest) => {
      const d = deferred<PreviewResult>();
      requests.push({ request, d });
      return d.promise;
    }),
    cancelPreview: vi.fn((previewId: string) => {
      cancelled.push(previewId);
      const entry = requests.find((r) => r.request.previewId === previewId);
      entry?.d.reject(new OrbitError('CANCELLED', 'Preview superseded'));
    }),
    inspect: vi.fn(async () => imageInfo(4000, 3000)),
  };
  return { pool, requests, cancelled };
}

function setup(actionId: 'tool.crop' | 'tool.addBackground' | 'tool.metadata' = 'tool.crop') {
  const { pool, requests, cancelled } = fakePool();
  const store = new PreviewStore();
  const editors = new EditorSessions({ pool, store, settings: () => DEFAULT_SETTINGS });
  const session = editors.create({ actionId, files: [file], inputs: [input], origin: { source: 'test', sessionId: null } });
  // resolve the source preview started by create()
  const source = requests.shift()!;
  expect(source.request.kind).toBe('source');
  source.d.resolve(result(1600));
  return { editors, session, requests, cancelled, store, pool };
}

const cropOptions = { rect: { x: 0, y: 0, width: 3000, height: 3000 }, aspect: '1:1' };

describe('editor context', () => {
  it('returns image info, the source preview URL and defaults filled from the image and settings', async () => {
    const { editors, session, store } = setup();
    const context = await editors.context(session.editorId);
    expect(context.image.orientedWidth).toBe(4000);
    expect(context.source.width).toBe(1600);
    const token = tokenFromPreviewUrl(context.source.url);
    expect(token).not.toBeNull();
    expect(store.has(token!)).toBe(true);
    expect(context.defaults).toEqual({ rect: { x: 0, y: 0, width: 4000, height: 3000 }, aspect: 'free', outputFormat: 'input', flattenBackground: '#FFFFFF' });
    expect(context.settings).toBe(DEFAULT_SETTINGS);
  });

  it('Add Background defaults respect the output size limit', async () => {
    const { editors, session } = setup('tool.addBackground');
    const context = await editors.context(session.editorId);
    expect(context.defaults).toMatchObject({ ratio: 'auto', maxEdge: DEFAULT_SETTINGS.background.maxEdge, format: 'png', background: { kind: 'preset' } });
  });
});

describe('preview ordering', () => {
  it('a newer request cancels the in-flight one, which resolves as stale; the newest wins', async () => {
    const { editors, session, requests, cancelled, store } = setup();
    const first = editors.preview({ editorId: session.editorId, seq: 1, options: cropOptions });
    const second = editors.preview({ editorId: session.editorId, seq: 2, options: cropOptions });
    expect(cancelled).toEqual([requests[0]!.request.previewId]);
    requests[1]!.d.resolve(result(800));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ ok: false, seq: 1, stale: true });
    expect(b).toMatchObject({ ok: true, seq: 2, width: 800, outputWidth: 1600 });
    if (b.ok) expect(store.has(tokenFromPreviewUrl(b.url)!)).toBe(true);
    expect(requests[1]!.request).toMatchObject({ kind: 'tool.crop', input, maxEdge: 1200 });
  });

  it('answers an older seq as stale immediately, without rendering', async () => {
    const { editors, session, requests } = setup();
    const latest = editors.preview({ editorId: session.editorId, seq: 5, options: cropOptions });
    const old = await editors.preview({ editorId: session.editorId, seq: 3, options: cropOptions });
    expect(old).toMatchObject({ ok: false, seq: 3, stale: true });
    expect(requests).toHaveLength(1);
    requests[0]!.d.resolve(result(10));
    expect(await latest).toMatchObject({ ok: true, seq: 5 });
  });

  it('a result arriving after a newer request started is dropped', async () => {
    const { editors, session, requests } = setup();
    const first = editors.preview({ editorId: session.editorId, seq: 1, options: cropOptions });
    const firstRequest = requests[0]!;
    const second = editors.preview({ editorId: session.editorId, seq: 2, options: cropOptions });
    firstRequest.d.resolve(result(1)); // too late: already rejected by cancelPreview, ignored
    requests[1]!.d.resolve(result(2));
    expect(await first).toMatchObject({ stale: true });
    expect(await second).toMatchObject({ ok: true, width: 2 });
  });

  it('validates options and reports processor errors', async () => {
    const { editors, session, requests } = setup();
    expect(await editors.preview({ editorId: session.editorId, seq: 1, options: { rect: { x: -1 } } })).toMatchObject({ ok: false, error: { code: 'INVALID_OPTIONS' } });
    const failing = editors.preview({ editorId: session.editorId, seq: 2, options: cropOptions });
    requests[0]!.d.reject(new OrbitError('IMAGE_CORRUPT', 'bad'));
    expect(await failing).toMatchObject({ ok: false, seq: 2, error: { code: 'IMAGE_CORRUPT' } });
  });

  it('actions without a preview say so', async () => {
    const { editors, session } = setup('tool.metadata');
    expect(await editors.preview({ editorId: session.editorId, seq: 1, options: {} })).toMatchObject({ ok: false, error: { code: 'ENGINE_UNAVAILABLE' } });
  });

  it('an Add Background image must have been picked through main', async () => {
    const { editors, session } = setup('tool.addBackground');
    const options = { background: { kind: 'image', fileId: 'f_unknown' }, padding: 10, cornerRadius: 0, shadow: 0, ratio: 'auto', maxEdge: 1000, format: 'png', quality: 90 };
    expect(await editors.preview({ editorId: session.editorId, seq: 1, options })).toMatchObject({ ok: false, error: { code: 'INVALID_OPTIONS' } });
  });

  it('keeps only the last few preview images per editor and releases everything on dispose', async () => {
    const { editors, session, requests, store, cancelled } = setup();
    for (let seq = 1; seq <= 5; seq += 1) {
      const pending = editors.preview({ editorId: session.editorId, seq, options: cropOptions });
      requests.at(-1)!.d.resolve(result(seq));
      await pending;
    }
    expect(store.size).toBe(1 + 3); // pinned source + last three previews
    const inflight = editors.preview({ editorId: session.editorId, seq: 6, options: cropOptions });
    editors.dispose(session.editorId);
    expect(await inflight).toMatchObject({ stale: true });
    expect(cancelled.length).toBeGreaterThan(0);
    expect(store.size).toBe(0);
    await expect(editors.context(session.editorId)).rejects.toThrow();
  });
});

describe('PreviewStore', () => {
  it('serves entries by token with caching headers and 404s unknown tokens', async () => {
    const store = new PreviewStore();
    const token = store.put(new Uint8Array([137, 80, 78, 71]), 'image/png', 'ed_1');
    const ok = previewResponse(store, 'GET', previewUrl(token));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(previewResponse(store, 'GET', previewUrl('A'.repeat(24))).status).toBe(404);
    expect(previewResponse(store, 'GET', 'orbit-preview://other/abc').status).toBe(404);
    expect(previewResponse(store, 'GET', 'https://example.com/x').status).toBe(404);
    expect(previewResponse(store, 'POST', previewUrl(token)).status).toBe(405);
  });

  it('expires entries after the TTL unless pinned, and evicts least recently used entries over the byte cap', () => {
    let now = 0;
    const store = new PreviewStore({ ttlMs: 1000, maxBytes: 10, now: () => now });
    const pinned = store.put(new Uint8Array(2), 'image/png', 'ed', true);
    const a = store.put(new Uint8Array(3), 'image/png', 'ed');
    const b = store.put(new Uint8Array(3), 'image/png', 'ed');
    store.get(a); // a is now more recent than b
    const c = store.put(new Uint8Array(3), 'image/png', 'ed'); // 11 bytes > 10 → evict LRU unpinned (b)
    expect(store.has(b)).toBe(false);
    expect(store.has(a) && store.has(c) && store.has(pinned)).toBe(true);
    now = 5000;
    expect(store.sweep()).toBe(2);
    expect(store.has(pinned)).toBe(true);
    store.releaseOwner('ed');
    expect(store.size).toBe(0);
    expect(store.totalBytes).toBe(0);
  });
});
