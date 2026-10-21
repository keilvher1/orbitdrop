import { Document, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import {
  OrbitError,
  isImageFormat,
  type ConvertOptions,
  type JobWarning,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorRunContext,
} from '@orbitdrop/contracts';
import { convertedName } from '@orbitdrop/core';
import { readInputBuffer } from '../common/io';
import { linesToParagraphs } from '../pdf/text';
import { OutputLedger, extensionMismatchWarning, reporter, throwIfCancelled, toOrbitError, writableOutputDir } from './common';
import { exactBytes, prepareImage } from './images-to-pdf';
import { extractDocumentText, pagesWithoutTextWarning } from './pdf-to-text';

/**
 * DOCX output (P2).
 *  - PDF → "text-centric DOCX": the extracted text as re-flowable paragraphs,
 *    one Word page break per PDF page. Layout, fonts, tables, columns and
 *    images are NOT reproduced (DOCX_TEXT_ONLY warning). No text → PDF_NO_TEXT.
 *  - Image → DOCX: a document containing the image (no OCR, DOCX_IMAGE_ONLY
 *    warning), scaled down to fit the A4 text area.
 */

/** A4 portrait with 1-inch margins, in twips (1/20 pt). */
const PAGE = { width: 11_906, height: 16_838, margin: 1_440 } as const;
const TWIPS_PER_INCH = 1_440;
/** docx ImageRun sizes are in CSS pixels (96 per inch). */
const PX_PER_INCH = 96;

function sectionPage() {
  return {
    size: { width: PAGE.width, height: PAGE.height },
    margin: { top: PAGE.margin, right: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin },
  };
}

async function pack(doc: Document): Promise<Buffer> {
  return Packer.toBuffer(doc);
}

export async function convertPdfToDocx(
  job: ProcessorJob,
  input: ProcessorInput,
  _options: ConvertOptions,
  ctx: ProcessorRunContext,
): Promise<ProcessorResult> {
  const progress = reporter(ctx);
  const dir = await writableOutputDir(job, input);
  const { pages, emptyPages } = await extractDocumentText(job, input, ctx, progress);
  throwIfCancelled(ctx.signal);
  progress({ kind: 'indeterminate', stage: 'encoding' });

  const children: Paragraph[] = [];
  pages.forEach((page, index) => {
    const paragraphs = linesToParagraphs(page.lines, page.columnWidth);
    const pageBreakBefore = index > 0;
    if (paragraphs.length === 0) {
      // Keep the page structure for pages without text.
      children.push(new Paragraph({ pageBreakBefore }));
      return;
    }
    paragraphs.forEach((text, i) => {
      children.push(new Paragraph({ children: [new TextRun(text)], pageBreakBefore: pageBreakBefore && i === 0 }));
    });
  });

  let data: Buffer;
  try {
    data = await pack(new Document({ creator: 'OrbitDrop', sections: [{ properties: { page: sectionPage() }, children }] }));
  } catch (error) {
    throw toOrbitError(error, ctx.signal);
  }
  throwIfCancelled(ctx.signal);
  progress({ kind: 'indeterminate', stage: 'writing' });
  const ledger = new OutputLedger(ctx.onCommitted);
  const output = await ledger.commit(dir, convertedName(input.displayName, '.docx'), job.jobId, data, ctx.signal, {
    format: 'docx',
    pages: pages.length,
  });

  const warnings: JobWarning[] = [{ code: 'DOCX_TEXT_ONLY' }];
  const mismatch = extensionMismatchWarning(input);
  if (mismatch) warnings.push(mismatch);
  const empty = pagesWithoutTextWarning(emptyPages);
  if (empty) warnings.push(empty);
  return { outputs: [output], warnings };
}

/** Image size in docx pixels: physical size, scaled down to the text area (never enlarged). */
export function docxImageSize(pixelWidth: number, pixelHeight: number, density: number): { width: number; height: number } {
  const maxW = ((PAGE.width - 2 * PAGE.margin) / TWIPS_PER_INCH) * PX_PER_INCH;
  // Leave a little room below the image so Word keeps it on one page.
  const maxH = (((PAGE.height - 2 * PAGE.margin) / TWIPS_PER_INCH) * PX_PER_INCH) * 0.97;
  const naturalW = (pixelWidth / density) * PX_PER_INCH;
  const naturalH = (pixelHeight / density) * PX_PER_INCH;
  const scale = Math.min(1, maxW / naturalW, maxH / naturalH);
  return { width: Math.max(1, Math.round(naturalW * scale)), height: Math.max(1, Math.round(naturalH * scale)) };
}

export async function convertImageToDocx(
  job: ProcessorJob,
  input: ProcessorInput,
  options: ConvertOptions,
  ctx: ProcessorRunContext,
): Promise<ProcessorResult> {
  if (!isImageFormat(input.format)) throw new OrbitError('UNSUPPORTED_FORMAT', 'Input is not an image');
  const progress = reporter(ctx);
  progress({ kind: 'indeterminate', stage: 'reading' });
  const dir = await writableOutputDir(job, input);
  const buffer = await readInputBuffer(input, job.limits, ctx.signal);
  throwIfCancelled(ctx.signal);
  progress({ kind: 'indeterminate', stage: 'decoding' });
  const prepared = await prepareImage(buffer, input, job.limits, options.keepMetadata);
  throwIfCancelled(ctx.signal);
  progress({ kind: 'indeterminate', stage: 'encoding' });
  const size = docxImageSize(prepared.width, prepared.height, prepared.density);
  let data: Buffer;
  try {
    const image = new ImageRun({ type: prepared.kind, data: exactBytes(prepared.bytes), transformation: size });
    data = await pack(
      new Document({
        creator: 'OrbitDrop',
        sections: [{ properties: { page: sectionPage() }, children: [new Paragraph({ children: [image] })] }],
      }),
    );
  } catch (error) {
    throw toOrbitError(error, ctx.signal);
  }
  throwIfCancelled(ctx.signal);
  progress({ kind: 'indeterminate', stage: 'writing' });
  const ledger = new OutputLedger(ctx.onCommitted);
  const output = await ledger.commit(dir, convertedName(input.displayName, '.docx'), job.jobId, data, ctx.signal, {
    format: 'docx',
    pages: 1,
  });
  const warnings: JobWarning[] = [{ code: 'DOCX_IMAGE_ONLY' }];
  const mismatch = extensionMismatchWarning(input);
  if (mismatch) warnings.push(mismatch);
  if (prepared.metadataRemoved.length > 0) warnings.push({ code: 'METADATA_REMOVED', params: { kinds: prepared.metadataRemoved.join(',') } });
  return { outputs: [output], warnings };
}
