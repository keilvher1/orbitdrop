import type { BetaBase64ImageSource, BetaImageBlockParam, BetaRequestDocumentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import sharp from 'sharp';
import {
  ANALYSIS_LIMITS,
  OrbitError,
  type ImageFormat,
  type JobProgress,
  type JobWarning,
  type ProcessorInput,
  type ProcessorJob,
} from '@orbitdrop/contracts';
import { droppedFrames, framesWarning, mapSharpError, openImageSource, readInputBuffer, readInputBytes, type ImageSource } from '../common/io';
import { loadPdfEngine, openPdf } from '../pdf/engine';

/**
 * The file block of an analysis request (it goes before the text block):
 *  - images: decoded like every other tool (EXIF orientation applied, first frame of an animation,
 *    8 bits per channel), scaled down to fit ANALYSIS_LIMITS.maxImageEdge (never up) and sent as a
 *    JPEG at quality 85 — PNG when the picture has transparent pixels. Metadata (EXIF, GPS, XMP,
 *    ICC) is not copied: the API gets pixels only.
 *  - PDFs: the file as it is, after PDF.js has opened it — a password-protected PDF fails with
 *    PDF_ENCRYPTED and nothing is sent; more than maxPdfPages pages or more than maxPdfBytes bytes
 *    is ANALYSIS_INPUT_TOO_LARGE.
 */

export const ANALYSIS_JPEG_QUALITY = 85;

export interface PreparedFile {
  readonly block: BetaImageBlockParam | BetaRequestDocumentBlock;
  readonly warnings: readonly JobWarning[];
  /** Pages of a PDF (for the report); null for images. */
  readonly pages: number | null;
}

function base64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new OrbitError('CANCELLED', 'Cancelled');
}

/** The image copy sent to the API: scaled to fit, sRGB, JPEG q85 or (with transparency) PNG. */
export async function encodeImageForAnalysis(source: ImageSource): Promise<{ readonly data: Buffer; readonly mediaType: BetaBase64ImageSource['media_type']; readonly width: number; readonly height: number }> {
  const edge = ANALYSIS_LIMITS.maxImageEdge;
  // One lossless intermediate at the final size: its pixels decide JPEG or PNG and are encoded once.
  const { data: fitted, info } = await source
    .open()
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .png({ compressionLevel: 0, adaptiveFiltering: false })
    .toBuffer({ resolveWithObject: true });
  const transparent = source.meta.hasAlpha === true && !(await sharp(fitted).stats()).isOpaque;
  if (transparent) {
    const data = await sharp(fitted).png({ compressionLevel: 6 }).toBuffer();
    return { data, mediaType: 'image/png', width: info.width, height: info.height };
  }
  const data = await sharp(fitted).flatten({ background: '#FFFFFF' }).jpeg({ quality: ANALYSIS_JPEG_QUALITY, mozjpeg: true }).toBuffer();
  return { data, mediaType: 'image/jpeg', width: info.width, height: info.height };
}

async function prepareImage(job: ProcessorJob, input: ProcessorInput, signal: AbortSignal, progress: (p: JobProgress) => void): Promise<PreparedFile> {
  const format = input.format as ImageFormat;
  const buffer = await readInputBuffer(input, job.limits, signal);
  throwIfCancelled(signal);
  progress({ kind: 'indeterminate', stage: 'decoding' });
  let encoded: Awaited<ReturnType<typeof encodeImageForAnalysis>>;
  let source: ImageSource;
  try {
    source = await openImageSource(buffer, format, job.limits);
    throwIfCancelled(signal);
    progress({ kind: 'indeterminate', stage: 'encoding' });
    encoded = await encodeImageForAnalysis(source);
  } catch (error) {
    throw mapSharpError(error);
  }
  const dropped = droppedFrames(format, source.meta, buffer);
  return {
    block: { type: 'image', source: { type: 'base64', media_type: encoded.mediaType, data: base64(encoded.data) } },
    warnings: dropped ? [framesWarning(dropped, 1)] : [],
    pages: null,
  };
}

function tooLarge(detail: string): OrbitError {
  return new OrbitError('ANALYSIS_INPUT_TOO_LARGE', 'The PDF is larger than Claude analysis accepts', { detail });
}

async function preparePdf(job: ProcessorJob, input: ProcessorInput, signal: AbortSignal, progress: (p: JobProgress) => void): Promise<PreparedFile> {
  const maxBytes = ANALYSIS_LIMITS.maxPdfBytes;
  if (input.bytes > maxBytes) throw tooLarge(`bytes ${input.bytes} > ${maxBytes}`);
  const bytes = await readInputBytes(input, job.limits, signal);
  // The size main validated may be stale: check what was read.
  if (bytes.byteLength > maxBytes) throw tooLarge(`bytes ${bytes.byteLength} > ${maxBytes}`);
  throwIfCancelled(signal);
  progress({ kind: 'indeterminate', stage: 'decoding' });
  // PDF.js takes ownership of what it is given (its buffer is transferred): it gets a copy.
  const pdf = await openPdf(bytes.slice(), await loadPdfEngine(), { maxImagePixels: job.limits.maxInputPixels });
  let pages: number;
  try {
    pages = pdf.numPages;
  } finally {
    await pdf.destroy();
  }
  if (pages < 1) throw new OrbitError('PDF_CORRUPT', 'PDF has no pages');
  if (pages > ANALYSIS_LIMITS.maxPdfPages) throw tooLarge(`pages ${pages} > ${ANALYSIS_LIMITS.maxPdfPages}`);
  return {
    block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64(bytes) } },
    warnings: [],
    pages,
  };
}

export async function prepareAnalysisFile(job: ProcessorJob, input: ProcessorInput, signal: AbortSignal, progress: (p: JobProgress) => void): Promise<PreparedFile> {
  progress({ kind: 'indeterminate', stage: 'reading' });
  if (input.format === 'pdf') return preparePdf(job, input, signal, progress);
  if (input.format === 'docx' || input.format === 'txt' || input.format === 'md') {
    throw new OrbitError('UNSUPPORTED_FORMAT', 'Claude analysis takes images and PDFs');
  }
  return prepareImage(job, input, signal, progress);
}
