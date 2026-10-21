import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImageFormat, ProcessorInput, ToolActionId } from '@orbitdrop/contracts';
import { IMAGEIO_HELPER_ENV } from '../src/codecs/imageio';
import { canEncode, writtenFormat } from '../src/tools/common';
import { bmp24, fakeHeic, inputFor, makeTempDir, preview, quadrantJpeg, quadrantRaw, removeDir, runToolJob, writeFakeImageIOHelper, writeFixture } from './helpers/tools-fixtures';

/**
 * PreviewResult.outputFormat names the format the job writes: every tool
 * preview is compared with the real job output for the same input and options,
 * so previews and jobs cannot drift (both go through writtenFormat).
 */

const W = 48;
const H = 32;
const INPUTS = ['jpeg', 'png', 'webp', 'gif', 'tiff', 'bmp'] as const;
type InputFormat = (typeof INPUTS)[number];

async function makeInput(dir: string, format: InputFormat): Promise<ProcessorInput> {
  const raw = quadrantRaw(W, H);
  const image = () => sharp(raw, { raw: { width: W, height: H, channels: 3 } });
  switch (format) {
    case 'jpeg':
      return inputFor(await writeFixture(dir, 'in.jpg', await quadrantJpeg(W, H)));
    case 'png': {
      // Half transparent: a JPEG target must flatten it.
      const rgba = Buffer.alloc(W * H * 4);
      for (let i = 0; i < W * H; i += 1) rgba.set([20, 120, 220, i % W < W / 2 ? 255 : 0], i * 4);
      return inputFor(await writeFixture(dir, 'in.png', await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()));
    }
    case 'webp':
      return inputFor(await writeFixture(dir, 'in.webp', await image().webp({ quality: 90 }).toBuffer()));
    case 'gif':
      return inputFor(await writeFixture(dir, 'in.gif', await image().gif().toBuffer()));
    case 'tiff':
      return inputFor(await writeFixture(dir, 'in.tiff', await image().tiff().toBuffer()));
    case 'bmp':
      return inputFor(await writeFixture(dir, 'in.bmp', bmp24(raw, W, H)));
  }
}

const SAME_IMAGE_TOOLS: Readonly<Record<'tool.crop' | 'tool.edit' | 'tool.redact' | 'tool.annotate', (outputFormat: string) => unknown>> = {
  'tool.crop': (outputFormat) => ({ rect: { x: 0, y: 0, width: W, height: H }, outputFormat }),
  'tool.edit': (outputFormat) => ({ brightness: 10, outputFormat }),
  'tool.redact': (outputFormat) => ({ regions: [{ id: 'r1', rect: { x: 2, y: 2, width: 10, height: 8 }, style: 'solid' }], outputFormat }),
  'tool.annotate': (outputFormat) => ({ shapes: [{ id: 's1', type: 'rect', x: 4, y: 4, width: 20, height: 12, color: '#FF0000', strokeWidth: 2 }], outputFormat }),
};

async function previewAndJob(actionId: ToolActionId, input: ProcessorInput, options: unknown): Promise<{ preview: ImageFormat | undefined; job: ImageFormat }> {
  const p = await preview(actionId as Parameters<typeof preview>[0], input, options, 64);
  const result = await runToolJob(actionId, input, options);
  return { preview: p.outputFormat as ImageFormat | undefined, job: result.outputs[0]!.format as ImageFormat };
}

describe('PreviewResult.outputFormat', () => {
  let dir: string;
  const inputs = new Map<InputFormat, ProcessorInput>();
  let tiffOk = false;

  beforeAll(async () => {
    dir = await makeTempDir('outfmt');
    for (const format of INPUTS) inputs.set(format, await makeInput(dir, format));
    tiffOk = await canEncode('tiff');
  });
  afterAll(async () => {
    await removeDir(dir);
  });

  it.each(Object.keys(SAME_IMAGE_TOOLS) as (keyof typeof SAME_IMAGE_TOOLS)[])("%s: 'input' and explicit formats match the job for every input format", async (actionId) => {
    for (const format of INPUTS) {
      const input = inputs.get(format)!;
      const kept = await previewAndJob(actionId, input, SAME_IMAGE_TOOLS[actionId]('input'));
      expect(kept.preview, `${actionId} ${format} input`).toBe(kept.job);
      const expected = format === 'gif' ? 'png' : format === 'tiff' && !tiffOk ? 'png' : format;
      expect(kept.job, `${actionId} ${format} input`).toBe(expected);
      const webp = await previewAndJob(actionId, input, SAME_IMAGE_TOOLS[actionId]('webp'));
      expect([webp.preview, webp.job], `${actionId} ${format} → webp`).toEqual(['webp', 'webp']);
    }
  });

  it("Compress: 'input' resolves HEIC → JPEG and GIF/TIFF/BMP → PNG, and the preview says so", async () => {
    const expected: Record<InputFormat, ImageFormat> = { jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'png', tiff: 'png', bmp: 'png' };
    for (const format of INPUTS) {
      const result = await previewAndJob('tool.compress', inputs.get(format)!, { format: 'input', quality: 70 });
      expect([result.preview, result.job], format).toEqual([expected[format], expected[format]]);
    }
    const toWebp = await previewAndJob('tool.compress', inputs.get('png')!, { format: 'webp', quality: 70 });
    expect([toWebp.preview, toWebp.job]).toEqual(['webp', 'webp']);
  });

  it('Add Background reports its PNG/JPEG choice', async () => {
    const spec = { background: { kind: 'solid', color: '#FFFFFF' }, padding: 4, cornerRadius: 2, shadow: 0, ratio: 'auto', maxEdge: 400, quality: 80 };
    for (const format of ['png', 'jpeg'] as const) {
      const result = await previewAndJob('tool.addBackground', inputs.get('jpeg')!, { ...spec, format });
      expect([result.preview, result.job]).toEqual([format, format]);
    }
  });

  it('source and thumbnail previews have no output format', async () => {
    expect((await preview('source', inputs.get('jpeg')!, {}, 32)).outputFormat).toBeUndefined();
    expect((await preview('thumbnail', inputs.get('jpeg')!, {}, 32)).outputFormat).toBeUndefined();
  });

  it('writtenFormat: GIF and unavailable encoders become PNG, BMP uses the builtin codec', async () => {
    const saved = process.env[IMAGEIO_HELPER_ENV];
    delete process.env[IMAGEIO_HELPER_ENV];
    try {
      expect(await writtenFormat('gif')).toBe('png');
      expect(await writtenFormat('bmp')).toBe('bmp');
      expect(await writtenFormat('heic')).toBe('png');
      expect(await writtenFormat('avif')).toBe((await canEncode('avif')) ? 'avif' : 'png');
      for (const format of ['jpeg', 'png', 'webp'] as const) expect(await writtenFormat(format)).toBe(format);
    } finally {
      if (saved !== undefined) process.env[IMAGEIO_HELPER_ENV] = saved;
    }
  });

  it.skipIf(process.platform === 'win32')('HEIC with the ImageIO helper: tools keep HEIC, Compress writes JPEG', async () => {
    const saved = process.env[IMAGEIO_HELPER_ENV];
    process.env[IMAGEIO_HELPER_ENV] = await writeFakeImageIOHelper(dir);
    try {
      expect(await writtenFormat('heic')).toBe('heic');
      const png = await sharp(quadrantRaw(W, H), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
      const heic = await inputFor(await writeFixture(dir, 'photo.heic', fakeHeic(png)), 'heic');
      const crop = await previewAndJob('tool.crop', heic, SAME_IMAGE_TOOLS['tool.crop']('input'));
      expect([crop.preview, crop.job]).toEqual(['heic', 'heic']);
      const compress = await previewAndJob('tool.compress', heic, { format: 'input', quality: 70 });
      expect([compress.preview, compress.job]).toEqual(['jpeg', 'jpeg']);
      const written = await runToolJob('tool.crop', heic, SAME_IMAGE_TOOLS['tool.crop']('input'));
      expect((await readFile(written.outputs[0]!.path)).subarray(0, 8).toString('latin1')).toBe('FAKEHEIC');
    } finally {
      if (saved === undefined) delete process.env[IMAGEIO_HELPER_ENV];
      else process.env[IMAGEIO_HELPER_ENV] = saved;
    }
  });
});
