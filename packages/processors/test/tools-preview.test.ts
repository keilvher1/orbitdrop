import { chmod } from 'node:fs/promises';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobProgress } from '@orbitdrop/contracts';
import { clearPreviewCaches, runTool } from '../src/tools';
import {
  BLUE,
  GREEN,
  RED,
  YELLOW,
  exifSegment,
  inputFor,
  insertJpegSegments,
  jobFor,
  listDir,
  makeTempDir,
  near,
  noisyRaw,
  preview,
  px,
  quadrantJpeg,
  readRgba,
  removeDir,
  runToolJob,
  writeFixture,
} from './helpers/tools-fixtures';

describe('renderToolPreview', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('preview');
    clearPreviewCaches();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("'source' returns the oriented image fitted into maxEdge with the oriented full size", async () => {
    const path = await writeFixture(dir, 'o.jpg', insertJpegSegments(await quadrantJpeg(320, 160), [exifSegment({ orientation: 6 })]));
    const p = await preview('source', await inputFor(path), {}, 100);
    expect(p.mime).toBe('image/jpeg');
    expect([p.sourceWidth, p.sourceHeight]).toEqual([160, 320]);
    expect([p.width, p.height]).toEqual([50, 100]);
    const img = await readRgba(p.data);
    expect([img.width, img.height]).toEqual([50, 100]);
    expect(near(px(img, 12, 25), BLUE, 40)).toBe(true);
    expect(near(px(img, 37, 25), RED, 40)).toBe(true);
    expect(near(px(img, 12, 75), YELLOW, 40)).toBe(true);
    expect(near(px(img, 37, 75), GREEN, 40)).toBe(true);
    // never upscaled
    const big = await preview('source', await inputFor(path), {}, 2000);
    expect([big.width, big.height]).toEqual([160, 320]);
  });

  it("'source' uses PNG when the image has transparent pixels", async () => {
    const rgba = Buffer.alloc(40 * 40 * 4);
    for (let i = 0; i < 40 * 20; i += 1) rgba.set([0, 0, 255, 255], i * 4);
    const path = await writeFixture(dir, 'a.png', await sharp(rgba, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer());
    const p = await preview('source', await inputFor(path), {}, 20);
    expect(p.mime).toBe('image/png');
    const img = await readRgba(p.data);
    expect(px(img, 10, 15)[3]).toBe(0);
    expect(px(img, 10, 3)).toEqual([0, 0, 255, 255]);
    // an RGBA image without transparent pixels is sent as JPEG
    const opaque = await writeFixture(dir, 'b.png', await sharp({ create: { width: 30, height: 30, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } } }).png().toBuffer());
    expect((await preview('source', await inputFor(opaque), {}, 20)).mime).toBe('image/jpeg');
  });

  it('decodes once per file and size: later previews reuse the cached source', async () => {
    const path = await writeFixture(dir, 'n.png', await sharp(noisyRaw(1600, 1200, 1, 20), { raw: { width: 1600, height: 1200, channels: 3 } }).png().toBuffer());
    const input = await inputFor(path);
    const options = { background: { kind: 'solid', color: '#FFFFFF' }, padding: 40, cornerRadius: 20, shadow: 0, ratio: 'auto', maxEdge: 2400, format: 'png', quality: 90 };
    const t0 = performance.now();
    await preview('tool.addBackground', input, options, 600);
    const first = performance.now() - t0;
    const t1 = performance.now();
    for (let padding = 50; padding < 100; padding += 10) await preview('tool.addBackground', input, { ...options, padding }, 600);
    const later = (performance.now() - t1) / 5;
    expect(later).toBeLessThan(first);
  });

  it('concurrent previews of one file share a decode; cancelling one does not affect the others', async () => {
    const path = await writeFixture(dir, 'cc.png', await sharp(noisyRaw(900, 600, 3, 30), { raw: { width: 900, height: 600, channels: 3 } }).png().toBuffer());
    const input = await inputFor(path);
    const cancelled = new AbortController();
    const results = await Promise.allSettled([
      preview('source', input, {}, 300),
      preview('source', input, {}, 300, { signal: cancelled.signal }),
      preview('tool.edit', input, { brightness: 10 }, 300),
      preview('source', input, {}, 300),
    ]);
    cancelled.abort();
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof preview>>> => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(3);
    expect(Buffer.from(ok[0]!.value.data).equals(Buffer.from(ok[ok.length - 1]!.value.data))).toBe(true);
    // a request cancelled while the shared decode runs rejects with CANCELLED; the next one is served from the cache
    const late = new AbortController();
    const pending = preview('tool.edit', input, { contrast: 10 }, 299, { signal: late.signal });
    late.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await preview('tool.edit', input, { contrast: 10 }, 299)).width).toBe(299);
  });

  it('honours an aborted signal with CANCELLED', async () => {
    const path = await writeFixture(dir, 'c.png', await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000000' } }).png().toBuffer());
    const controller = new AbortController();
    controller.abort();
    await expect(preview('source', await inputFor(path), {}, 100, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(preview('tool.edit', await inputFor(path), { rotate: 90 }, 100, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('validates options and inputs', async () => {
    const path = await writeFixture(dir, 'v.png', await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000000' } }).png().toBuffer());
    const input = await inputFor(path);
    await expect(preview('tool.crop', input, { rect: { x: 0, y: 0, width: 11, height: 5 } }, 100)).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(preview('tool.edit', input, { rotate: 45 }, 100)).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(preview('source', { ...input, format: 'pdf' }, {}, 100)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    await expect(preview('source', { ...input, path: `${path}.missing` }, {}, 100)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });
});

describe('runTool', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('runtool');
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('reports real stages, cancels before writing and leaves no temp files', async () => {
    const path = await writeFixture(dir, 'x.png', await sharp({ create: { width: 64, height: 64, channels: 3, background: '#445566' } }).png().toBuffer());
    const input = await inputFor(path);
    const progress: JobProgress[] = [];
    await runToolJob('tool.crop', input, { rect: { x: 0, y: 0, width: 8, height: 8 } }, { progress });
    expect(progress.map((p) => (p.kind === 'indeterminate' ? p.stage : 'x'))).toEqual(['reading', 'encoding', 'writing']);

    const controller = new AbortController();
    controller.abort();
    await expect(runToolJob('tool.crop', input, { rect: { x: 0, y: 0, width: 8, height: 8 } }, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });

    // abort while running: cancel after the first progress event
    const live = new AbortController();
    const job = jobFor('tool.addBackground', input, { background: { kind: 'preset', presetId: 'nebula' }, padding: 100, cornerRadius: 10, shadow: 30, ratio: '1:1', maxEdge: 2400, format: 'png', quality: 90 });
    await expect(runTool(job, { signal: live.signal, onProgress: () => live.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await listDir(dir)).filter((n) => !['x.png', 'x Cropped.png'].includes(n))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports OUTPUT_DIR_NOT_WRITABLE for a read-only folder and leaves it untouched', async () => {
    const ro = await makeTempDir('runtool-ro');
    const path = await writeFixture(ro, 'z.png', await sharp({ create: { width: 20, height: 20, channels: 3, background: '#445566' } }).png().toBuffer());
    const input = await inputFor(path);
    await chmod(ro, 0o555);
    try {
      await expect(runToolJob('tool.crop', input, { rect: { x: 0, y: 0, width: 5, height: 5 } })).rejects.toMatchObject({ code: 'OUTPUT_DIR_NOT_WRITABLE' });
      expect(await listDir(ro)).toEqual(['z.png']);
    } finally {
      await chmod(ro, 0o755);
      await removeDir(ro);
    }
  });

  it('writes into an explicit output folder and rejects non-tool actions and bad inputs', async () => {
    const path = await writeFixture(dir, 'y.png', await sharp({ create: { width: 20, height: 20, channels: 3, background: '#445566' } }).png().toBuffer());
    const other = await makeTempDir('runtool-out');
    try {
      const result = await runToolJob('tool.crop', await inputFor(path), { rect: { x: 0, y: 0, width: 5, height: 5 } }, { outputDir: other });
      expect(result.outputs[0]!.path.startsWith(other)).toBe(true);
      expect(await listDir(other)).toEqual(['y Cropped.png']);
    } finally {
      await removeDir(other);
    }
    const input = await inputFor(path);
    await expect(runTool({ ...jobFor('tool.crop', input, {}), actionId: 'convert.png' }, { signal: new AbortController().signal, onProgress: () => {} })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await expect(runToolJob('tool.crop', { ...input, format: 'pdf' }, { rect: { x: 0, y: 0, width: 5, height: 5 } })).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    const corrupt = await writeFixture(dir, 'bad.png', Buffer.concat([(await sharp({ create: { width: 20, height: 20, channels: 3, background: '#445566' } }).png().toBuffer()).subarray(0, 40)]));
    await expect(runToolJob('tool.crop', await inputFor(corrupt), { rect: { x: 0, y: 0, width: 5, height: 5 } })).rejects.toMatchObject({ code: 'IMAGE_CORRUPT' });
  });
});
