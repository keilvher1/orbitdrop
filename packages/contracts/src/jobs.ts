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
  /** Metadata was dropped (default for conversions). */
  'METADATA_REMOVED',
  /** Same format as the target: file skipped. */
  'SKIPPED_SAME_FORMAT',
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
