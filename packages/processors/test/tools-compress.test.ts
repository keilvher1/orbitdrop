import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearCompressCaches } from '../src/tools';
import {
  exifSegment,
  inputFor,
  insertJpegSegments,
  listDir,
  makeTempDir,
  meanAbsDiff,
  near,
  noisyJpeg,
  noisyRaw,
  preview,
  px,
  quadrantJpeg,
  readRgba,
  removeDir,
  runToolJob,
  sha256,
  writeFixture,
} from './helpers/tools-fixtures';

describe('tool.compress', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('compress');
    clearCompressCaches();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('makes a noisy high-quality photo smaller at quality 60 and reports no warning', async () => {
    const path = await writeFixture(dir, 'photo.jpg', await noisyJpeg(800, 600, 98));
    const before = await sha256(path);
    const input = await inputFor(path);
    const result = await runToolJob('tool.compress', input, { quality: 60 });
    const out = result.outputs[0]!;
    expect(out.path.endsWith('photo Compressed.jpg')).toBe(true);
    expect(out.format).toBe('jpeg');
    expect(out.bytes).toBeLessThan(input.bytes * 0.7);
    expect(result.warnings).toEqual([]);
    const meta = await sharp(out.path).metadata();
    expect([meta.width, meta.height]).toEqual([800, 600]);
    expect(meta.format).toBe('jpeg');
    expect(await sha256(path)).toBe(before);
    expect(await listDir(dir)).toEqual(['photo Compressed.jpg', 'photo.jpg']);
  });

  it('warns OUTPUT_LARGER_THAN_INPUT when the result is not smaller (and still writes it)', async () => {
    const path = await writeFixture(dir, 'tiny.jpg', await noisyJpeg(300, 200, 20));
    const input = await inputFor(path);
    const result = await runToolJob('tool.compress', input, { format: 'png', pngMode: 'lossless' });
    const out = result.outputs[0]!;
    expect(out.bytes).toBeGreaterThanOrEqual(input.bytes);
    expect(result.warnings).toContainEqual({ code: 'OUTPUT_LARGER_THAN_INPUT', params: { inputBytes: input.bytes, outputBytes: out.bytes } });
    expect(out.path.endsWith('tiny Compressed.png')).toBe(true);
    expect((await sharp(out.path).metadata()).format).toBe('png');
  });

  it('downscales to maxEdge and never upscales', async () => {
    const path = await writeFixture(dir, 'big.jpg', await noisyJpeg(1600, 1200, 90));
    const input = await inputFor(path);
    const down = await runToolJob('tool.compress', input, { maxEdge: 800, quality: 80 });
    expect([down.outputs[0]!.width, down.outputs[0]!.height]).toEqual([800, 600]);
    const same = await runToolJob('tool.compress', input, { maxEdge: 5000, quality: 80 });
    expect([same.outputs[0]!.width, same.outputs[0]!.height]).toEqual([1600, 1200]);
  });

  it('PNG palette quantizes (smaller, ≤256 colours) while lossless keeps every pixel', async () => {
    const raw = noisyRaw(400, 300, 3, 30);
    const path = await writeFixture(dir, 'shot.png', await sharp(raw, { raw: { width: 400, height: 300, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer());
    const input = await inputFor(path);
    const palette = await runToolJob('tool.compress', input, { pngMode: 'palette', quality: 70 });
    const lossless = await runToolJob('tool.compress', input, { pngMode: 'lossless' });
    expect(palette.outputs[0]!.bytes).toBeLessThan(lossless.outputs[0]!.bytes);
    expect(lossless.outputs[0]!.bytes).toBeLessThan(input.bytes);
    expect((await sharp(palette.outputs[0]!.path).metadata()).isPalette).toBe(true);
    const original = await readRgba(path);
    expect(meanAbsDiff(await readRgba(lossless.outputs[0]!.path), original)).toBe(0);
    expect(meanAbsDiff(await readRgba(palette.outputs[0]!.path), original)).toBeGreaterThan(0);
  });

  it('converts formats: WebP keeps alpha, JPEG flattens it with a warning', async () => {
    const rgba = Buffer.alloc(100 * 100 * 4);
    for (let i = 0; i < 100 * 100; i += 1) rgba.set([255, 0, 0, i % 100 < 50 ? 255 : 0], i * 4);
    const path = await writeFixture(dir, 'a.png', await sharp(rgba, { raw: { width: 100, height: 100, channels: 4 } }).png().toBuffer());
    const input = await inputFor(path);
    const webp = await runToolJob('tool.compress', input, { format: 'webp', quality: 80 });
    expect(webp.outputs[0]!.path.endsWith('a Compressed.webp')).toBe(true);
    const wimg = await readRgba(webp.outputs[0]!.path);
    expect(px(wimg, 80, 50)[3]).toBe(0);
    const jpg = await runToolJob('tool.compress', input, { format: 'jpeg', quality: 80 });
    expect(jpg.warnings).toContainEqual({ code: 'ALPHA_FLATTENED', params: { background: '#FFFFFF' } });
    const jimg = await readRgba(jpg.outputs[0]!.path);
    expect(near(px(jimg, 80, 50), [255, 255, 255], 6)).toBe(true);
  });

  it('keepMetadata keeps EXIF (orientation applied, tag reset) and is off by default', async () => {
    const stored = await quadrantJpeg(320, 160);
    const path = await writeFixture(dir, 'o.jpg', insertJpegSegments(stored, [exifSegment({ orientation: 6, make: 'TestCam', model: 'M1' })]));
    const input = await inputFor(path);
    const kept = await runToolJob('tool.compress', input, { quality: 80, keepMetadata: true });
    const km = await sharp(kept.outputs[0]!.path).metadata();
    expect([km.width, km.height]).toEqual([160, 320]);
    expect(km.exif).toBeDefined();
    expect(km.exif!.includes(Buffer.from('TestCam'))).toBe(true);
    expect(km.orientation === undefined || km.orientation === 1).toBe(true);
    const stripped = await runToolJob('tool.compress', input, { quality: 80 });
    const sm = await sharp(stripped.outputs[0]!.path).metadata();
    expect(sm.exif).toBeUndefined();
    expect([sm.width, sm.height]).toEqual([160, 320]);
  });

  it('preview: estimatedBytes is the size of the real full-resolution encode; image shows the artefacts', async () => {
    const path = await writeFixture(dir, 'p.jpg', await noisyJpeg(1200, 900, 95, 5));
    const input = await inputFor(path);
    const options = { quality: 35 };
    const p = await preview('tool.compress', input, options, 600);
    const job = await runToolJob('tool.compress', input, options);
    expect(p.estimatedBytes).toBe(job.outputs[0]!.bytes);
    expect(p.estimatedBytes).toBe((await readFile(job.outputs[0]!.path)).length);
    expect([p.outputWidth, p.outputHeight]).toEqual([1200, 900]);
    expect([p.sourceWidth, p.sourceHeight]).toEqual([1200, 900]);
    expect([p.width, p.height]).toEqual([600, 450]);
    expect(p.mime).toBe('image/png');

    // The preview is decoded from the encoded result: the same downscale of the job output.
    const fromJob = await readRgba(await sharp(job.outputs[0]!.path).resize(600, 450, { fit: 'fill' }).png().toBuffer());
    const shown = await readRgba(p.data);
    expect(meanAbsDiff(fromJob, shown)).toBeLessThan(1);
    // …and differs more from the source at quality 5 than at quality 95.
    const source = await readRgba(await sharp(path).resize(600, 450, { fit: 'fill' }).png().toBuffer());
    const q5 = await readRgba((await preview('tool.compress', input, { quality: 5 }, 600)).data);
    const q95 = await readRgba((await preview('tool.compress', input, { quality: 95 }, 600)).data);
    expect(meanAbsDiff(q5, source)).toBeGreaterThan(meanAbsDiff(q95, source) + 2);

    // Cached per options: a second identical request returns the same result object content.
    const again = await preview('tool.compress', input, options, 600);
    expect(again.estimatedBytes).toBe(p.estimatedBytes);
    expect(Buffer.from(again.data).equals(Buffer.from(p.data))).toBe(true);
    // A different maxEdge reuses the cached encode (same estimate).
    const small = await preview('tool.compress', input, options, 300);
    expect(small.estimatedBytes).toBe(p.estimatedBytes);
    expect([small.width, small.height]).toEqual([300, 225]);
  });
});
