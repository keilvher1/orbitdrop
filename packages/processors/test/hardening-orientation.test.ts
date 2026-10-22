import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_LIMITS } from '@orbitdrop/contracts';
import { clearPreviewCaches, inspectImage } from '../src';
import { decodeBmp } from '../src/codecs/bmp';
import {
  cropRgb,
  docxMedia,
  fillRgb,
  inputOf,
  maxDiff,
  meanDiff,
  orient,
  patternRgb,
  pixel,
  preview,
  renderPdfRgb,
  rgbOf,
  run,
  unorient,
  type Rgb,
} from './helpers/hardening';

/**
 * EXIF orientation 1–8 through every action (hardening pass). The expected picture is the
 * stored pixels transformed in JS by the EXIF definition — not sharp's auto-orientation — and
 * every output is decoded without auto-orientation, so "applied exactly once, tag gone" is what
 * is measured. Crop/Redact/Annotate coordinates are in the displayed space: a wrong transform in
 * Redact would leave the selected pixels visible, so it is checked pixel-exactly.
 */

const W = 40;
const H = 24;
const CROP = { x: 5, y: 3, width: 17, height: 11 };
const RED_RECT = { x: 7, y: 5, width: 9, height: 6 };
const MOSAIC = { x: 3, y: 2, width: 20, height: 13 };

function mosaicOf(img: Rgb, rect: typeof MOSAIC, block: number): Rgb {
  const data = Buffer.from(img.data);
  for (let by = 0; by < rect.height; by += block) {
    for (let bx = 0; bx < rect.width; bx += block) {
      const bw = Math.min(block, rect.width - bx);
      const bh = Math.min(block, rect.height - by);
      const sum: [number, number, number] = [0, 0, 0];
      for (let y = 0; y < bh; y += 1) {
        for (let x = 0; x < bw; x += 1) {
          const [r, g, b] = pixel(img, rect.x + bx + x, rect.y + by + y);
          sum[0] += r;
          sum[1] += g;
          sum[2] += b;
        }
      }
      const mean = sum.map((s) => Math.round(s / (bw * bh)));
      for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) data.set(mean, ((rect.y + by + y) * img.width + rect.x + bx + x) * 3);
    }
  }
  return { data, width: img.width, height: img.height };
}

async function orientationTag(path: string | Buffer): Promise<number> {
  return (await sharp(path).metadata()).orientation ?? 1;
}

describe('EXIF orientation 1–8: every action shows the picture as displayed, exactly once', () => {
  let dir: string;
  const displayed = patternRgb(W, H);
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-hard-orient-'));
    clearPreviewCaches();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('orientation %i (JPEG)', async (o) => {
    const stored = unorient(displayed, o);
    const jpeg = await sharp(stored.data, { raw: { width: stored.width, height: stored.height, channels: 3 } })
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .withMetadata({ orientation: o })
      .toBuffer();
    expect(await orientationTag(jpeg)).toBe(o);
    const path = join(dir, `o${o}.jpg`);
    await writeFile(path, jpeg);
    const input = await inputOf(path, 'jpeg');
    // What a viewer shows: the decoded stored pixels, turned by the EXIF definition.
    const ref = orient(await rgbOf(jpeg), o);
    expect([ref.width, ref.height]).toEqual([W, H]);
    const out = async (actionId: Parameters<typeof run>[0], options: unknown): Promise<string> => (await run(actionId, [input], options, { outputDir: dir })).outputs[0]!.path;

    // Conversions: lossless targets are exact, lossy ones close; no orientation left to apply.
    for (const action of ['convert.png', 'convert.tiff'] as const) {
      const p = await out(action, {});
      expect(maxDiff(await rgbOf(p), ref), action).toBe(0);
      expect(await orientationTag(p), action).toBe(1);
    }
    for (const action of ['convert.webp', 'convert.avif'] as const) {
      const p = await out(action, { quality: 100 });
      expect(meanDiff(await rgbOf(p), ref), action).toBeLessThan(12);
      expect(await orientationTag(p), action).toBe(1);
    }
    const bmp = decodeBmp(await readFile(await out('convert.bmp', {})), 1e6);
    const bmpRgb = await sharp(bmp.data, { raw: { width: bmp.width, height: bmp.height, channels: 4 } }).removeAlpha().raw().toBuffer();
    expect(maxDiff({ data: bmpRgb, width: bmp.width, height: bmp.height }, ref)).toBe(0);
    const pdfPage = await renderPdfRgb(await out('convert.pdf', {}), 1, 1);
    expect(meanDiff(pdfPage, ref)).toBeLessThan(8);
    const docxPicture = await docxMedia(await out('convert.docx', {}));
    expect(meanDiff(await rgbOf(docxPicture, { orient: true }), ref)).toBeLessThan(8);
    expect(await orientationTag(docxPicture)).toBe(1);

    // Tools: coordinates are displayed pixels.
    expect(maxDiff(await rgbOf(await out('tool.crop', { rect: CROP, outputFormat: 'png' })), cropRgb(ref, CROP.x, CROP.y, CROP.width, CROP.height))).toBe(0);
    const cropJpeg = await out('tool.crop', { rect: CROP });
    expect(meanDiff(await rgbOf(cropJpeg), cropRgb(ref, CROP.x, CROP.y, CROP.width, CROP.height))).toBeLessThan(6);
    expect(await orientationTag(cropJpeg)).toBe(1);
    const background = { background: { kind: 'solid', color: '#FF00FF' }, padding: 0, cornerRadius: 0, shadow: 0, ratio: 'auto', maxEdge: 8000, format: 'png', quality: 90 };
    expect(maxDiff(await rgbOf(await out('tool.addBackground', background)), ref)).toBe(0);
    expect(maxDiff(await rgbOf(await out('tool.edit', { outputFormat: 'png' })), ref)).toBe(0);
    expect(maxDiff(await rgbOf(await out('tool.edit', { rotate: 90, outputFormat: 'png' })), orient(ref, 6))).toBe(0);
    const solid = await rgbOf(await out('tool.redact', { regions: [{ id: 'r', rect: RED_RECT, style: 'solid', color: '#00FF00' }], outputFormat: 'png' }));
    expect(maxDiff(solid, fillRgb(ref, RED_RECT, [0, 255, 0]))).toBe(0);
    const mosaic = await rgbOf(await out('tool.redact', { regions: [{ id: 'm', rect: MOSAIC, style: 'mosaic', blockSize: 4 }], outputFormat: 'png' }));
    expect(maxDiff(mosaic, mosaicOf(ref, MOSAIC, 4))).toBe(0);
    const annotated = await rgbOf(await out('tool.annotate', { shapes: [{ id: 'a', type: 'rect', x: 10, y: 6, width: 12, height: 8, color: '#FF0000', strokeWidth: 2 }], outputFormat: 'png' }));
    expect(pixel(annotated, 16, 6)).toEqual([255, 0, 0]);
    expect(maxDiff(cropRgb(annotated, 12, 8, 8, 4), cropRgb(ref, 12, 8, 8, 4))).toBe(0);
    expect(maxDiff(cropRgb(annotated, 0, 16, W, 8), cropRgb(ref, 0, 16, W, 8))).toBe(0);
    expect(maxDiff(await rgbOf(await out('tool.compress', { format: 'png', pngMode: 'lossless' })), ref)).toBe(0);
    const stripped = await out('tool.metadata', { mode: 'strip' });
    expect(meanDiff(await rgbOf(stripped), ref)).toBeLessThan(4);
    expect(await orientationTag(stripped)).toBe(1);

    // Previews and inspection use the same displayed space.
    const source = await preview('source', input, {}, 1000);
    expect([source.sourceWidth, source.sourceHeight]).toEqual([W, H]);
    expect(meanDiff(await rgbOf(source.data), ref)).toBeLessThan(3);
    const cropPreview = await preview('tool.crop', input, { rect: CROP }, 1000);
    expect(meanDiff(await rgbOf(cropPreview.data), cropRgb(ref, CROP.x, CROP.y, CROP.width, CROP.height))).toBeLessThan(5);
    const redactPreview = await preview('tool.redact', input, { regions: [{ id: 'r', rect: RED_RECT, style: 'solid', color: '#00FF00' }] }, 1000);
    expect(meanDiff(await rgbOf(redactPreview.data), fillRgb(ref, RED_RECT, [0, 255, 0]))).toBeLessThan(3);
    const info = await inspectImage(input, DEFAULT_PROCESSING_LIMITS);
    expect([info.orientation, info.orientedWidth, info.orientedHeight]).toEqual([o, W, H]);
  });

  it.each([
    ['png', 3],
    ['png', 6],
    ['png', 7],
    ['tiff', 5],
    ['tiff', 8],
  ] as const)('16-bit %s with orientation %i: Crop, Redact, Edit and conversion follow the displayed picture', async (format, o) => {
    // 16-bit with an sRGB profile (withMetadata attaches one): the displayed colours are the
    // 8-bit source values, so `displayed` is the reference (no 16-bit decode by sharp needed).
    const stored = unorient(displayed, o);
    let pipeline = sharp(stored.data, { raw: { width: stored.width, height: stored.height, channels: 3 } }).toColourspace('rgb16').withMetadata({ orientation: o });
    pipeline = format === 'png' ? pipeline.png() : pipeline.tiff({ compression: 'lzw' });
    const data = await pipeline.toBuffer();
    expect(await sharp(data).metadata()).toMatchObject({ depth: 'ushort', orientation: o });
    const path = join(dir, `o${o}-16.${format}`);
    await writeFile(path, data);
    const input = await inputOf(path, format);
    const out = async (actionId: Parameters<typeof run>[0], options: unknown): Promise<Rgb> => rgbOf((await run(actionId, [input], options, { outputDir: dir })).outputs[0]!.path);
    expect(maxDiff(await out('tool.crop', { rect: CROP, outputFormat: 'png' }), cropRgb(displayed, CROP.x, CROP.y, CROP.width, CROP.height))).toBeLessThanOrEqual(1);
    expect(maxDiff(await out('tool.redact', { regions: [{ id: 'r', rect: RED_RECT, style: 'solid', color: '#00FF00' }], outputFormat: 'png' }), fillRgb(displayed, RED_RECT, [0, 255, 0]))).toBeLessThanOrEqual(1);
    expect(maxDiff(await out('tool.edit', { outputFormat: 'png' }), displayed)).toBeLessThanOrEqual(1);
    expect(maxDiff(await out(format === 'png' ? 'convert.tiff' : 'convert.png', {}), displayed)).toBeLessThanOrEqual(1);
  });
});
