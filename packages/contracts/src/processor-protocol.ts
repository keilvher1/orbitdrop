import type { ActionId } from './actions';
import type { EngineProbe } from './capabilities';
import type { CompositionLayout } from './composition';
import type { OrbitErrorInfo } from './errors';
import type { FileFormat } from './formats';
import type { JobProgress, JobWarning } from './jobs';

/**
 * Contract between Electron main and the processing worker (an Electron
 * utilityProcess running @orbitdrop/processors), and the public API of
 * @orbitdrop/processors itself. Heavy work never runs on the main or UI thread;
 * a crashing decoder only takes down its worker, which main restarts.
 */

/** A file main has validated (exists, regular file, readable, header sniffed, realpath resolved). */
export interface ProcessorInput {
  readonly fileId: string;
  /** Absolute real path used for reading. */
  readonly path: string;
  /** Name the user dragged (used to build output names). */
  readonly displayName: string;
  /** Folder the user dragged from (outputs go here by default; may differ from dirname(path) for symlinks). */
  readonly sourceDir: string;
  /** Format detected from the header. */
  readonly format: FileFormat;
  readonly bytes: number;
}

export interface ProcessingLimits {
  readonly maxInputBytes: number;
  /** Max decoded pixels of an input image (width × height). */
  readonly maxInputPixels: number;
  readonly maxPdfPages: number;
  /**
   * Max pixels of one rendered PDF page (larger pages are rendered at a lower
   * DPI with a DOWNSCALED warning) or of a new canvas (Add Background). A page
   * costs about 12 bytes per pixel while it is rendered and copied, so 100 Mpx
   * (A0 at ~254 DPI) keeps one worker near 1.2 GB.
   */
  readonly maxOutputPixels: number;
  /** Pages rendered concurrently for PDF → image. */
  readonly pdfPageConcurrency: number;
}

export const DEFAULT_PROCESSING_LIMITS: ProcessingLimits = {
  maxInputBytes: 1024 * 1024 * 1024,
  maxInputPixels: 268_402_689,
  maxPdfPages: 2000,
  maxOutputPixels: 100_000_000,
  pdfPageConcurrency: 2,
};

export interface ProcessorSettings {
  readonly pdfDpi: 150 | 300;
  readonly jpegQuality: number;
  readonly webpQuality: number;
  readonly avifQuality: number;
  readonly heicQuality: number;
}

export interface ProcessorJob {
  readonly jobId: string;
  readonly actionId: ActionId;
  /** One input, except for merging actions (images → one PDF) where order matters. */
  readonly inputs: readonly ProcessorInput[];
  /** Raw options; the executor validates them with ACTION_OPTION_SCHEMAS. */
  readonly options: unknown;
  /** Output folder; null = the input's sourceDir. */
  readonly outputDir: string | null;
  readonly settings: ProcessorSettings;
  readonly limits: ProcessingLimits;
  /** Extra files referenced by options (e.g. a background image), keyed by fileId. */
  readonly assets?: Readonly<Record<string, ProcessorInput>>;
}

export interface ProcessorOutput {
  readonly path: string;
  readonly format: FileFormat;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly pages?: number;
}

export interface ProcessorResult {
  readonly outputs: readonly ProcessorOutput[];
  readonly warnings: readonly JobWarning[];
}

/**
 * 'source' = oriented source image downscaled for an editor canvas.
 * 'thumbnail' = a small oriented sRGB image of an input for file lists (added
 * later; decoded without filling the editors' source cache, options ignored).
 * Other kinds preview a tool's effect.
 */
export type PreviewKind = 'source' | 'thumbnail' | 'tool.addBackground' | 'tool.edit' | 'tool.compress' | 'tool.redact' | 'tool.annotate' | 'tool.crop';

export interface PreviewRequest {
  readonly previewId: string;
  readonly kind: PreviewKind;
  readonly input: ProcessorInput;
  readonly options: unknown;
  /** Longest edge of the returned preview image. */
  readonly maxEdge: number;
  readonly settings: ProcessorSettings;
  readonly limits: ProcessingLimits;
  readonly assets?: Readonly<Record<string, ProcessorInput>>;
  /**
   * 'tool.compress' only (added later; other kinds reject it with
   * INVALID_OPTIONS): report estimatedBytes / output size / format without
   * rendering an image — `data` is then empty and width/height are 0. Used for
   * the per-file estimates of a batch.
   */
  readonly estimateOnly?: boolean;
}

export interface PreviewResult {
  readonly data: Uint8Array;
  readonly mime: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly width: number;
  readonly height: number;
  /** Oriented size of the source image (for mapping editor coordinates to source pixels). */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Size of the final output these options would produce. */
  readonly outputWidth?: number;
  readonly outputHeight?: number;
  /** Compress: bytes of the real full-size encode with these options. */
  readonly estimatedBytes?: number;
  /** Add Background: layout of the final output, in final output pixels. */
  readonly layout?: CompositionLayout;
  /**
   * Tool previews: format the final output would be written in — what 'input'
   * resolves to, encoder fallbacks included (e.g. Compress HEIC → JPEG,
   * GIF → PNG). Optional (added later).
   */
  readonly outputFormat?: FileFormat;
  /**
   * Tool previews: warnings the job would report for these options, so the
   * editor can show a notice before saving (e.g. ANNOTATION_FONT_FALLBACK).
   * Omitted when there are none. Optional (added later).
   */
  readonly warnings?: readonly JobWarning[];
}

export interface ExifSummary {
  readonly make?: string;
  readonly model?: string;
  readonly lens?: string;
  readonly software?: string;
  readonly dateTimeOriginal?: string;
  readonly exposureTime?: string;
  readonly fNumber?: number;
  readonly iso?: number;
  readonly focalLength?: number;
  readonly gps: { readonly latitude: number; readonly longitude: number } | null;
  /** Other readable tags (short values only). */
  readonly other: readonly { readonly tag: string; readonly value: string }[];
}

export interface ImageInfo {
  readonly format: FileFormat;
  readonly bytes: number;
  /** Stored size. */
  readonly width: number;
  readonly height: number;
  /** Size after applying EXIF orientation (what the user sees). */
  readonly orientedWidth: number;
  readonly orientedHeight: number;
  readonly orientation: number | null;
  readonly hasAlpha: boolean;
  readonly channels: number;
  readonly space: string | null;
  readonly density: number | null;
  readonly bitDepth: string | null;
  readonly hasIccProfile: boolean;
  readonly iccDescription: string | null;
  readonly hasExif: boolean;
  readonly hasXmp: boolean;
  readonly hasIptc: boolean;
  readonly exif: ExifSummary | null;
  readonly pages: number | null;
}

/** An output file a running job has committed, reported before the job finishes (added later). */
export interface CommittedOutput {
  readonly path: string;
  /** Identity at commit time (lstat): a rollback removes the file only while all three still match. */
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
}

export interface ProcessorRunContext {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: JobProgress) => void;
  /**
   * Called right after each output file is committed (optional, added later).
   * The worker host forwards it to main (`committed` message), which removes
   * those files again when the worker dies or is killed before the job ends —
   * a crash never leaves half a result behind, and the automatic retry does
   * not write "name (2).ext" next to it.
   */
  readonly onCommitted?: (output: CommittedOutput) => void;
}

/** Public API of @orbitdrop/processors. */
export interface ProcessorApi {
  probeEngines(): Promise<EngineProbe>;
  runJob(job: ProcessorJob, ctx: ProcessorRunContext): Promise<ProcessorResult>;
  renderPreview(request: PreviewRequest, ctx: { readonly signal: AbortSignal }): Promise<PreviewResult>;
  inspectImage(input: ProcessorInput, limits: ProcessingLimits): Promise<ImageInfo>;
  /** Drop cached preview decodes (main asks when the last editor closes). */
  clearPreviewCaches(): void;
}

// ------------------------------------------------- main ⇄ worker (utilityProcess) messages

export type MainToProcessorMessage =
  | { readonly type: 'run'; readonly job: ProcessorJob }
  | { readonly type: 'cancel'; readonly jobId: string }
  | { readonly type: 'preview'; readonly request: PreviewRequest }
  | { readonly type: 'cancelPreview'; readonly previewId: string }
  | { readonly type: 'inspect'; readonly requestId: string; readonly input: ProcessorInput; readonly limits: ProcessingLimits }
  | { readonly type: 'probe'; readonly requestId: string }
  | { readonly type: 'clearPreviewCaches' }
  | { readonly type: 'shutdown' };

export type ProcessorToMainMessage =
  | { readonly type: 'ready'; readonly pid: number }
  | { readonly type: 'progress'; readonly jobId: string; readonly progress: JobProgress }
  /** An output the job has committed so far (ProcessorRunContext.onCommitted; added later). */
  | { readonly type: 'committed'; readonly jobId: string; readonly output: CommittedOutput }
  | { readonly type: 'done'; readonly jobId: string; readonly result: ProcessorResult }
  | { readonly type: 'failed'; readonly jobId: string; readonly error: OrbitErrorInfo }
  | { readonly type: 'cancelled'; readonly jobId: string }
  | { readonly type: 'previewDone'; readonly previewId: string; readonly result: PreviewResult }
  | { readonly type: 'previewFailed'; readonly previewId: string; readonly error: OrbitErrorInfo }
  | { readonly type: 'inspectDone'; readonly requestId: string; readonly info: ImageInfo }
  | { readonly type: 'inspectFailed'; readonly requestId: string; readonly error: OrbitErrorInfo }
  | { readonly type: 'probeDone'; readonly requestId: string; readonly probe: EngineProbe };
