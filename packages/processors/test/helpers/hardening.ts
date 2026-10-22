import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import sharp from 'sharp';
import {
  DEFAULT_PROCESSING_LIMITS,
  type ActionId,
  type FileFormat,
  type PreviewKind,
  type PreviewResult,
  type ProcessingLimits,
  type ProcessorInput,
  type ProcessorResult,
  type ProcessorSettings,
} from '@orbitdrop/contracts';
import { renderPreview, runJob } from '../../src';
import { loadPdfEngine, openPdf, renderPage } from '../../src/pdf/engine';
import { readZip } from './convert-fixtures';

/**
 * Helpers for the hardening tests (hardening-*.test.ts). Everything runs through the public
 * processor API (runJob / renderPreview) and every output is decoded again; expected pixels are
 * computed independently in JS (EXIF orientation, crops, mosaics) instead of with sharp's own
 * auto-orientation.
 */

export const SETTINGS: ProcessorSettings = { pdfDpi: 300, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 };

export async function inputOf(path: string, format: FileFormat): Promise<ProcessorInput> {
  return { fileId: `h${randomUUID().slice(0, 8)}`, path, displayName: basename(path), sourceDir: dirname(path), format, bytes: (await stat(path)).size };
}

export interface RunExtra {
  readonly outputDir?: string | null;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<ProcessingLimits>;
  readonly assets?: Record<string, ProcessorInput>;
  readonly onCommitted?: (output: { path: string }) => void;
}

export function run(actionId: ActionId, inputs: readonly ProcessorInput[], options: unknown, extra: RunExtra = {}): Promise<ProcessorResult> {
  return runJob(
    {
      jobId: `hard-${randomUUID().slice(0, 8)}`,
      actionId,
      inputs,
      options,
      outputDir: extra.outputDir ?? null,
      settings: SETTINGS,
      limits: { ...DEFAULT_PROCESSING_LIMITS, ...extra.limits },
      ...(extra.assets ? { assets: extra.assets } : {}),
    },
    { signal: extra.signal ?? new AbortController().signal, onProgress: () => undefined, ...(extra.onCommitted ? { onCommitted: extra.onCommitted } : {}) },
  );
}

export function preview(kind: PreviewKind, input: ProcessorInput, options: unknown, maxEdge: number, extra: { limits?: Partial<ProcessingLimits> } = {}): Promise<PreviewResult> {
  return renderPreview(
    { previewId: randomUUID(), kind, input, options, maxEdge, settings: SETTINGS, limits: { ...DEFAULT_PROCESSING_LIMITS, ...extra.limits } },
    { signal: new AbortController().signal },
  );
}

export async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? `THROW ${(error as Error).message}`;
  }
}

// ---------------------------------------------------------------- pixels

export interface Rgb {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

/** 8-bit RGB pixels as stored (no auto-orientation), colour-managed to sRGB. */
export async function rgbOf(input: string | Buffer | Uint8Array, options: { orient?: boolean } = {}): Promise<Rgb> {
  let pipeline = sharp(input);
  if (options.orient) pipeline = pipeline.autoOrient();
  const { data, info } = await pipeline.removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Source pixel (x, y) of a stored w×h image for displayed pixel (dx, dy) under EXIF orientation o. */
function sourceOf(o: number, dx: number, dy: number, w: number, h: number): [number, number] {
  switch (o) {
    case 2:
      return [w - 1 - dx, dy];
    case 3:
      return [w - 1 - dx, h - 1 - dy];
    case 4:
      return [dx, h - 1 - dy];
    case 5:
      return [dy, dx];
    case 6:
      return [dy, h - 1 - dx];
    case 7:
      return [w - 1 - dy, h - 1 - dx];
    case 8:
      return [w - 1 - dy, dx];
    default:
      return [dx, dy];
  }
}

/** The displayed image for stored pixels `s` and EXIF orientation o (the EXIF definition, in JS). */
export function orient(s: Rgb, o: number): Rgb {
  const W = o >= 5 ? s.height : s.width;
  const H = o >= 5 ? s.width : s.height;
  const data = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const [sx, sy] = sourceOf(o, x, y, s.width, s.height);
      s.data.copy(data, (y * W + x) * 3, (sy * s.width + sx) * 3, (sy * s.width + sx) * 3 + 3);
    }
  }
  return { data, width: W, height: H };
}

/** Stored pixels that display as `d` under EXIF orientation o (inverse of orient). */
export function unorient(d: Rgb, o: number): Rgb {
  const w = o >= 5 ? d.height : d.width;
  const h = o >= 5 ? d.width : d.height;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < d.height; y += 1) {
    for (let x = 0; x < d.width; x += 1) {
      const [sx, sy] = sourceOf(o, x, y, w, h);
      d.data.copy(data, (sy * w + sx) * 3, (y * d.width + x) * 3, (y * d.width + x) * 3 + 3);
    }
  }
  return { data, width: w, height: h };
}

export function cropRgb(img: Rgb, x0: number, y0: number, w: number, h: number): Rgb {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) img.data.copy(data, y * w * 3, ((y0 + y) * img.width + x0) * 3, ((y0 + y) * img.width + x0 + w) * 3);
  return { data, width: w, height: h };
}

export function fillRgb(img: Rgb, rect: { x: number; y: number; width: number; height: number }, rgb: readonly [number, number, number]): Rgb {
  const data = Buffer.from(img.data);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) for (let x = rect.x; x < rect.x + rect.width; x += 1) data.set(rgb, (y * img.width + x) * 3);
  return { data, width: img.width, height: img.height };
}

/** Largest per-channel difference (Infinity when the sizes differ). */
export function maxDiff(a: Rgb, b: Rgb): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let m = 0;
  for (let i = 0; i < a.data.length; i += 1) m = Math.max(m, Math.abs(a.data[i]! - b.data[i]!));
  return m;
}

/** Mean per-channel difference (Infinity when the sizes differ). */
export function meanDiff(a: Rgb, b: Rgb): number {
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let s = 0;
  for (let i = 0; i < a.data.length; i += 1) s += Math.abs(a.data[i]! - b.data[i]!);
  return s / a.data.length;
}

export function pixel(img: Rgb, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * 3;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

/** RGB of a PDF page rendered by the engine at `scale` (1 = 72 DPI). */
export async function renderPdfRgb(path: string, pageNumber = 1, scale = 1): Promise<Rgb> {
  const engine = await loadPdfEngine();
  const pdf = await openPdf(new Uint8Array(await readFile(path)), engine);
  try {
    const page = await pdf.doc.getPage(pageNumber);
    const rendered = await renderPage(engine, page, scale, '#FFFFFF');
    page.cleanup();
    const { data, info } = await sharp(rendered.data, { raw: { width: rendered.width, height: rendered.height, channels: 4 } })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } finally {
    await pdf.destroy();
  }
}

/** The first picture embedded in a DOCX (word/media/*). */
export async function docxMedia(path: string): Promise<Buffer> {
  const zip = readZip(await readFile(path));
  const media = [...zip.entries()].find(([name, data]) => name.startsWith('word/media/') && data.length > 0);
  if (!media) throw new Error('no picture in the DOCX');
  return media[1];
}

/** A 40×24 test picture whose every pixel is distinguishable from its mirror images. */
export function patternRgb(width = 40, height = 24): Rgb {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set([20 + ((x * 5) % 230), 20 + ((y * 9) % 230), ((x >> 3) + (y >> 3)) % 2 ? 210 : 40], (y * width + x) * 3);
    }
  }
  return { data, width, height };
}
