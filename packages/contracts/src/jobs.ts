import type { ActionId } from './actions';
import type { OrbitErrorInfo } from './errors';
import type { FileFormat } from './formats';

/**
 * Every input path (global drag, Drop Zone, open dialog) goes through the same
 * pipeline: FileSelection → ActionRequest → Job → Result.
 */

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>(['completed', 'failed', 'cancelled']);

export type JobStage = 'reading' | 'decoding' | 'rendering' | 'encoding' | 'writing';

/**
 * Progress is either real (pages/files/steps counted by the processor) or
 * indeterminate. Never synthesize progress from a timer.
 */
export type JobProgress =
  | { readonly kind: 'indeterminate'; readonly stage?: JobStage }
  | { readonly kind: 'determinate'; readonly done: number; readonly total: number; readonly unit: 'page' | 'file' | 'step' };

export interface OutputFileInfo {
  /** Opaque id; renderer passes it back to reveal/open the file. */
  readonly outputId: string;
  readonly name: string;
  /** Folder shown to the user (display only; never sent back as a path). */
  readonly dirDisplay: string;
  readonly format: FileFormat;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly pages?: number;
}

/**
 * Warning codes and the `params` each one carries (all optional for readers):
 * - OUTPUT_LARGER_THAN_INPUT `{inputBytes, outputBytes}`
 * - EXTENSION_MISMATCH `{detected, extension}` (format label, extension without dot)
 * - ALPHA_FLATTENED `{background}` (#RRGGBB)
 * - DOWNSCALED `{pages, count, dpi, requestedDpi}` (pages is a summary like "2-4,7")
 * - PDF_PAGES_WITHOUT_TEXT `{pages, count}`
 * - METADATA_REMOVED `{kinds}` (comma-separated, e.g. "exif,xmp")
 * - ANNOTATION_FONT_FALLBACK `{font, characters, shapes, unreadable, hangul}`: font = family the
 *   text is drawn with ("sans-serif" when no Hangul-capable candidate is installed), characters =
 *   distinct characters it cannot draw, shapes = text shapes containing them, unreadable = text
 *   shapes with no drawable visible character, hangul = 1 when Hangul is among them (else 0).
 *   Counts only — never the text itself.
 * - FIRST_FRAME_ONLY `{frames, files}` / FIRST_PAGE_ONLY `{pages, files}`: frames/pages in the
 *   input (only the first was used), files = inputs of the job it applies to (added later)
 * - DOCX_TEXT_ONLY, DOCX_IMAGE_ONLY, SKIPPED_SAME_FORMAT: no params
 */
export const WARNING_CODES = [
  /** Compressed result is not smaller than the input. */
  'OUTPUT_LARGER_THAN_INPUT',
  /** Header and extension disagree; processed by the real format. */
  'EXTENSION_MISMATCH',
  /** Transparent pixels were flattened onto a background colour. */
  'ALPHA_FLATTENED',
  /** Image was downscaled to respect the output size limit. */
  'DOWNSCALED',
  /** Some PDF pages contained no extractable text. */
  'PDF_PAGES_WITHOUT_TEXT',
  /** DOCX contains extracted text only; layout, tables and images are not reproduced. */
  'DOCX_TEXT_ONLY',
  /** Image → DOCX embeds the picture as-is; text in it is not recognised (no OCR). */
  'DOCX_IMAGE_ONLY',
  /** Metadata was dropped (default for conversions). */
  'METADATA_REMOVED',
  /** Same format as the target: file skipped. */
  'SKIPPED_SAME_FORMAT',
  /**
   * Annotate: some text characters cannot be drawn with the installed fonts (no Hangul-capable
   * font, or a script/emoji no font covers); they appear as boxes or are missing in the result.
   */
  'ANNOTATION_FONT_FALLBACK',
  /** Animated input (GIF, WebP, APNG): only the first frame was converted or edited (added later). */
  'FIRST_FRAME_ONLY',
  /** Multi-page input (TIFF, HEIF collection): only the first page was converted or edited (added later). */
  'FIRST_PAGE_ONLY',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface JobWarning {
  readonly code: WarningCode;
  /** Optional numeric/short context, e.g. byte sizes or page numbers. Never document content. */
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface JobSnapshot {
  readonly jobId: string;
  /** Jobs created together (one per file of a batch) share a batchId. */
  readonly batchId: string | null;
  /** Drag session that produced the job, if any. */
  readonly sessionId: string | null;
  readonly actionId: ActionId;
  /** Display name of the (first) input file. */
  readonly inputName: string;
  readonly inputCount: number;
  readonly state: JobState;
  readonly progress: JobProgress;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly outputs: readonly OutputFileInfo[];
  readonly warnings: readonly JobWarning[];
  readonly error: OrbitErrorInfo | null;
  /** Input bytes (sum) — lets the UI compare sizes for compression. */
  readonly inputBytes: number;
}
