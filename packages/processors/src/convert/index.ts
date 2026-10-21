import {
  OrbitError,
  isImageFormat,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorRunContext,
} from '@orbitdrop/contracts';
import { parseConvertOptions, targetOf, throwIfCancelled, toOrbitError } from './common';
import { convertImageToImage } from './image';
import { convertImagesToPdf } from './images-to-pdf';
import { convertPdfToImages } from './pdf-to-image';
import { convertPdfToText } from './pdf-to-text';
import { convertImageToDocx, convertPdfToDocx } from './to-docx';

/**
 * convert.* executors. One job = one input, except convert.pdf which merges
 * all inputs (images) into one PDF in the confirmed order.
 *
 *   image → jpeg/png/webp/avif/tiff/bmp/heic   ./image.ts
 *   pdf   → jpeg/png (one image per page)      ./pdf-to-image.ts
 *   images → pdf                               ./images-to-pdf.ts
 *   pdf   → txt                                ./pdf-to-text.ts
 *   pdf/image → docx                           ./to-docx.ts
 *
 * Every output goes through the safe writer (temp file + exclusive commit,
 * never overwriting). Errors are OrbitErrors; document content is never logged.
 */
export async function runConvert(job: ProcessorJob, ctx: ProcessorRunContext): Promise<ProcessorResult> {
  try {
    const target = targetOf(job);
    const options = parseConvertOptions(job);
    throwIfCancelled(ctx.signal);

    if (target === 'pdf') return await convertImagesToPdf(job, options, ctx);

    if (job.inputs.length !== 1) {
      throw new OrbitError('INVALID_OPTIONS', 'This conversion takes exactly one input per job', { detail: `${job.inputs.length} inputs` });
    }
    const input = job.inputs[0]!;

    if (input.format === 'pdf') {
      switch (target) {
        case 'jpeg':
        case 'png':
          return await convertPdfToImages(job, input, target, options, ctx);
        case 'txt':
          return await convertPdfToText(job, input, options, ctx);
        case 'docx':
          return await convertPdfToDocx(job, input, options, ctx);
        default:
          throw new OrbitError('UNSUPPORTED_FORMAT', 'This conversion is not available for PDF files', { detail: `pdf → ${target}` });
      }
    }

    if (isImageFormat(input.format)) {
      if (target === 'docx') return await convertImageToDocx(job, input, options, ctx);
      if (isImageFormat(target)) return await convertImageToImage(job, input, target, options, ctx);
    }
    throw new OrbitError('UNSUPPORTED_FORMAT', 'This conversion is not available for this file', { detail: `${input.format} → ${target}` });
  } catch (error) {
    throw toOrbitError(error, ctx.signal);
  }
}
