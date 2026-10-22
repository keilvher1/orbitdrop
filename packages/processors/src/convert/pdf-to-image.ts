import sharp from 'sharp';
import {
  FORMAT_INFO,
  OrbitError,
  type ConvertOptions,
  type JobWarning,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorOutput,
  type ProcessorResult,
  type ProcessorRunContext,
} from '@orbitdrop/contracts';
import { convertedName } from '@orbitdrop/core';
import { configureSharp, defaultQuality, readInputBytes } from '../common/io';
import { loadPdfEngine, openPdf, pageSizeAt, renderPage, type PdfPage } from '../pdf/engine';
import { OutputLedger, extensionMismatchWarning, mapWithLimit, reporter, throwIfCancelled, toOrbitError, writableOutputDir } from './common';

/**
 * PDF → JPEG/PNG, one image per page (P0-A).
 *  - Resolution: options.dpi ?? settings.pdfDpi (150/300). Page size, crop box
 *    and /Rotate come from PDF.js' viewport (US Letter @300 DPI → 2550×3300).
 *  - Pages are rendered on an opaque flattenBackground (default white); the
 *    DPI is written into the image (JFIF density / PNG pHYs).
 *  - Names: one page → "Page 001.jpg", several → "report-p001.jpg"…
 *  - A page that would exceed limits.maxOutputPixels (or 65 000 px on a side)
 *    is rendered at a lower DPI that fits → DOWNSCALED warning (pages + dpi).
 *  - Pages run with limits.pdfPageConcurrency in flight and a pixel budget
 *    (sum of in-flight canvases ≤ maxOutputPixels) so memory stays bounded.
 *  - Cancellation is checked between pages and aborts a running render. If the
 *    job fails or is cancelled, the pages it already wrote are removed
 *    (OutputLedger.rollback), so a job never leaves half a result.
 */

const MAX_SIDE = 65_000;

/** Weighted semaphore over pixels. */
class PixelBudget {
  #used = 0;
  readonly #waiters: { amount: number; resolve: () => void }[] = [];

  constructor(readonly capacity: number) {}

  async acquire(amount: number): Promise<number> {
    const take = Math.min(Math.max(1, amount), this.capacity);
    if (this.#waiters.length === 0 && this.#used + take <= this.capacity) {
      this.#used += take;
      return take;
    }
    await new Promise<void>((resolve) => this.#waiters.push({ amount: take, resolve }));
    return take;
  }

  release(amount: number): void {
    this.#used -= amount;
    while (this.#waiters.length > 0 && this.#used + this.#waiters[0]!.amount <= this.capacity) {
      const waiter = this.#waiters.shift()!;
      this.#used += waiter.amount;
      waiter.resolve();
    }
  }
}

/** Scale (= dpi / 72) for a page, lowered when the page would exceed the pixel or side limits. */
export function fitScale(width: number, height: number, scale: number, maxPixels: number): { scale: number; downscaled: boolean } {
  let factor = 1;
  const pixels = width * height;
  if (pixels > maxPixels) factor = Math.min(factor, Math.sqrt(maxPixels / pixels));
  const side = Math.max(width, height);
  if (side > MAX_SIDE) factor = Math.min(factor, MAX_SIDE / side);
  if (factor >= 1) return { scale, downscaled: false };
  // Slightly under the limit so rounding can never push the page over it.
  return { scale: scale * factor * 0.999, downscaled: true };
}

/**
 * Page encoders. Measured on a dense 300 DPI US Letter text page (2550×3300,
 * Apple M-series, sharp 0.35.5): full mozjpeg (trellis + progressive scans)
 * 520 ms / 851 KB vs. baseline + optimised Huffman + quant table 3 51 ms /
 * 1084 KB; PNG zlib level 9 386 ms / 837 KB vs. level 6 33 ms / 1002 KB.
 * Documents have many pages, so the ~10× faster settings are used (the same
 * defaults poppler's pdftoppm uses: libjpeg baseline, zlib level 6).
 */
async function encodePage(
  data: Buffer,
  width: number,
  height: number,
  dpi: number,
  target: 'jpeg' | 'png',
  quality: number,
): Promise<Buffer> {
  configureSharp();
  const image = sharp(data, { raw: { width, height, channels: 4 } }).removeAlpha().withDensity(dpi);
  if (target === 'jpeg') {
    const jpeg = await image
      .jpeg({
        quality,
        chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0',
        optimiseCoding: true,
        quantisationTable: 3,
        overshootDeringing: true,
        trellisQuantisation: false,
        optimiseScans: false,
        progressive: false,
      })
      .toBuffer();
    return withJfifDensity(jpeg, dpi);
  }
  return image.png({ compressionLevel: 6 }).toBuffer();
}

/**
 * sharp writes the DPI of a JPEG only as EXIF XResolution/YResolution (withDensity keeps EXIF,
 * and libvips then leaves out the JFIF APP0 segment), so readers that look at the JFIF density
 * saw none. A JFIF APP0 with the same density (dots per inch, rounded) goes right after SOI;
 * an existing JFIF segment gets its density set instead.
 */
export function withJfifDensity(jpeg: Buffer, dpi: number): Buffer {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const density = Math.max(1, Math.min(0xffff, Math.round(dpi)));
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0 && jpeg.length >= 18 && jpeg.toString('latin1', 6, 11) === 'JFIF\u0000') {
    const out = Buffer.from(jpeg);
    out[13] = 1; // units: dots per inch
    out.writeUInt16BE(density, 14);
    out.writeUInt16BE(density, 16);
    return out;
  }
  const app0 = Buffer.alloc(18);
  app0.set([0xff, 0xe0, 0x00, 0x10]);
  app0.write('JFIF\u0000', 4, 'latin1');
  app0.set([1, 1, 1], 9); // version 1.01, units: dots per inch
  app0.writeUInt16BE(density, 12);
  app0.writeUInt16BE(density, 14);
  return Buffer.concat([jpeg.subarray(0, 2), app0, jpeg.subarray(2)]);
}

export async function convertPdfToImages(
  job: ProcessorJob,
  input: ProcessorInput,
  target: 'jpeg' | 'png',
  options: ConvertOptions,
  ctx: ProcessorRunContext,
): Promise<ProcessorResult> {
  const progress = reporter(ctx);
  progress({ kind: 'indeterminate', stage: 'reading' });
  const dir = await writableOutputDir(job, input);
  const bytes = await readInputBytes(input, job.limits, ctx.signal);
  throwIfCancelled(ctx.signal);
  progress({ kind: 'indeterminate', stage: 'decoding' });
  const engine = await loadPdfEngine();
  const pdf = await openPdf(bytes, engine, { maxImagePixels: job.limits.maxInputPixels });
  const ledger = new OutputLedger(ctx.onCommitted);
  try {
    const total = pdf.numPages;
    if (total < 1) throw new OrbitError('PDF_CORRUPT', 'PDF has no pages');
    if (total > job.limits.maxPdfPages) {
      throw new OrbitError('TOO_MANY_PAGES', 'PDF has more pages than the limit', { detail: `${total} > ${job.limits.maxPdfPages}` });
    }
    const dpi = options.dpi ?? job.settings.pdfDpi;
    const quality = options.quality ?? defaultQuality(target, job.settings);
    const ext = FORMAT_INFO[target].extension;
    const budget = new PixelBudget(Math.max(1, job.limits.maxOutputPixels));
    const downscaled: { page: number; dpi: number }[] = [];
    let done = 0;
    progress({ kind: 'determinate', done: 0, total, unit: 'page' });

    const outputs = await mapWithLimit(
      Array.from({ length: total }, (_, i) => i),
      job.limits.pdfPageConcurrency,
      async (index): Promise<ProcessorOutput> => {
        throwIfCancelled(ctx.signal);
        let page: PdfPage;
        try {
          page = await pdf.doc.getPage(index + 1);
        } catch (error) {
          throw new OrbitError('PDF_CORRUPT', 'PDF page could not be read', { detail: `page ${index + 1}`, cause: error });
        }
        try {
          const natural = pageSizeAt(page, dpi / 72);
          const fit = fitScale(natural.width, natural.height, dpi / 72, job.limits.maxOutputPixels);
          const size = fit.downscaled ? pageSizeAt(page, fit.scale) : natural;
          const effectiveDpi = Math.round(fit.scale * 72 * 100) / 100;
          if (fit.downscaled) downscaled.push({ page: index + 1, dpi: effectiveDpi });

          const held = await budget.acquire(size.width * size.height);
          let data: Buffer;
          try {
            throwIfCancelled(ctx.signal);
            const rendered = await renderPage(engine, page, fit.scale, options.flattenBackground, ctx.signal);
            try {
              throwIfCancelled(ctx.signal);
              data = await encodePage(rendered.data, rendered.width, rendered.height, effectiveDpi, target, quality);
            } finally {
              rendered.release();
            }
          } finally {
            budget.release(held);
          }
          const output = await ledger.commit(dir, convertedName(input.displayName, ext, { index, count: total }), job.jobId, data, ctx.signal, {
            format: target,
            width: size.width,
            height: size.height,
          });
          done += 1;
          progress({ kind: 'determinate', done, total, unit: 'page' });
          return output;
        } finally {
          page.cleanup();
        }
      },
    );

    const warnings: JobWarning[] = [];
    const mismatch = extensionMismatchWarning(input);
    if (mismatch) warnings.push(mismatch);
    if (downscaled.length > 0) {
      warnings.push({
        code: 'DOWNSCALED',
        params: {
          pages: summarizePages(downscaled.map((d) => d.page)),
          count: downscaled.length,
          dpi: Math.min(...downscaled.map((d) => d.dpi)),
          requestedDpi: dpi,
        },
      });
    }
    return { outputs, warnings };
  } catch (error) {
    await ledger.rollback();
    throw toOrbitError(error, ctx.signal);
  } finally {
    await pdf.destroy();
  }
}

/** "1,2,5" — capped so warnings stay short. */
export function summarizePages(pages: readonly number[], max = 20): string {
  const sorted = [...pages].sort((a, b) => a - b);
  const head = sorted.slice(0, max).join(',');
  return sorted.length > max ? `${head},…` : head;
}
