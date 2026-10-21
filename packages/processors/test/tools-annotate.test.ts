import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnnotationShape } from '@orbitdrop/contracts';
import { resolveAnnotationFont } from '../src/tools';
import {
  exifSegment,
  inputFor,
  insertJpegSegments,
  listDir,
  makeTempDir,
  meanAbsDiff,
  near,
  noisyRaw,
  preview,
  px,
  quadrantJpeg,
  readRgba,
  removeDir,
  runToolJob,
  sha256,
  writeFixture,
  type Rgba,
} from './helpers/tools-fixtures';

function countDark(img: Rgba, x0: number, y0: number, x1: number, y1: number, threshold = 100): number {
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = px(img, x, y);
      if (p[0] < threshold && p[1] < threshold && p[2] < threshold) n += 1;
    }
  }
  return n;
}

describe('tool.annotate', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('annotate');
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('uses a Hangul-capable system font', async () => {
    const font = await resolveAnnotationFont();
    expect(font.family).not.toBeNull();
    if (process.platform === 'darwin') expect(['Apple SD Gothic Neo', 'AppleGothic']).toContain(font.family);
    if (process.platform === 'win32') expect(font.family).toBe('Malgun Gothic');
    expect(font.css.startsWith(`"${font.family}"`)).toBe(true);
  });

  it('burns Korean text into a JPEG (stays JPEG) at the given top-left position', async () => {
    const path = await writeFixture(dir, 'white.jpg', await sharp({ create: { width: 480, height: 240, channels: 3, background: '#FFFFFF' } }).jpeg({ quality: 95 }).toBuffer());
    const before = await sha256(path);
    const shapes: AnnotationShape[] = [{ id: 't1', type: 'text', x: 40, y: 60, text: '한글 주석\n둘째 줄', color: '#000000', fontSize: 48, bold: true }];
    const result = await runToolJob('tool.annotate', await inputFor(path), { shapes });
    const out = result.outputs[0]!;
    expect(out.path.endsWith('white Annotated.jpg')).toBe(true);
    const meta = await sharp(out.path).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([480, 240]);
    const img = await readRgba(out.path);
    // ink inside the text box, nothing above/left of it
    expect(countDark(img, 40, 55, 300, 115)).toBeGreaterThan(800);
    expect(countDark(img, 40, 115, 300, 180)).toBeGreaterThan(500); // second line (advance 60 px)
    expect(countDark(img, 0, 0, 480, 50)).toBe(0);
    expect(countDark(img, 0, 0, 35, 240)).toBe(0);
    // Hangul glyphs differ from each other (not .notdef boxes)
    const syllable = async (text: string): Promise<Rgba> =>
      readRgba(
        (await runToolJob('tool.annotate', await inputFor(path), { shapes: [{ id: 's', type: 'text', x: 10, y: 10, text, color: '#000000', fontSize: 64, bold: false }], outputFormat: 'png' }))
          .outputs[0]!.path,
      );
    const a = await syllable('한');
    const b = await syllable('글');
    let differing = 0;
    for (let y = 0; y < 90; y += 1) for (let x = 0; x < 90; x += 1) if (px(a, x, y)[0] < 128 !== px(b, x, y)[0] < 128) differing += 1;
    expect(differing).toBeGreaterThan(300);
    expect(await sha256(path)).toBe(before);
  });

  it('draws rects and arrows with their colours at full resolution', async () => {
    const path = await writeFixture(dir, 'g.png', await sharp({ create: { width: 300, height: 200, channels: 3, background: '#808080' } }).png().toBuffer());
    const shapes: AnnotationShape[] = [
      { id: 'r', type: 'rect', x: 20, y: 20, width: 100, height: 60, color: '#FF0000', strokeWidth: 6 },
      { id: 'a', type: 'arrow', x1: 150, y1: 150, x2: 280, y2: 150, color: '#0000FF', strokeWidth: 8 },
    ];
    const result = await runToolJob('tool.annotate', await inputFor(path), { shapes });
    expect(result.outputs[0]!.path.endsWith('g Annotated.png')).toBe(true);
    const meta = await sharp(result.outputs[0]!.path).metadata();
    expect(meta.channels).toBe(3); // opaque source stays opaque
    const img = await readRgba(result.outputs[0]!.path);
    expect(px(img, 20, 50).slice(0, 3)).toEqual([255, 0, 0]);
    expect(px(img, 70, 80).slice(0, 3)).toEqual([255, 0, 0]);
    expect(px(img, 70, 50).slice(0, 3)).toEqual([128, 128, 128]);
    expect(px(img, 200, 150).slice(0, 3)).toEqual([0, 0, 255]);
    expect(px(img, 270, 150).slice(0, 3)).toEqual([0, 0, 255]);
    expect(px(img, 200, 160).slice(0, 3)).toEqual([128, 128, 128]);
    // head: length 4 × 8 = 32 (base at x = 248), half-width 16 → at x ≈ 252 it reaches y ≈ 163.75
    expect(px(img, 252, 160).slice(0, 3)).toEqual([0, 0, 255]);
    expect(px(img, 290, 150).slice(0, 3)).toEqual([128, 128, 128]);
  });

  it('uses oriented coordinates on an EXIF-rotated photo', async () => {
    const path = await writeFixture(dir, 'o.jpg', insertJpegSegments(await quadrantJpeg(320, 160), [exifSegment({ orientation: 6 })]));
    const shapes: AnnotationShape[] = [{ id: 'r', type: 'rect', x: 100, y: 250, width: 40, height: 40, color: '#000000', strokeWidth: 10 }];
    const result = await runToolJob('tool.annotate', await inputFor(path), { shapes, outputFormat: 'png' });
    const img = await readRgba(result.outputs[0]!.path);
    expect([img.width, img.height]).toEqual([160, 320]);
    expect(near(px(img, 100, 270), [0, 0, 0], 2)).toBe(true);
    expect(near(px(img, 120, 270), [0, 255, 0], 30)).toBe(true); // inside the outline: oriented BR is green
  });

  it('draws colour onto greyscale images (with or without a grey ICC profile)', async () => {
    const grey = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#777777' } }).toColourspace('b-w').jpeg({ quality: 95 }).toBuffer();
    expect((await sharp(grey).metadata()).channels).toBe(1);
    for (const [name, data] of [
      ['grey.jpg', grey],
      ['grey-icc.jpg', await sharp(grey).keepIccProfile().withIccProfile('srgb').jpeg({ quality: 95 }).toBuffer()],
    ] as const) {
      const path = await writeFixture(dir, name, data);
      const result = await runToolJob('tool.annotate', await inputFor(path), { shapes: [{ id: 'r', type: 'rect', x: 10, y: 10, width: 40, height: 30, color: '#FF0000', strokeWidth: 6 }] });
      const img = await readRgba(result.outputs[0]!.path);
      expect(near(px(img, 10, 25), [255, 0, 0], 40), name).toBe(true);
      expect(near(px(img, 30, 25), [119, 119, 119], 6), name).toBe(true);
    }
  });

  it('keeps transparency for PNG and clips shapes partly outside the image', async () => {
    const path = await writeFixture(dir, 't.png', await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
    const result = await runToolJob('tool.annotate', await inputFor(path), {
      shapes: [{ id: 'r', type: 'rect', x: -20, y: 50, width: 200, height: 30, color: '#00FF00', strokeWidth: 4 }],
    });
    const img = await readRgba(result.outputs[0]!.path);
    expect(px(img, 50, 50)).toEqual([0, 255, 0, 255]);
    expect(px(img, 50, 65)[3]).toBe(0);
    expect(px(img, 5, 5)[3]).toBe(0);
    expect((await listDir(dir)).filter((n) => n.includes('.orbitdrop-'))).toEqual([]);
  });

  it('preview draws the same shapes scaled onto the downscaled source', async () => {
    const path = await writeFixture(dir, 'p.png', await sharp(noisyRaw(800, 400, 2, 10), { raw: { width: 800, height: 400, channels: 3 } }).png().toBuffer());
    const input = await inputFor(path);
    const options = {
      shapes: [
        { id: 'r', type: 'rect', x: 100, y: 60, width: 300, height: 200, color: '#FF0000', strokeWidth: 16 },
        { id: 't', type: 'text', x: 450, y: 100, text: '미리보기', color: '#FFFFFF', fontSize: 80, bold: true },
        { id: 'a', type: 'arrow', x1: 500, y1: 350, x2: 750, y2: 250, color: '#00FFFF', strokeWidth: 12 },
      ],
    };
    const p = await preview('tool.annotate', input, options, 400);
    expect([p.width, p.height]).toEqual([400, 200]);
    expect([p.sourceWidth, p.sourceHeight]).toEqual([800, 400]);
    const prev = await readRgba(p.data);
    expect(near(px(prev, 50, 60), [255, 0, 0], 40)).toBe(true); // rect edge at x=100 → 50 in the preview
    const final = await runToolJob('tool.annotate', input, options);
    const finalSmall = await readRgba(await sharp(final.outputs[0]!.path).resize(400, 200, { fit: 'fill' }).png().toBuffer());
    expect(meanAbsDiff(finalSmall, prev)).toBeLessThan(4);
  });
});
