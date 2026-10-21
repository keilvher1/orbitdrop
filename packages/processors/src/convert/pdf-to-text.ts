import {
  OrbitError,
  type ConvertOptions,
  type JobProgress,
  type JobWarning,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorRunContext,
} from '@orbitdrop/contracts';
import { convertedName } from '@orbitdrop/core';
import { readInputBytes } from '../common/io';
import { loadPdfEngine, openPdf } from '../pdf/engine';
import { extractPageText, linesToText, type PageText } from '../pdf/text';
import { OutputLedger, extensionMismatchWarning, reporter, throwIfCancelled, toOrbitError, writableOutputDir } from './common';
import { summarizePages } from './pdf-to-image';

/**
 * Text of every page in reading order (see ../pdf/text.ts). Throws PDF_NO_TEXT
 * when no page has extractable text (scanned/image-only PDFs) so callers never
 * write an empty "successful" file; reports pages without text separately.
 */
export async function extractDocumentText(
  job: ProcessorJob,
  input: ProcessorInput,
  ctx: ProcessorRunContext,
  progress: (p: JobProgress) => void,
): Promise<{ pages: PageText[]; emptyPages: number[] }> {
  progress({ kind: 'indeterminate', stage: 'reading' });
  const bytes = await readInputBytes(input, job.limits, ctx.signal);
  throwIfCancelled(ctx.signal);
  progress({ kind: 'indeterminate', stage: 'decoding' });
  const pdf = await openPdf(bytes, await loadPdfEngine(), { maxImagePixels: job.limits.maxInputPixels });
  try {
    const total = pdf.numPages;
    if (total < 1) throw new OrbitError('PDF_CORRUPT', 'PDF has no pages');
    if (total > job.limits.maxPdfPages) {
      throw new OrbitError('TOO_MANY_PAGES', 'PDF has more pages than the limit', { detail: `${total} > ${job.limits.maxPdfPages}` });
    }
    progress({ kind: 'determinate', done: 0, total, unit: 'page' });
    const pages: PageText[] = [];
    const emptyPages: number[] = [];
    for (let n = 1; n <= total; n += 1) {
      throwIfCancelled(ctx.signal);
      let text: PageText;
      try {
        const page = await pdf.doc.getPage(n);
        try {
          text = await extractPageText(page);
        } finally {
          page.cleanup();
        }
      } catch (error) {
        if (error instanceof OrbitError) throw error;
        throw new OrbitError('PDF_CORRUPT', 'PDF page text could not be read', { detail: `page ${n}`, cause: error });
      }
      pages.push(text);
      if (text.lines.length === 0) emptyPages.push(n);
      progress({ kind: 'determinate', done: n, total, unit: 'page' });
    }
    if (emptyPages.length === total) {
      throw new OrbitError('PDF_NO_TEXT', 'The PDF contains no extractable text (it may be scanned)', { detail: `${total} page(s)` });
    }
    return { pages, emptyPages };
  } finally {
    await pdf.destroy();
  }
}

export function pagesWithoutTextWarning(emptyPages: readonly number[]): JobWarning | null {
  if (emptyPages.length === 0) return null;
  return { code: 'PDF_PAGES_WITHOUT_TEXT', params: { pages: summarizePages(emptyPages), count: emptyPages.length } };
}

/** Join page texts with the chosen separator. UTF-8, LF line endings, ends with a newline. */
export function assembleText(pageTexts: readonly string[], separator: ConvertOptions['pageSeparator']): string {
  switch (separator) {
    case 'marker':
      return pageTexts.map((text, i) => `--- Page ${i + 1} ---\n${text ? `${text}\n` : ''}`).join('\n');
    case 'formfeed':
      return pageTexts.map((text) => (text ? `${text}\n` : '')).join('\f');
    case 'blank':
      return pageTexts.map((text) => (text ? `${text}\n` : '')).join('\n');
  }
}

export async function convertPdfToText(
  job: ProcessorJob,
  input: ProcessorInput,
  options: ConvertOptions,
  ctx: ProcessorRunContext,
): Promise<ProcessorResult> {
  const progress = reporter(ctx);
  const dir = await writableOutputDir(job, input);
  const { pages, emptyPages } = await extractDocumentText(job, input, ctx, progress);
  throwIfCancelled(ctx.signal);
  const text = assembleText(pages.map((page) => linesToText(page.lines)), options.pageSeparator);
  const data = new TextEncoder().encode(text);
  progress({ kind: 'indeterminate', stage: 'writing' });
  const ledger = new OutputLedger(ctx.onCommitted);
  let output;
  try {
    output = await ledger.commit(dir, convertedName(input.displayName, '.txt'), job.jobId, data, ctx.signal, {
      format: 'txt',
      pages: pages.length,
    });
  } catch (error) {
    throw toOrbitError(error, ctx.signal);
  }
  const warnings: JobWarning[] = [];
  const mismatch = extensionMismatchWarning(input);
  if (mismatch) warnings.push(mismatch);
  const empty = pagesWithoutTextWarning(emptyPages);
  if (empty) warnings.push(empty);
  return { outputs: [output], warnings };
}
