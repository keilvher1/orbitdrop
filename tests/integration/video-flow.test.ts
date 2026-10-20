/**
 * Reproduces the reference recording end to end through the real processor API
 * (no Electron): PDF → JPG, JPG → 1:1 crop, cropped JPG → Add Background PNG.
 * At the end the folder holds the original PDF and three results, each a real,
 * decodable file, and no input was modified.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROCESSING_LIMITS,
  type ActionId,
  type JobProgress,
  type ProcessorInput,
  type ProcessorResult,
  type ProcessorSettings,
} from '@orbitdrop/contracts';
import { computeCompositionLayout } from '@orbitdrop/core';
import { validateInputFile } from '@orbitdrop/core/node';
import { runJob } from '@orbitdrop/processors';

const settings: ProcessorSettings = { pdfDpi: 300, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 };

const sha256 = async (path: string): Promise<string> => createHash('sha256').update(await readFile(path)).digest('hex');

async function inputFor(path: string): Promise<ProcessorInput> {
  const v = await validateInputFile(path);
  return { fileId: randomUUID().slice(0, 8), path: v.realPath, displayName: v.displayName, sourceDir: v.sourceDir, format: v.format, bytes: v.bytes };
}

async function run(actionId: ActionId, input: ProcessorInput, options: unknown, progress: JobProgress[] = []): Promise<ProcessorResult> {
  return runJob(
    { jobId: `job-${randomUUID().slice(0, 8)}`, actionId, inputs: [input], options, outputDir: null, settings, limits: DEFAULT_PROCESSING_LIMITS },
    { signal: new AbortController().signal, onProgress: (p) => progress.push(p) },
  );
}

/** One US Letter page of text, like "Page 001.pdf" in the recording. */
async function makeLetterPdf(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Title: Nurse Turnover: Retention of the Staff', { x: 54, y: 730, size: 12, font, color: rgb(0, 0, 0) });
  for (let i = 0; i < 40; i += 1) {
    page.drawText(`Line ${i + 1}: the quick brown fox jumps over the lazy dog.`, { x: 54, y: 700 - i * 15, size: 9, font });
  }
  await writeFile(path, await doc.save());
}

describe('reference recording flow (PDF → JPG → Crop 1:1 → Add BG PNG)', () => {
  let dir: string;
  let pdfPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-video-flow-'));
    pdfPath = join(dir, 'Page 001.pdf');
    await makeLetterPdf(pdfPath);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('produces the four files of the recording, all real and decodable', async () => {
    const pdfHash = await sha256(pdfPath);

    // 1) PDF → JPG at 300 DPI
    const progress: JobProgress[] = [];
    const jpg = await run('convert.jpeg', await inputFor(pdfPath), {}, progress);
    expect(jpg.outputs).toHaveLength(1);
    const jpgPath = jpg.outputs[0]!.path;
    expect(jpgPath).toBe(join(dir, 'Page 001.jpg'));
    const jpgMeta = await sharp(jpgPath).metadata();
    expect(jpgMeta.format).toBe('jpeg');
    expect([jpgMeta.width, jpgMeta.height]).toEqual([2550, 3300]);
    expect(progress.some((p) => p.kind === 'determinate' && p.unit === 'page' && p.total === 1)).toBe(true);
    expect(await sha256(pdfPath)).toBe(pdfHash);

    // 2) JPG → Crop 1:1 (2550 × 2550 from the top, as in the recording)
    const jpgHash = await sha256(jpgPath);
    const crop = await run('tool.crop', await inputFor(jpgPath), { rect: { x: 0, y: 0, width: 2550, height: 2550 }, aspect: '1:1' });
    const croppedPath = crop.outputs[0]!.path;
    expect(croppedPath).toBe(join(dir, 'Page 001 Cropped.jpg'));
    const cropMeta = await sharp(croppedPath).metadata();
    expect(cropMeta.format).toBe('jpeg');
    expect([cropMeta.width, cropMeta.height]).toEqual([2550, 2550]);
    expect(await sha256(jpgPath)).toBe(jpgHash);

    // 3) Cropped JPG → Add Background (padding / corners / shadow like the recording) → PNG
    const spec = {
      background: { kind: 'preset', presetId: 'ember' },
      padding: 609,
      cornerRadius: 184,
      shadow: 24,
      ratio: 'auto',
      maxEdge: 2400,
      format: 'png',
      quality: 92,
    } as const;
    const croppedHash = await sha256(croppedPath);
    const bg = await run('tool.addBackground', await inputFor(croppedPath), spec);
    const pngPath = bg.outputs[0]!.path;
    expect(pngPath).toBe(join(dir, 'Page 001 Cropped With Background.png'));
    const layout = computeCompositionLayout(2550, 2550, spec);
    const png = sharp(pngPath);
    const pngMeta = await png.metadata();
    expect(pngMeta.format).toBe('png');
    expect([pngMeta.width, pngMeta.height]).toEqual([layout.canvas.width, layout.canvas.height]);
    expect(Math.max(pngMeta.width ?? 0, pngMeta.height ?? 0)).toBeLessThanOrEqual(2400);
    // The page is white in the middle, the background is a saturated gradient at the corner.
    const { data, info } = await png.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
    };
    const center = px(Math.floor(info.width / 2), Math.floor(layout.content.y + layout.content.height * 0.05));
    expect(Math.min(center[0]!, center[1]!, center[2]!)).toBeGreaterThan(200);
    const corner = px(2, 2);
    expect(corner[3]).toBe(255);
    expect(Math.max(corner[0]!, corner[1]!, corner[2]!) - Math.min(corner[0]!, corner[1]!, corner[2]!)).toBeGreaterThan(40);
    expect(await sha256(croppedPath)).toBe(croppedHash);

    // 4) Four files side by side, no leftovers
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(['Page 001 Cropped With Background.png', 'Page 001 Cropped.jpg', 'Page 001.jpg', 'Page 001.pdf']);
  });
});
