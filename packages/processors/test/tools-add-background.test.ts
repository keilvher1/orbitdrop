import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKGROUND_PRESETS, type AddBackgroundOptions } from '@orbitdrop/contracts';
import { computeCompositionLayout, scaleCompositionLayout } from '@orbitdrop/core';
import { cssLinearGradientLine, presetSvg } from '../src/tools/backgrounds';
import {
  BLUE,
  RED,
  inputFor,
  listDir,
  luminance,
  makeTempDir,
  meanAbsDiff,
  near,
  noisyRaw,
  preview,
  px,
  readRgba,
  removeDir,
  runToolJob,
  sha256,
  writeFixture,
} from './helpers/tools-fixtures';

const base: AddBackgroundOptions = {
  background: { kind: 'solid', color: '#20C060' },
  padding: 50,
  cornerRadius: 0,
  shadow: 0,
  ratio: 'auto',
  maxEdge: 2400,
  format: 'png',
  quality: 90,
};
const BG = [0x20, 0xc0, 0x60] as const;

describe('tool.addBackground', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('addbg');
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  async function bluePng(name: string, width: number, height: number): Promise<string> {
    return writeFixture(dir, name, await sharp({ create: { width, height, channels: 3, background: '#0000FF' } }).png().toBuffer());
  }

  it('writes "… With Background.png" with the layout size, background around and content centred', async () => {
    const path = await bluePng('photo Cropped.png', 300, 200);
    const before = await sha256(path);
    const result = await runToolJob('tool.addBackground', await inputFor(path), base);
    const out = result.outputs[0]!;
    expect(out.path.endsWith('photo Cropped With Background.png')).toBe(true);
    expect(out.format).toBe('png');
    const layout = computeCompositionLayout(300, 200, base);
    expect(layout.canvas).toEqual({ width: 400, height: 300 });
    expect([out.width, out.height]).toEqual([400, 300]);
    const meta = await sharp(out.path).metadata();
    expect([meta.width, meta.height]).toEqual([400, 300]);
    expect(meta.channels).toBe(3); // opaque result is written without alpha

    const img = await readRgba(out.path);
    for (const [x, y] of [
      [0, 0],
      [399, 0],
      [0, 299],
      [399, 299],
      [49, 150],
      [350, 150],
      [200, 49],
      [200, 250],
    ] as const) {
      expect(px(img, x, y).slice(0, 3)).toEqual([...BG]);
    }
    for (const [x, y] of [
      [50, 50],
      [349, 50],
      [50, 249],
      [349, 249],
      [200, 150],
    ] as const) {
      expect(px(img, x, y).slice(0, 3)).toEqual([...BLUE]);
    }
    expect(result.warnings).toEqual([]);
    expect(await sha256(path)).toBe(before);
    expect(await listDir(dir)).toEqual(['photo Cropped With Background.png', 'photo Cropped.png']);
  });

  it('rounds the corners (corner pixel shows the background)', async () => {
    const path = await bluePng('c.png', 200, 160);
    const opts = { ...base, cornerRadius: 40 };
    const result = await runToolJob('tool.addBackground', await inputFor(path), opts);
    const layout = computeCompositionLayout(200, 160, opts);
    expect(layout.cornerRadius).toBe(40);
    const img = await readRgba(result.outputs[0]!.path);
    const { x, y, width, height } = layout.content;
    for (const [cx, cy] of [
      [x, y],
      [x + width - 1, y],
      [x, y + height - 1],
      [x + width - 1, y + height - 1],
      [x + 5, y + 5],
    ] as const) {
      expect(px(img, cx, cy).slice(0, 3)).toEqual([...BG]);
    }
    // just inside the arc and the straight edges is content
    expect(px(img, x + 40, y + 40).slice(0, 3)).toEqual([...BLUE]);
    expect(px(img, x + 100, y).slice(0, 3)).toEqual([...BLUE]);
    expect(px(img, x, y + 80).slice(0, 3)).toEqual([...BLUE]);
    // Along the diagonal: background, then an antialiased blend on the arc, then content.
    // The arc crosses the diagonal r·(1 − 1/√2) ≈ 11.7 px from the corner.
    const diagonal = Array.from({ length: 24 }, (_, i) => px(img, x + i, y + i));
    const firstBlue = diagonal.findIndex((p) => p[0] === 0 && p[1] === 0 && p[2] === 255);
    expect(firstBlue).toBeGreaterThanOrEqual(11);
    expect(firstBlue).toBeLessThanOrEqual(13);
    expect(diagonal.slice(0, firstBlue - 1).every((p) => near(p, BG, 0))).toBe(true);
    const edge = diagonal[firstBlue - 1]!;
    expect(edge[2]).toBeGreaterThan(BG[2]);
    expect(edge[1]).toBeLessThan(BG[1]);
  });

  it('draws the shadow under the image: darker below than above, never clipped', async () => {
    const path = await bluePng('s.png', 200, 120);
    const opts = { ...base, padding: 80, shadow: 40 };
    const result = await runToolJob('tool.addBackground', await inputFor(path), opts);
    const layout = computeCompositionLayout(200, 120, opts);
    const img = await readRgba(result.outputs[0]!.path);
    const { x, y, width, height } = layout.content;
    const cx = x + width / 2;
    const below = luminance(px(img, cx, y + height + 8));
    const above = luminance(px(img, cx, y - 8));
    const bgLum = luminance(BG);
    expect(below).toBeLessThan(bgLum - 15);
    expect(above).toBeLessThan(bgLum);
    expect(below).toBeLessThan(above - 10);
    // sides are shaded symmetrically
    expect(Math.abs(luminance(px(img, x - 6, y + 60)) - luminance(px(img, x + width + 5, y + 60)))).toBeLessThan(2);
    // far away from the image the background is untouched
    expect(px(img, 1, 1).slice(0, 3)).toEqual([...BG]);
    expect(near(px(img, cx, layout.canvas.height - 1), BG, 1)).toBe(true);
    // the image itself is on top of the shadow
    expect(px(img, cx, y + height - 2).slice(0, 3)).toEqual([...BLUE]);
  });

  it('expands the margins when the shadow needs more room than the padding', async () => {
    const path = await bluePng('e.png', 200, 120);
    const opts = { ...base, padding: 0, shadow: 60 };
    const result = await runToolJob('tool.addBackground', await inputFor(path), opts);
    const layout = computeCompositionLayout(200, 120, opts);
    expect(layout.paddingExpandedByShadow).toBe(true);
    expect(layout.margins.bottom).toBe(60);
    expect([result.outputs[0]!.width, result.outputs[0]!.height]).toEqual([layout.canvas.width, layout.canvas.height]);
    const img = await readRgba(result.outputs[0]!.path);
    const cx = layout.content.x + 100;
    // the shadow fades to (almost) nothing at the canvas edge: not cut off
    expect(near(px(img, cx, layout.canvas.height - 1), BG, 2)).toBe(true);
    expect(luminance(px(img, cx, layout.canvas.height - 40))).toBeLessThan(luminance(BG) - 2);
  });

  it('fits fixed ratios and maxEdge exactly as the layout says, never upscaling', async () => {
    const path = await writeFixture(
      dir,
      'n.png',
      await sharp(noisyRaw(900, 600), { raw: { width: 900, height: 600, channels: 3 } })
        .png()
        .toBuffer(),
    );
    const input = await inputFor(path);
    for (const ratio of ['1:1', '16:9', '4:5'] as const) {
      const opts = { ...base, ratio, maxEdge: 700, padding: 30 };
      const result = await runToolJob('tool.addBackground', input, opts);
      const layout = computeCompositionLayout(900, 600, opts);
      const meta = await sharp(result.outputs[0]!.path).metadata();
      expect([meta.width, meta.height], ratio).toEqual([layout.canvas.width, layout.canvas.height]);
      expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(700);
      expect(layout.contentScale).toBeLessThan(1);
    }
    const tiny = await bluePng('t.png', 40, 30);
    const small = await runToolJob('tool.addBackground', await inputFor(tiny), { ...base, padding: 10 });
    expect([small.outputs[0]!.width, small.outputs[0]!.height]).toEqual([60, 50]);
  });

  it('renders presets as gradients (CSS angle semantics on non-square canvases)', async () => {
    // Direct check of the preset renderer: 135° on a 4:1 canvas.
    const lilac = BACKGROUND_PRESETS.find((p) => p.id === 'lilac')!;
    const img = await readRgba(await sharp(Buffer.from(presetSvg(lilac, 400, 100))).png().toBuffer());
    expect(near(px(img, 0, 0), [0xff, 0xc6, 0xe0], 3)).toBe(true);
    expect(near(px(img, 399, 99), [0xc9, 0xb8, 0xff], 3)).toBe(true);
    // equal colour along lines perpendicular to the gradient direction (1,1)/√2: (x,y) ~ (x+d, y−d)
    expect(near(px(img, 200, 80), px(img, 240, 40), 2)).toBe(true);
    expect(near(px(img, 100, 90), px(img, 180, 10), 2)).toBe(true);
    // …but not along a stretched (objectBoundingBox) diagonal
    expect(near(px(img, 200, 80), px(img, 280, 60), 2)).toBe(false);
    const line = cssLinearGradientLine(90, 400, 100);
    expect(line.x1).toBeCloseTo(0, 9);
    expect(line.y1).toBeCloseTo(50, 9);
    expect(line.x2).toBeCloseTo(400, 9);
    expect(line.y2).toBeCloseTo(50, 9);
    // 135° on 400×100: length |400·sin| + |100·cos| = 500/√2, centred → corners are 0 % and 100 %
    const diag = cssLinearGradientLine(135, 400, 100);
    expect(Math.hypot(diag.x2 - diag.x1, diag.y2 - diag.y1)).toBeCloseTo(500 / Math.SQRT2, 9);
    expect(((0 - diag.x1) * (diag.x2 - diag.x1) + (0 - diag.y1) * (diag.y2 - diag.y1)) / (500 / Math.SQRT2) ** 2).toBeCloseTo(0, 9);
    expect(((400 - diag.x1) * (diag.x2 - diag.x1) + (100 - diag.y1) * (diag.y2 - diag.y1)) / (500 / Math.SQRT2) ** 2).toBeCloseTo(1, 9);

    // Through the tool: 'cloud' is white at the top and #DCE4EE at the bottom.
    const path = await bluePng('g.png', 100, 100);
    const result = await runToolJob('tool.addBackground', await inputFor(path), { ...base, background: { kind: 'preset', presetId: 'cloud' }, padding: 100 });
    const out = await readRgba(result.outputs[0]!.path);
    expect(near(px(out, 150, 0), [255, 255, 255], 2)).toBe(true);
    expect(near(px(out, 150, 299), [0xdc, 0xe4, 0xee], 2)).toBe(true);
    // a radial preset paints colourful corners
    const ember = await runToolJob('tool.addBackground', await inputFor(path), { ...base, background: { kind: 'preset', presetId: 'ember' }, padding: 100 });
    const e = await readRgba(ember.outputs[0]!.path);
    const corner = px(e, 3, 3);
    expect(Math.max(...corner.slice(0, 3)) - Math.min(...corner.slice(0, 3))).toBeGreaterThan(60);
    await expect(
      runToolJob('tool.addBackground', await inputFor(path), { ...base, background: { kind: 'preset', presetId: 'nope' } }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });

  it('fills an image background with cover (only the background is cropped)', async () => {
    // Background 200×100: left half red, right half blue. Canvas will be square → sides cropped.
    const bgRaw = Buffer.alloc(200 * 100 * 3);
    for (let y = 0; y < 100; y += 1) for (let x = 0; x < 200; x += 1) bgRaw.set(x < 100 ? RED : BLUE, (y * 200 + x) * 3);
    const bgPath = await writeFixture(dir, 'bg.png', await sharp(bgRaw, { raw: { width: 200, height: 100, channels: 3 } }).png().toBuffer());
    const contentPath = await writeFixture(dir, 'content.png', await sharp({ create: { width: 100, height: 100, channels: 3, background: '#FFFF00' } }).png().toBuffer());
    const bgInput = await inputFor(bgPath);
    const opts: AddBackgroundOptions = { ...base, background: { kind: 'image', fileId: bgInput.fileId }, padding: 50 };
    const result = await runToolJob('tool.addBackground', await inputFor(contentPath), opts, { assets: { [bgInput.fileId]: bgInput } });
    const img = await readRgba(result.outputs[0]!.path);
    expect([img.width, img.height]).toEqual([200, 200]);
    expect(near(px(img, 2, 100), RED, 2)).toBe(true);
    expect(near(px(img, 197, 100), BLUE, 2)).toBe(true);
    // content complete (all four corners are yellow)
    for (const [x, y] of [
      [50, 50],
      [149, 50],
      [50, 149],
      [149, 149],
    ] as const) {
      expect(px(img, x, y).slice(0, 3)).toEqual([255, 255, 0]);
    }
    await expect(runToolJob('tool.addBackground', await inputFor(contentPath), opts)).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
  });

  it('writes an opaque JPEG with the chosen quality when format is jpeg', async () => {
    // Transparent content: the JPEG must be opaque (flattened composition).
    const rgba = Buffer.alloc(100 * 100 * 4);
    for (let i = 0; i < 100 * 50; i += 1) rgba.set([255, 0, 0, 255], i * 4);
    const path = await writeFixture(dir, 'half.png', await sharp(rgba, { raw: { width: 100, height: 100, channels: 4 } }).png().toBuffer());
    const result = await runToolJob('tool.addBackground', await inputFor(path), { ...base, format: 'jpeg', quality: 70 });
    const out = result.outputs[0]!;
    expect(out.path.endsWith('half With Background.jpg')).toBe(true);
    const meta = await sharp(out.path).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.channels).toBe(3);
    const img = await readRgba(out.path);
    // transparent half of the content shows the background colour, not black
    expect(near(px(img, 100, 125), BG, 12)).toBe(true);
    expect(near(px(img, 100, 75), RED, 12)).toBe(true);
    // a lower quality gives a smaller file for a noisy image
    const noisy = await writeFixture(dir, 'noisy.png', await sharp(noisyRaw(400, 300), { raw: { width: 400, height: 300, channels: 3 } }).png().toBuffer());
    const q30 = await runToolJob('tool.addBackground', await inputFor(noisy), { ...base, format: 'jpeg', quality: 30 });
    const q95 = await runToolJob('tool.addBackground', await inputFor(noisy), { ...base, format: 'jpeg', quality: 95 });
    expect(q30.outputs[0]!.bytes).toBeLessThan(q95.outputs[0]!.bytes);
  });

  it('applies EXIF orientation to the content and keeps transparency in PNG', async () => {
    const rgba = Buffer.alloc(60 * 40 * 4);
    for (let i = 0; i < 60 * 40; i += 1) rgba.set([255, 0, 0, i % 60 < 30 ? 255 : 0], i * 4);
    const path = await writeFixture(dir, 'a.png', await sharp(rgba, { raw: { width: 60, height: 40, channels: 4 } }).png().toBuffer());
    const result = await runToolJob('tool.addBackground', await inputFor(path), { ...base, padding: 10 });
    const img = await readRgba(result.outputs[0]!.path);
    expect(px(img, 20, 30).slice(0, 3)).toEqual([...RED]);
    expect(px(img, 55, 30).slice(0, 3)).toEqual([...BG]);
  });

  it('preview uses the same composition: layout in final pixels and matching pixels', async () => {
    const path = await writeFixture(
      dir,
      'p.png',
      await sharp(noisyRaw(1200, 800, 7, 20), { raw: { width: 1200, height: 800, channels: 3 } })
        .png()
        .toBuffer(),
    );
    const input = await inputFor(path);
    const opts: AddBackgroundOptions = { ...base, background: { kind: 'preset', presetId: 'aurora' }, padding: 120, cornerRadius: 90, shadow: 48, ratio: '1:1' };
    const final = await runToolJob('tool.addBackground', input, opts);
    const layout = computeCompositionLayout(1200, 800, opts);
    const p = await preview('tool.addBackground', input, opts, 360);
    expect(p.layout).toEqual(layout);
    expect([p.outputWidth, p.outputHeight]).toEqual([layout.canvas.width, layout.canvas.height]);
    expect([p.sourceWidth, p.sourceHeight]).toEqual([1200, 800]);
    const k = 360 / layout.canvas.width;
    const scaled = scaleCompositionLayout(layout, k);
    expect([p.width, p.height]).toEqual([scaled.canvas.width, scaled.canvas.height]);
    expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(360);

    // Downscale the final export to the preview size and compare.
    const finalSmall = await readRgba(await sharp(final.outputs[0]!.path).resize(p.width, p.height, { fit: 'fill' }).png().toBuffer());
    const prev = await readRgba(p.data);
    const diff = meanAbsDiff(finalSmall, prev);
    // Stated threshold: mean absolute difference below 3 levels (of 255) per channel.
    expect(diff).toBeLessThan(3);
  });
});
