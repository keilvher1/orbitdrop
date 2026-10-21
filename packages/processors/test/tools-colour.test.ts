import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_LIMITS, type ToolActionId } from '@orbitdrop/contracts';
import { clearCompressCaches, clearPreviewCaches } from '../src/tools';
import { renderAnnotationTiles } from '../src/tools/annotate';
import { clusterBoxes } from '../src/tools/boxes';
import { loadImage } from '../src/tools/common';
import { renderToolPreview } from '../src/tools/preview';
import {
  inputFor,
  listDir,
  makeTempDir,
  near,
  noisyRaw,
  preview,
  removeDir,
  runToolJob,
  settings,
  sha256,
  writeFixture,
} from './helpers/tools-fixtures';

/**
 * 16-bit and wide-gamut regressions. "Displayed" colours are what a colour-managed viewer
 * shows: the decoded file converted from its embedded profile (if any) to sRGB.
 */

async function displayed(data: string | Buffer | Uint8Array, x = 0, y = 0): Promise<[number, number, number]> {
  const { data: px, info } = await sharp(data).withIccProfile('srgb').raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [px[i]!, px[i + 1]!, px[i + 2]!];
}

async function hasIcc(data: string | Buffer): Promise<boolean> {
  return (await sharp(data).metadata()).icc !== undefined;
}

/** Uniform 16-bit RGB image whose 8-bit sRGB source colour is `rgb`, tagged with `profile` (or untagged). */
async function sixteenBit(width: number, height: number, rgb: readonly [number, number, number], profile: 'srgb' | 'p3' | null, format: 'png' | 'tiff' = 'png', orientation?: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) raw.set(rgb, i * 3);
  let p = sharp(raw, { raw: { width, height, channels: 3 } }).toColourspace('rgb16');
  if (profile) p = p.withIccProfile(profile);
  if (orientation) p = p.withMetadata({ orientation });
  return format === 'png' ? p.png().toBuffer() : p.tiff({ compression: 'lzw' }).toBuffer();
}

describe('16-bit and wide-gamut inputs', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('colour');
    clearPreviewCaches();
    clearCompressCaches();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('sRGB conversions of 16-bit profiled input write sRGB numbers (Compress, Add BG, Metadata, previews)', async () => {
    for (const profile of ['srgb', 'p3'] as const) {
      const data = await sixteenBit(64, 48, [233, 39, 39], profile);
      expect((await sharp(data).metadata()).depth).toBe('ushort');
      const path = await writeFixture(dir, `red16-${profile}.png`, data);
      const input = await inputFor(path);
      const truth = await displayed(data);
      const runs: [ToolActionId, unknown, number, number][] = [
        ['tool.compress', { format: 'png', pngMode: 'lossless' }, 10, 10],
        ['tool.compress', { format: 'jpeg', quality: 95 }, 10, 10],
        ['tool.compress', { format: 'webp', quality: 95 }, 10, 10],
        ['tool.addBackground', { background: { kind: 'solid', color: '#FFFFFF' }, padding: 10, cornerRadius: 0, shadow: 0, ratio: 'auto', maxEdge: 2400, format: 'png', quality: 90 }, 40, 30],
        ['tool.metadata', { mode: 'strip', iccPolicy: 'convertToSrgb', outputFormat: 'jpeg' }, 10, 10],
      ];
      for (const [tool, options, x, y] of runs) {
        const out = (await runToolJob(tool, input, options)).outputs[0]!;
        expect(await hasIcc(out.path), `${profile} ${tool}`).toBe(false);
        expect(near(await displayed(out.path, x, y), truth, tool === 'tool.compress' ? 3 : 2), `${profile} ${tool}: ${(await displayed(out.path, x, y)).join(',')} vs ${truth.join(',')}`).toBe(true);
      }
      for (const [kind, options] of [
        ['source', {}],
        ['tool.compress', { format: 'png', pngMode: 'lossless' }],
        ['tool.edit', {}],
      ] as const) {
        const p = await preview(kind, input, options, 32);
        expect(near(await displayed(p.data, 5, 5), truth, 3), `${profile} preview ${kind}`).toBe(true);
      }
    }
  });

  it('Edit rotations and flips of 16-bit profiled PNG/TIFF keep the profile and the colours', async () => {
    for (const format of ['png', 'tiff'] as const) {
      const data = await sixteenBit(40, 24, [233, 39, 39], 'p3', format);
      const path = await writeFixture(dir, `p3-16.${format === 'png' ? 'png' : 'tiff'}`, data);
      const input = await inputFor(path);
      const truth = await displayed(data);
      for (const options of [{ rotate: 90 }, { rotate: 180 }, { rotate: 270 }, { flipV: true }, { flipH: true }, { rotate: 90, flipH: true }]) {
        const out = (await runToolJob('tool.edit', input, options)).outputs[0]!;
        const label = `${format} ${JSON.stringify(options)}`;
        expect(await hasIcc(out.path), label).toBe(true);
        expect(near(await displayed(out.path, 3, 3), truth, 2), label).toBe(true);
        expect((await sharp(out.path).metadata()).depth, label).toBe('uchar');
      }
      // JPEG output of a rotation keeps the profile, too.
      const jpg = (await runToolJob('tool.edit', input, { rotate: 270, outputFormat: 'jpeg' })).outputs[0]!;
      expect(await hasIcc(jpg.path)).toBe(true);
      expect(near(await displayed(jpg.path, 3, 3), truth, 3)).toBe(true);
    }
  });

  it('16-bit with EXIF orientation: Crop/Redact are oriented and keep the profile', async () => {
    const data = await sixteenBit(48, 32, [233, 39, 39], 'p3', 'png', 6);
    const path = await writeFixture(dir, 'o6-16.png', data);
    const input = await inputFor(path);
    const truth = await displayed(data);
    const crop = (await runToolJob('tool.crop', input, { rect: { x: 0, y: 0, width: 32, height: 40 } })).outputs[0]!;
    expect([crop.width, crop.height]).toEqual([32, 40]);
    expect(await hasIcc(crop.path)).toBe(true);
    expect(near(await displayed(crop.path, 5, 5), truth, 2)).toBe(true);
    const redact = (await runToolJob('tool.redact', input, { regions: [{ id: 'r', rect: { x: 0, y: 0, width: 8, height: 8 }, style: 'solid', color: '#000000' }] })).outputs[0]!;
    const meta = await sharp(redact.path).metadata();
    expect([meta.width, meta.height]).toEqual([32, 48]);
    expect(meta.icc).toBeDefined();
    expect(near(await displayed(redact.path, 2, 2), [0, 0, 0], 2)).toBe(true);
    expect(near(await displayed(redact.path, 20, 30), truth, 2)).toBe(true);
  });

  it('Edit tone on 16-bit input matches the same edit on its 8-bit version (never black/white)', async () => {
    const rgb8 = noisyRaw(32, 24, 5, 60);
    const png8 = await sharp(rgb8, { raw: { width: 32, height: 24, channels: 3 } }).png().toBuffer();
    const png16 = await sharp(rgb8, { raw: { width: 32, height: 24, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
    const p8 = await inputFor(await writeFixture(dir, 'g8.png', png8));
    const p16 = await inputFor(await writeFixture(dir, 'g16.png', png16));
    for (const options of [
      { contrast: 10, saturation: 20 },
      { contrast: -10, saturation: 20 },
      { contrast: 1 },
      { brightness: 15, contrast: -30, saturation: -40 },
    ]) {
      const a = await sharp((await runToolJob('tool.edit', p8, options)).outputs[0]!.path).raw().toBuffer();
      const b = await sharp((await runToolJob('tool.edit', p16, options)).outputs[0]!.path).raw().toBuffer();
      let maxDiff = 0;
      for (let i = 0; i < a.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
      expect(maxDiff, JSON.stringify(options)).toBeLessThanOrEqual(1);
      expect(new Set(b).size, JSON.stringify(options)).toBeGreaterThan(10);
    }
  });

  it('overlay colours on a P3-tagged image display as requested (and as in the preview)', async () => {
    const p3 = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#808080' } }).withIccProfile('p3').png().toBuffer();
    const input = await inputFor(await writeFixture(dir, 'p3.png', p3));
    const requested: [number, number, number] = [0x33, 0x66, 0xcc];
    const redactOptions = { regions: [{ id: 'r', rect: { x: 10, y: 10, width: 40, height: 40 }, style: 'solid', color: '#3366CC' }] };
    const red = (await runToolJob('tool.redact', input, redactOptions)).outputs[0]!;
    expect(await hasIcc(red.path)).toBe(true);
    expect(near(await displayed(red.path, 30, 30), requested, 3), (await displayed(red.path, 30, 30)).join(',')).toBe(true);
    const redPreview = await preview('tool.redact', input, redactOptions, 120);
    expect(near(await displayed(redPreview.data, 30, 30), requested, 3)).toBe(true);

    const annotateOptions = { shapes: [{ id: 'a', type: 'rect', x: 60, y: 10, width: 40, height: 40, color: '#3366CC', strokeWidth: 12 }] };
    const ann = (await runToolJob('tool.annotate', input, annotateOptions)).outputs[0]!;
    expect(await hasIcc(ann.path)).toBe(true);
    expect(near(await displayed(ann.path, 60, 30), requested, 3), (await displayed(ann.path, 60, 30)).join(',')).toBe(true);
    // the photo itself is untouched (still the P3-tagged grey)
    expect(near(await displayed(ann.path, 80, 30), await displayed(p3, 80, 30), 1)).toBe(true);
    expect((await listDir(dir)).filter((n) => n.startsWith('.'))).toEqual([]);
  });
});

describe('resource use', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('resources');
    clearPreviewCaches();
    clearCompressCaches();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('LoadedImage.open() reuses the input buffer instead of copying it', async () => {
    const data = await sharp(noisyRaw(2000, 1500, 3, 120), { raw: { width: 2000, height: 1500, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(data.length).toBeGreaterThan(8 * 1024 * 1024);
    const image = await loadImage(await inputFor(await writeFixture(dir, 'big.png', data)), DEFAULT_PROCESSING_LIMITS);
    const before = process.memoryUsage().arrayBuffers;
    const pipelines = Array.from({ length: 5 }, () => image.open());
    const grown = process.memoryUsage().arrayBuffers - before;
    expect(pipelines).toHaveLength(5);
    expect(grown).toBeLessThan(data.length);
  });

  it('annotation tiles cover clusters of shapes, not the bounding box of all of them', async () => {
    const W = 12000;
    const H = 9000;
    const shapes = [
      { id: 'a', type: 'arrow' as const, x1: 100, y1: 100, x2: 400, y2: 300, color: '#FF0000', strokeWidth: 8 },
      { id: 'b', type: 'arrow' as const, x1: 11500, y1: 8700, x2: 11800, y2: 8900, color: '#00FF00', strokeWidth: 8 },
      { id: 't', type: 'text' as const, x: 150, y: 120, text: '가까운 글자', color: '#0000FF', fontSize: 40, bold: true },
    ];
    const tiles = await renderAnnotationTiles(shapes, W, H, 1, 'sans-serif');
    const area = tiles.reduce((sum, t) => sum + t.width * t.height, 0);
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    expect(area).toBeLessThan(W * H * 0.01);
    // the text overlaps the first arrow: they share one tile
    expect(clusterBoxes([{ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }, { x: 500, y: 500, width: 4, height: 4 }])).toEqual([
      { box: { x: 0, y: 0, width: 15, height: 15 }, members: [0, 1] },
      { box: { x: 500, y: 500, width: 4, height: 4 }, members: [2] },
    ]);
  });

  it('Compress preview: superseded requests are cancelled, large inputs preview like they export', async () => {
    const path = await writeFixture(dir, 'c.jpg', await sharp(noisyRaw(600, 400, 9, 60), { raw: { width: 600, height: 400, channels: 3 } }).jpeg({ quality: 95 }).toBuffer());
    const input = await inputFor(path);
    const first = new AbortController();
    const second = new AbortController();
    const requests = [
      renderToolPreview({ previewId: 'p1', kind: 'tool.compress', input, options: { quality: 30 }, maxEdge: 200, settings, limits: DEFAULT_PROCESSING_LIMITS }, { signal: first.signal }),
      renderToolPreview({ previewId: 'p2', kind: 'tool.compress', input, options: { quality: 40 }, maxEdge: 200, settings, limits: DEFAULT_PROCESSING_LIMITS }, { signal: second.signal }),
      renderToolPreview({ previewId: 'p3', kind: 'tool.compress', input, options: { quality: 50 }, maxEdge: 200, settings, limits: DEFAULT_PROCESSING_LIMITS }, { signal: new AbortController().signal }),
    ];
    first.abort();
    second.abort();
    const results = await Promise.allSettled(requests);
    expect(results[0]!.status).toBe('rejected');
    expect(results[1]!.status).toBe('rejected');
    expect(results[2]!.status).toBe('fulfilled');
    const job = await runToolJob('tool.compress', input, { quality: 50 });
    expect((results[2] as PromiseFulfilledResult<{ estimatedBytes?: number }>).value.estimatedBytes).toBe(job.outputs[0]!.bytes);

    // An input above maxOutputPixels (but within maxInputPixels) previews as it exports.
    const limits = { ...DEFAULT_PROCESSING_LIMITS, maxOutputPixels: 1000 };
    const p = await renderToolPreview({ previewId: 'p4', kind: 'tool.compress', input, options: { quality: 60 }, maxEdge: 100, settings, limits }, { signal: new AbortController().signal });
    expect(p.width).toBe(100);
  });

  it('crop preview of a small rect on a large image decodes just the region (same pixels as the cached path)', async () => {
    const raw = noisyRaw(3000, 2000, 4, 80);
    const path = await writeFixture(dir, 'wide.png', await sharp(raw, { raw: { width: 3000, height: 2000, channels: 3 } }).png().toBuffer());
    const input = await inputFor(path);
    const before = await sha256(path);
    const rect = { x: 1234, y: 567, width: 40, height: 30 };
    const direct = await preview('tool.crop', input, { rect }, 100); // needs a 3000 px decode > 2 × 100 → region path
    const img = await sharp(direct.data).raw().toBuffer({ resolveWithObject: true });
    expect([img.info.width, img.info.height]).toEqual([40, 30]);
    const regionAt = async (x: number, y: number) =>
      sharp(await readFile(path)).extract({ left: x, top: y, width: rect.width, height: rect.height }).raw().toBuffer();
    const meanDiff = (a: Buffer, b: Buffer) => {
      let sum = 0;
      for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i]! - b[i]!);
      return sum / a.length;
    };
    // exactly this region (JPEG preview noise only), not its neighbour one pixel away
    const here = meanDiff(await regionAt(rect.x, rect.y), img.data);
    const shifted = meanDiff(await regionAt(rect.x + 1, rect.y), img.data);
    expect(here).toBeLessThan(10);
    expect(shifted).toBeGreaterThan(here * 3);
    // a large rect uses the cached downscaled decode
    const cached = await preview('tool.crop', input, { rect: { x: 0, y: 0, width: 3000, height: 2000 } }, 300);
    expect([cached.width, cached.height]).toEqual([300, 200]);
    expect(await sha256(path)).toBe(before);
  });
});
