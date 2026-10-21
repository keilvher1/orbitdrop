/**
 * Editor flows end to end through the public processor API (no Electron), the
 * way the editor windows drive it: inspect → 'source' preview → map the
 * selection from preview pixels to oriented source pixels → tool previews →
 * commit (runJob). Results are re-read and checked; originals stay untouched
 * and no temp files are left behind.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROCESSING_LIMITS,
  formatFromExtension,
  type ActionId,
  type PreviewKind,
  type PreviewResult,
  type ProcessorInput,
  type ProcessorResult,
  type ProcessorSettings,
} from '@orbitdrop/contracts';
import { computeCompositionLayout } from '@orbitdrop/core';
import { inspectImage, renderPreview, runJob } from '@orbitdrop/processors';

const settings: ProcessorSettings = { pdfDpi: 300, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 };
const limits = DEFAULT_PROCESSING_LIMITS;

const sha256 = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex');

async function inputFor(path: string): Promise<ProcessorInput> {
  const info = await stat(path);
  return {
    fileId: randomUUID().replace(/-/g, '').slice(0, 12),
    path,
    displayName: basename(path),
    sourceDir: dirname(path),
    format: formatFromExtension(path.slice(path.lastIndexOf('.')))!,
    bytes: info.size,
  };
}

async function run(actionId: ActionId, input: ProcessorInput, options: unknown, assets?: Record<string, ProcessorInput>): Promise<ProcessorResult> {
  return runJob(
    { jobId: `job-${randomUUID().slice(0, 8)}`, actionId, inputs: [input], options, outputDir: null, settings, limits, ...(assets ? { assets } : {}) },
    { signal: new AbortController().signal, onProgress: () => {} },
  );
}

async function previewOf(kind: PreviewKind, input: ProcessorInput, options: unknown, maxEdge: number, assets?: Record<string, ProcessorInput>): Promise<PreviewResult> {
  return renderPreview(
    { previewId: randomUUID(), kind, input, options, maxEdge, settings, limits, ...(assets ? { assets } : {}) },
    { signal: new AbortController().signal },
  );
}

async function rgba(input: string | Uint8Array): Promise<{ data: Buffer; width: number; height: number; at: (x: number, y: number) => number[] }> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, at: (x, y) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)) };
}

const close = (a: readonly number[], b: readonly number[], tol: number): boolean => b.every((v, i) => Math.abs((a[i] ?? 0) - v) <= tol);

/** A "phone photo": stored 1200×800 landscape with orientation 6 (displayed 800×1200 portrait), camera EXIF. */
async function phonePhoto(path: string): Promise<void> {
  const w = 1200;
  const h = 800;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      // stored left half warm, right half cool; a white "document" square in the stored top-left quarter
      const i = (y * w + x) * 3;
      const doc = x >= 100 && x < 500 && y >= 100 && y < 300;
      raw.set(doc ? [255, 255, 255] : x < w / 2 ? [220, 90, 40] : [40, 90, 220], i);
    }
  }
  const jpeg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 92 })
    .withExif({ IFD0: { Make: 'PhoneMaker', Model: 'Phone 1' } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  await writeFile(path, jpeg);
}

describe('editor flows through the public processor API', () => {
  let dir: string;
  let photo: string;
  let photoHash: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-editors-'));
    photo = join(dir, '휴가 사진.jpg');
    await phonePhoto(photo);
    photoHash = await sha256(photo);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('crop editor: preview-pixel selection maps to oriented source pixels', async () => {
    const input = await inputFor(photo);
    const info = await inspectImage(input, limits);
    expect(info.orientation).toBe(6);
    expect([info.orientedWidth, info.orientedHeight]).toEqual([800, 1200]);
    expect(info.exif?.make).toBe('PhoneMaker');

    const source = await previewOf('source', input, {}, 480);
    expect([source.sourceWidth, source.sourceHeight]).toEqual([800, 1200]);
    expect([source.width, source.height]).toEqual([320, 480]);

    // The stored document square (x 100..500, y 100..300) is displayed at oriented x 500..700, y 100..500.
    // In the 320×480 preview that is x 200..280, y 40..200 — the user drags a 1:1 selection there.
    const k = source.sourceWidth / source.width;
    const sel = { x: 200, y: 40, width: 80, height: 80 };
    const rect = { x: Math.round(sel.x * k), y: Math.round(sel.y * k), width: Math.round(sel.width * k), height: Math.round(sel.height * k) };
    expect(rect).toEqual({ x: 500, y: 100, width: 200, height: 200 });

    const cropPreview = await previewOf('tool.crop', input, { rect, aspect: '1:1' }, 200);
    expect([cropPreview.outputWidth, cropPreview.outputHeight]).toEqual([200, 200]);
    const result = await run('tool.crop', input, { rect, aspect: '1:1' });
    const out = result.outputs[0]!;
    expect(out.path).toBe(join(dir, '휴가 사진 Cropped.jpg'));
    const img = await rgba(out.path);
    expect([img.width, img.height]).toEqual([200, 200]);
    // entirely inside the white document
    for (const [x, y] of [
      [10, 10],
      [190, 10],
      [10, 190],
      [190, 190],
      [100, 100],
    ] as const) {
      expect(close(img.at(x, y), [255, 255, 255], 12), `${x},${y}`).toBe(true);
    }
    const meta = await sharp(out.path).metadata();
    expect(meta.exif).toBeUndefined();
    expect(await sha256(photo)).toBe(photoHash);
  });

  it('add background editor: the preview layout is the final layout, then "… With Background.png"', async () => {
    const cropped = join(dir, '휴가 사진 Cropped.jpg');
    const input = await inputFor(cropped);
    const spec = {
      background: { kind: 'preset', presetId: 'ocean' },
      padding: 64,
      cornerRadius: 24,
      shadow: 32,
      ratio: '16:9',
      maxEdge: 2400,
      format: 'png',
      quality: 90,
    } as const;
    const p = await previewOf('tool.addBackground', input, spec, 320);
    const layout = computeCompositionLayout(200, 200, spec);
    expect(p.layout).toEqual(layout);
    expect(layout.paddingExpandedByRatio).toBe(true);
    expect([p.outputWidth, p.outputHeight]).toEqual([layout.canvas.width, layout.canvas.height]);
    expect(p.width).toBe(320);

    const result = await run('tool.addBackground', input, spec);
    const out = result.outputs[0]!;
    expect(out.path).toBe(join(dir, '휴가 사진 Cropped With Background.png'));
    const img = await rgba(out.path);
    expect([img.width, img.height]).toEqual([layout.canvas.width, layout.canvas.height]);
    // background gradient at the edges, white document in the centre, rounded corner shows background
    const c = layout.content;
    expect(close(img.at(c.x + c.width / 2, c.y + c.height / 2), [255, 255, 255], 12)).toBe(true);
    expect(close(img.at(c.x, c.y), [255, 255, 255], 30)).toBe(false);
    expect(img.at(1, 1)[3]).toBe(255);
    // the preview, upscaled, looks like the final export
    const prev = await rgba(p.data);
    const small = await rgba(await sharp(out.path).resize(prev.width, prev.height, { fit: 'fill' }).png().toBuffer());
    let diff = 0;
    for (let i = 0; i < prev.data.length; i += 4) for (let ch = 0; ch < 3; ch += 1) diff += Math.abs(prev.data[i + ch]! - small.data[i + ch]!);
    expect(diff / ((prev.data.length / 4) * 3)).toBeLessThan(3);
  });

  it('add background with a user background image (cover) as a JPEG', async () => {
    const bgPath = join(dir, 'texture.png');
    await sharp({ create: { width: 300, height: 100, channels: 3, background: '#8040C0' } }).png().toFile(bgPath);
    const bg = await inputFor(bgPath);
    const input = await inputFor(photo);
    const spec = { background: { kind: 'image', fileId: bg.fileId }, padding: 40, cornerRadius: 0, shadow: 0, ratio: '1:1', maxEdge: 600, format: 'jpeg', quality: 85 } as const;
    const result = await run('tool.addBackground', input, spec, { [bg.fileId]: bg });
    const out = result.outputs[0]!;
    expect(out.path).toBe(join(dir, '휴가 사진 With Background.jpg'));
    const img = await rgba(out.path);
    expect([img.width, img.height]).toEqual([600, 600]);
    expect(close(img.at(5, 300), [0x80, 0x40, 0xc0], 10)).toBe(true);
    const layout = computeCompositionLayout(800, 1200, spec);
    expect(layout.contentScale).toBeLessThan(1);
  });

  it('metadata, redact, annotate, edit and compress produce real files next to the original', async () => {
    const input = await inputFor(photo);
    const stripped = await run('tool.metadata', input, { mode: 'strip' });
    expect(stripped.outputs[0]!.path).toBe(join(dir, '휴가 사진 No Metadata.jpg'));
    const sm = await sharp(stripped.outputs[0]!.path).metadata();
    expect(sm.exif).toBeUndefined();
    expect([sm.width, sm.height]).toEqual([800, 1200]); // orientation applied to the pixels

    const redacted = await run('tool.redact', input, { regions: [{ id: 'r1', rect: { x: 500, y: 100, width: 200, height: 400 }, style: 'solid', color: '#000000' }] });
    const rimg = await rgba(redacted.outputs[0]!.path);
    expect(close(rimg.at(600, 300), [0, 0, 0], 6)).toBe(true);
    expect((await sharp(redacted.outputs[0]!.path).metadata()).exif).toBeUndefined();

    const annotated = await run('tool.annotate', input, {
      shapes: [{ id: 't', type: 'text', x: 520, y: 140, text: '여기', color: '#FF0000', fontSize: 60, bold: true }],
    });
    const aimg = await rgba(annotated.outputs[0]!.path);
    let red = 0;
    for (let y = 130; y < 220; y += 1) for (let x = 510; x < 680; x += 1) if (close(aimg.at(x, y), [255, 0, 0], 60)) red += 1;
    expect(red).toBeGreaterThan(400);

    const edited = await run('tool.edit', input, { rotate: 270, brightness: 10 });
    const em = await sharp(edited.outputs[0]!.path).metadata();
    expect([em.width, em.height]).toEqual([1200, 800]);

    const compressed = await run('tool.compress', input, { quality: 50, format: 'webp' });
    expect(compressed.outputs[0]!.path).toBe(join(dir, '휴가 사진 Compressed.webp'));
    expect((await sharp(compressed.outputs[0]!.path).metadata()).format).toBe('webp');

    expect(await sha256(photo)).toBe(photoHash);
    const names = (await readdir(dir)).sort();
    expect(names.filter((n) => n.startsWith('.'))).toEqual([]);
    expect(names).toEqual(
      [
        'texture.png',
        '휴가 사진 Annotated.jpg',
        '휴가 사진 Compressed.webp',
        '휴가 사진 Cropped With Background.png',
        '휴가 사진 Cropped.jpg',
        '휴가 사진 Edited.jpg',
        '휴가 사진 No Metadata.jpg',
        '휴가 사진 Redacted.jpg',
        '휴가 사진 With Background.jpg',
        '휴가 사진.jpg',
      ].sort(),
    );
  });
});
