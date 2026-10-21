import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileFormat, ToolActionId } from '@orbitdrop/contracts';
import { bmp24, inputFor, listDir, makeTempDir, noisyRaw, preview, readBmp, removeDir, runToolJob, sha256, writeFixture } from './helpers/tools-fixtures';

/**
 * Robustness matrix: every tool on many kinds of input (bit depths, alpha, colour
 * spaces, containers). Each run must succeed, leave the input untouched and
 * write a decodable file of the expected size.
 */

const W = 64;
const H = 48;

interface Variant {
  readonly name: string;
  readonly ext: string;
  readonly format?: FileFormat;
  make(): Promise<Buffer>;
}

const rgb = noisyRaw(W, H, 21, 80);
const rgba = (() => {
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) out.set([rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!, (i % W) * 4], i * 4);
  return out;
})();

const variants: Variant[] = [
  { name: 'jpeg', ext: '.jpg', make: () => sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 90 }).toBuffer() },
  { name: 'jpeg-cmyk', ext: '.jpg', make: () => sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).withIccProfile('cmyk').jpeg({ quality: 90 }).toBuffer() },
  { name: 'jpeg-grey', ext: '.jpg', make: () => sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).toColourspace('b-w').jpeg().toBuffer() },
  { name: 'png-rgba', ext: '.png', make: () => sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer() },
  { name: 'png-16bit', ext: '.png', make: () => sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).toColourspace('rgb16').png().toBuffer() },
  { name: 'png-grey-alpha', ext: '.png', make: () => sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).toColourspace('b-w').png().toBuffer() },
  { name: 'png-palette', ext: '.png', make: () => sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png({ palette: true, colours: 16 }).toBuffer() },
  { name: 'webp-alpha', ext: '.webp', make: () => sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).webp({ quality: 80 }).toBuffer() },
  { name: 'webp-lossless', ext: '.webp', make: () => sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).webp({ lossless: true }).toBuffer() },
  { name: 'avif', ext: '.avif', make: () => sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).avif({ quality: 60 }).toBuffer() },
  { name: 'tiff', ext: '.tiff', make: () => sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).tiff({ compression: 'lzw' }).toBuffer() },
  {
    name: 'gif-animated',
    ext: '.gif',
    make: () =>
      sharp(Buffer.concat([rgb, Buffer.from(rgb).reverse(), rgb]), { raw: { width: W, height: H * 3, channels: 3, pageHeight: H } })
        .gif({ delay: [100, 100, 100], loop: 0 })
        .toBuffer(),
  },
  { name: 'bmp', ext: '.bmp', make: async () => bmp24(rgb, W, H) },
];

const TOOLS: readonly [ToolActionId, unknown][] = [
  ['tool.crop', { rect: { x: 8, y: 4, width: 40, height: 30 } }],
  ['tool.addBackground', { background: { kind: 'preset', presetId: 'mint' }, padding: 10, cornerRadius: 6, shadow: 8, ratio: '1:1', maxEdge: 256, format: 'png', quality: 90 }],
  ['tool.compress', { quality: 60 }],
  ['tool.metadata', { mode: 'strip' }],
  ['tool.edit', { rotate: 90, flipH: true, brightness: 10, contrast: 10, saturation: 10 }],
  ['tool.annotate', { shapes: [{ id: 'a', type: 'arrow', x1: 5, y1: 5, x2: 50, y2: 40, color: '#FF0000', strokeWidth: 3 }, { id: 't', type: 'text', x: 4, y: 4, text: '가', color: '#000000', fontSize: 12, bold: true }] }],
  ['tool.redact', { regions: [{ id: 'm', rect: { x: 0, y: 0, width: 32, height: 24 }, style: 'mosaic', blockSize: 8 }, { id: 's', rect: { x: 40, y: 30, width: 10, height: 10 }, style: 'solid', color: '#000000' }] }],
];

const expectedSize: Record<string, [number, number]> = {
  'tool.crop': [40, 30],
  'tool.addBackground': [84, 84],
  'tool.compress': [W, H],
  'tool.metadata': [W, H],
  'tool.edit': [H, W],
  'tool.annotate': [W, H],
  'tool.redact': [W, H],
};

async function decodedSize(path: string): Promise<[number, number]> {
  const data = await readFile(path);
  if (data.toString('latin1', 0, 2) === 'BM') {
    const img = readBmp(data);
    return [img.width, img.height];
  }
  const { info } = await sharp(data).raw().toBuffer({ resolveWithObject: true });
  return [info.width, info.height];
}

describe('tools × input variants', () => {
  let dir: string;
  const paths = new Map<string, string>();
  beforeAll(async () => {
    dir = await makeTempDir('matrix');
    for (const v of variants) paths.set(v.name, await writeFixture(dir, `${v.name}${v.ext}`, await v.make()));
  });
  afterAll(async () => {
    await removeDir(dir);
  });

  for (const v of variants) {
    it(`${v.name}: every tool and preview succeeds`, async () => {
      const path = paths.get(v.name)!;
      const before = await sha256(path);
      const input = await inputFor(path, v.format);
      for (const [tool, options] of TOOLS) {
        const result = await runToolJob(tool, input, options);
        expect(result.outputs, `${v.name} ${tool}`).toHaveLength(1);
        const out = result.outputs[0]!;
        expect(await decodedSize(out.path), `${v.name} ${tool}`).toEqual(expectedSize[tool]);
        expect([out.width, out.height], `${v.name} ${tool} reported size`).toEqual(expectedSize[tool]);
        const kind = tool === 'tool.metadata' ? 'source' : (tool as 'tool.crop');
        const p = await preview(kind, input, tool === 'tool.metadata' ? {} : options, 32);
        expect(Math.max(p.width, p.height), `${v.name} ${tool} preview`).toBeLessThanOrEqual(32);
      }
      expect(await sha256(path)).toBe(before);
      expect((await listDir(dir)).filter((n) => n.startsWith('.'))).toEqual([]);
    });
  }
});
