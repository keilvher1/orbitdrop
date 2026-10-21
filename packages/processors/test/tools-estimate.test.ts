import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreviewKind, PreviewResult, ProcessorInput } from '@orbitdrop/contracts';
import { renderToolPreview } from '../src/tools';
import { clearCompressCaches, compressEncodeCount } from '../src/tools/compress';
import { clearPreviewCaches } from '../src/tools/source-cache';
import { inputFor, limits, makeTempDir, noisyJpeg, preview, removeDir, runToolJob, settings, writeFixture } from './helpers/tools-fixtures';

/** A Compress estimate as main requests it for one file of a batch. */
function estimate(input: ProcessorInput, options: unknown, signal?: AbortSignal, kind: PreviewKind = 'tool.compress'): Promise<PreviewResult> {
  return renderToolPreview(
    { previewId: randomUUID(), kind, input, options, maxEdge: 64, settings, limits, estimateOnly: true },
    { signal: signal ?? new AbortController().signal },
  );
}

describe('Compress estimates (estimateOnly)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('estimate');
    clearCompressCaches();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('report the size of the real full-size encode without an image — the same bytes as the preview and the job', async () => {
    const input = await inputFor(await writeFixture(dir, 'p.jpg', await noisyJpeg(900, 600, 95, 7)));
    const options = { quality: 40 };
    const e = await estimate(input, options);
    expect(e.data.length).toBe(0);
    expect([e.width, e.height, e.mime]).toEqual([0, 0, 'image/png']);
    expect([e.sourceWidth, e.sourceHeight, e.outputWidth, e.outputHeight]).toEqual([900, 600, 900, 600]);
    expect(e.outputFormat).toBe('jpeg');
    const p = await preview('tool.compress', input, options, 300);
    expect(p.estimatedBytes).toBe(e.estimatedBytes);
    expect(p.outputFormat).toBe('jpeg');
    const job = await runToolJob('tool.compress', input, options);
    expect(job.outputs[0]!.bytes).toBe(e.estimatedBytes);
    const smaller = await estimate(input, { quality: 40, maxEdge: 300 });
    expect([smaller.outputWidth, smaller.outputHeight]).toEqual([300, 200]);
    expect(smaller.estimatedBytes).toBeLessThan(e.estimatedBytes!);
  });

  it('options seen before cost no encode, even after the 4-slot byte cache moved on; estimate-only encodes keep no bytes', async () => {
    const a = await inputFor(await writeFixture(dir, 'a.jpg', await noisyJpeg(600, 400, 95, 1)));
    const b = await inputFor(await writeFixture(dir, 'b.jpg', await noisyJpeg(500, 400, 95, 2)));
    const options = { quality: 50 };
    const start = compressEncodeCount();
    const first = [await estimate(a, options), await estimate(b, options)];
    expect(compressEncodeCount() - start).toBe(2);
    // Six other encodes (previews) rotate the full-encode cache completely.
    for (let quality = 31; quality <= 36; quality += 1) await preview('tool.compress', a, { quality }, 120);
    const mid = compressEncodeCount();
    expect(mid - start).toBe(8);
    const again = [await estimate(a, options), await estimate(b, options)];
    expect(compressEncodeCount()).toBe(mid);
    expect(again.map((r) => r.estimatedBytes)).toEqual(first.map((r) => r.estimatedBytes));
    // The preview image needs the bytes: the estimate-only encode did not keep them, so it encodes once…
    const shown = await preview('tool.compress', a, options, 120);
    expect(compressEncodeCount()).toBe(mid + 1);
    expect(shown.estimatedBytes).toBe(first[0]!.estimatedBytes);
    // …and an earlier preview's encode answers a later estimate (served from the byte cache or the estimate cache).
    await preview('tool.compress', b, { quality: 77 }, 120);
    const before = compressEncodeCount();
    expect((await estimate(b, { quality: 77 })).estimatedBytes).toBeGreaterThan(0);
    expect(compressEncodeCount()).toBe(before);
  });

  it('concurrent estimates of the same options share one encode', async () => {
    const input = await inputFor(await writeFixture(dir, 'c.jpg', await noisyJpeg(800, 600, 95, 3)));
    const start = compressEncodeCount();
    const [x, y] = await Promise.all([estimate(input, { quality: 45 }), estimate(input, { quality: 45 })]);
    expect(compressEncodeCount() - start).toBe(1);
    expect(x.estimatedBytes).toBe(y.estimatedBytes);
  });

  it('an estimate cancelled while it waits for its turn never encodes', async () => {
    const input = await inputFor(await writeFixture(dir, 'big.jpg', await noisyJpeg(1600, 1200, 95, 4)));
    const start = compressEncodeCount();
    const first = estimate(input, { quality: 50 });
    const controller = new AbortController();
    const superseded = estimate(input, { quality: 60 }, controller.signal);
    controller.abort();
    await expect(superseded).rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await first).estimatedBytes).toBeGreaterThan(0);
    expect(compressEncodeCount() - start).toBe(1);
  });

  it('is refused for every other preview kind and validates options', async () => {
    const input = await inputFor(await writeFixture(dir, 'v.jpg', await noisyJpeg(64, 48, 90, 5)));
    for (const kind of ['source', 'thumbnail', 'tool.crop', 'tool.edit'] as const) {
      await expect(estimate(input, {}, undefined, kind)).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    }
    await expect(estimate(input, { quality: 500 })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(estimate({ ...input, path: `${input.path}.missing` }, {})).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('clearPreviewCaches (last editor closed) drops the Compress encodes and estimates too', async () => {
    const input = await inputFor(await writeFixture(dir, 'm.jpg', await noisyJpeg(400, 300, 95, 6)));
    await estimate(input, { quality: 50 });
    await preview('tool.compress', input, { quality: 55 }, 100);
    const start = compressEncodeCount();
    clearPreviewCaches();
    await estimate(input, { quality: 50 });
    await estimate(input, { quality: 55 });
    expect(compressEncodeCount() - start).toBe(2);
  });
});
