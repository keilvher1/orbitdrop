import { z } from 'zod';
import type { ActionId, WheelMode } from './actions';
import type { CapabilitySnapshot, Platform } from './capabilities';
import type { CompositionLayout } from './composition';
import { RETRYABLE_ERROR_CODES, type ErrorCode, type OrbitErrorInfo } from './errors';
import type { FileSelection, SelectedFile } from './files';
import type { FileFormat } from './formats';
import type { JobSnapshot, JobWarning } from './jobs';
import type { WheelMenu } from './menus';
import type { ImageInfo } from './processor-protocol';
import { ActionIdSchema, Id, WheelModeSchema } from './schemas';
import type { Settings, SettingsPatch } from './settings';

/**
 * Renderer ⇄ main IPC. The preload script exposes exactly `OrbitApi` as
 * `window.orbit` via contextBridge (contextIsolation on, sandbox on,
 * nodeIntegration off). The renderer never sees or sends file-system paths:
 * it works with ids that main created (selectionId, fileId, editorId, jobId,
 * outputId). Main validates every payload with the schemas below.
 */

export const IPC_CHANNELS = {
  windowContext: 'orbit:window:context',
  windowClose: 'orbit:window:close',
  windowResize: 'orbit:window:resize',
  windowOpen: 'orbit:window:open',
  appInfo: 'orbit:app:info',
  capabilities: 'orbit:capabilities',
  settingsGet: 'orbit:settings:get',
  settingsUpdate: 'orbit:settings:update',
  settingsChanged: 'orbit:settings:changed',
  helperStatus: 'orbit:helper:status',
  helperStatusChanged: 'orbit:helper:status-changed',
  filesOpenDialog: 'orbit:files:open-dialog',
  filesRegisterPaths: 'orbit:files:register-paths',
  selectionGet: 'orbit:selection:get',
  menuGet: 'orbit:menu:get',
  actionSubmit: 'orbit:action:submit',
  editorGet: 'orbit:editor:get',
  editorPreview: 'orbit:editor:preview',
  editorInspect: 'orbit:editor:inspect',
  editorCommit: 'orbit:editor:commit',
  editorCancel: 'orbit:editor:cancel',
  editorPickBackground: 'orbit:editor:pick-background',
  /** Added for the polish pass: per-file thumbnails (images → PDF order list). */
  editorThumbnail: 'orbit:editor:thumbnail',
  /** Added for the polish pass: per-file Compress estimates of a multi-file editor. */
  editorEstimate: 'orbit:editor:estimate',
  jobsList: 'orbit:jobs:list',
  jobsChanged: 'orbit:jobs:changed',
  /** Added for the polish pass: remove finished jobs from the list and history. */
  jobsClearFinished: 'orbit:jobs:clear-finished',
  jobCancel: 'orbit:job:cancel',
  jobRetryElsewhere: 'orbit:job:retry-elsewhere',
  /** Added for the polish pass: run a job that failed with a retryable error again. */
  jobRetry: 'orbit:job:retry',
  outputReveal: 'orbit:output:reveal',
  outputOpen: 'orbit:output:open',
  externalOpen: 'orbit:external:open',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** Custom protocol main registers for editor previews: orbit-preview://p/<token> */
export const PREVIEW_PROTOCOL = 'orbit-preview';

/** URLs the renderer may ask main to open externally. Anything else is refused. */
export const ALLOWED_EXTERNAL_URL_PREFIXES: readonly string[] = [
  'https://github.com/',
  'x-apple.systempreferences:com.apple.preference.security?',
  'ms-settings:',
];

export type WindowKind = 'picker' | 'editor' | 'jobs' | 'settings' | 'dropzone' | 'about';

export type WindowContext =
  | { readonly kind: 'picker'; readonly selectionId: string; readonly initialMode: WheelMode }
  | { readonly kind: 'editor'; readonly editorId: string }
  | { readonly kind: 'jobs' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'dropzone' }
  | { readonly kind: 'about' };

export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly platform: Platform;
  readonly arch: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly packaged: boolean;
  readonly locale: 'ko' | 'en';
}

export type HelperStatus =
  | { readonly state: 'disabled' }
  | { readonly state: 'starting' }
  | { readonly state: 'running'; readonly helperVersion: string; readonly globalDrag: boolean; readonly reason?: string }
  | { readonly state: 'needsPermission'; readonly permissions: readonly ('accessibility' | 'inputMonitoring')[] }
  | { readonly state: 'unavailable'; readonly reason: string }
  | { readonly state: 'crashed'; readonly restarts: number; readonly reason: string };

export type SubmitActionResult =
  | { readonly kind: 'jobs'; readonly jobIds: readonly string[] }
  | { readonly kind: 'editor'; readonly editorId: string }
  | { readonly kind: 'rejected'; readonly error: OrbitErrorInfo };

export interface EditorContext {
  readonly editorId: string;
  readonly actionId: ActionId;
  readonly files: readonly SelectedFile[];
  /** Info of the first image (the one being edited). */
  readonly image: ImageInfo;
  /** Downscaled, orientation-corrected source for the editor canvas. */
  readonly source: { readonly url: string; readonly width: number; readonly height: number };
  /** Default options for this action (already filled from settings). */
  readonly defaults: unknown;
  readonly settings: Settings;
}

export interface PreviewResponse {
  readonly seq: number;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly outputWidth?: number;
  readonly outputHeight?: number;
  readonly estimatedBytes?: number;
  readonly layout?: CompositionLayout;
  /**
   * Format the final output would be written in (PreviewResult.outputFormat), e.g. what
   * 'input' resolves to: HEIC → JPEG for Compress, GIF → PNG. Optional (added later).
   */
  readonly outputFormat?: FileFormat;
  /**
   * Warnings the job would report for these options (PreviewResult.warnings),
   * e.g. ANNOTATION_FONT_FALLBACK. Omitted when there are none (added later).
   */
  readonly warnings?: readonly JobWarning[];
}

export type PreviewOutcome =
  | ({ readonly ok: true } & PreviewResponse)
  | { readonly ok: false; readonly seq: number; readonly error: OrbitErrorInfo; readonly stale?: boolean };

// ------------------------------------------------------------- payload schemas (validated in main)

export const SubmitActionRequestSchema = z.strictObject({
  selectionId: Id,
  actionId: ActionIdSchema,
  /** Raw options; validated against ACTION_OPTION_SCHEMAS[actionId]. */
  options: z.unknown().optional(),
  /** Subset/order of files to use (defaults to all usable files in selection order). */
  fileIds: z.array(Id).max(500).optional(),
});
export type SubmitActionRequest = z.infer<typeof SubmitActionRequestSchema>;

export const MenuRequestSchema = z.strictObject({ selectionId: Id, mode: WheelModeSchema });

export const PreviewRequestSchema = z.strictObject({
  editorId: Id,
  /** Monotonic per editor; main drops responses older than the latest seq. */
  seq: z.number().int().nonnegative(),
  options: z.unknown(),
  maxEdge: z.number().int().min(64).max(2400).optional(),
});
export type PreviewRequestIpc = z.infer<typeof PreviewRequestSchema>;

export const CommitEditorRequestSchema = z.strictObject({
  editorId: Id,
  options: z.unknown(),
});
export type CommitEditorRequest = z.infer<typeof CommitEditorRequestSchema>;

export const RegisterPathsRequestSchema = z.strictObject({
  /** Paths obtained in preload with webUtils.getPathForFile from a real DOM drop. */
  paths: z.array(z.string().min(1).max(32767)).min(1).max(500),
  source: z.enum(['dropZone']),
});

export const WindowOpenRequestSchema = z.strictObject({ kind: z.enum(['jobs', 'settings', 'dropzone', 'about']) });
export const WindowResizeRequestSchema = z.strictObject({
  width: z.number().int().min(200).max(4000),
  height: z.number().int().min(120).max(4000),
});
export const IdRequestSchema = z.strictObject({ id: Id });
export const ExternalOpenRequestSchema = z.strictObject({ url: z.string().max(2048) });

export function isAllowedExternalUrl(url: string): boolean {
  return ALLOWED_EXTERNAL_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

// ------------------------------------------------- polish pass additions (all optional for older callers)

/** Largest thumbnail edge main renders (device pixels). */
export const THUMBNAIL_MAX_EDGE = 160;

/**
 * getEditorThumbnail: a small preview of one of an editor's files (the images →
 * PDF order list). Rendered by the preview worker, kept as an orbit-preview://
 * token owned by the editor session (released when the editor closes).
 */
export const ThumbnailRequestSchema = z.strictObject({
  editorId: Id,
  fileId: Id,
  /** Longest edge in device pixels (default 96, at most THUMBNAIL_MAX_EDGE). Never upscaled. */
  maxEdge: z.number().int().min(16).max(THUMBNAIL_MAX_EDGE).optional(),
});
export type ThumbnailRequest = z.infer<typeof ThumbnailRequestSchema>;

export interface ThumbnailResponse {
  readonly fileId: string;
  /** orbit-preview://p/<token>, owned by the editor session. */
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/**
 * requestEstimate: the Compress size estimate of one file of a (multi-file)
 * editor — the byte length of a real full-size encode with these options,
 * cached per file + options by the processors. Estimates have their own
 * per-editor sequence: a request with a newer `seq` cancels every older
 * estimate request of that editor still waiting or running (answered stale).
 */
export const EstimateRequestSchema = z.strictObject({
  editorId: Id,
  fileId: Id,
  /** Monotonic per editor (separate from the preview seq); all files of one options change share it. */
  seq: z.number().int().nonnegative(),
  /** Raw options; validated against the editor action's option schema. */
  options: z.unknown(),
});
export type EstimateRequest = z.infer<typeof EstimateRequestSchema>;

export type EstimateOutcome =
  | {
      readonly ok: true;
      readonly seq: number;
      readonly fileId: string;
      /** Bytes of the real full-size encode with these options (what the job would write). */
      readonly estimatedBytes: number;
      readonly outputWidth?: number;
      readonly outputHeight?: number;
      /** Format the output would have (what 'input' resolves to). */
      readonly outputFormat?: FileFormat;
    }
  | { readonly ok: false; readonly seq: number; readonly fileId: string; readonly error: OrbitErrorInfo; readonly stale?: boolean };

/** clearFinishedJobs: which finished jobs to remove. */
export const ClearFinishedJobsRequestSchema = z.strictObject({
  /**
   * Only jobs that finished at or before this time (ms, main's clock as in
   * JobSnapshot.finishedAt), so a job finishing while the user clicks stays
   * listed. Omitted = every finished job.
   */
  finishedUpTo: z.number().nonnegative().optional(),
});
export type ClearFinishedJobsRequest = z.infer<typeof ClearFinishedJobsRequestSchema>;

/**
 * Errors of failed jobs `retryJob` accepts: the retryable codes, except
 * OUTPUT_DIR_NOT_WRITABLE (running again in the same folder cannot help; that
 * one goes through retryJobElsewhere).
 */
export const RETRY_JOB_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([...RETRYABLE_ERROR_CODES].filter((code) => code !== 'OUTPUT_DIR_NOT_WRITABLE'));

/**
 * Whether `retryJob` accepts a job: every cancelled job, and failed jobs whose
 * error is one of RETRY_JOB_CODES — a retry must be possible after a cancel, a
 * timeout or a crashed worker.
 */
export function canRetryJob(job: Pick<JobSnapshot, 'state' | 'error'>): boolean {
  if (job.state === 'cancelled') return true;
  return job.state === 'failed' && job.error !== null && RETRY_JOB_CODES.has(job.error.code);
}

/** Errors for which retryJobElsewhere (choose another output folder and run again) can help. */
export const RETRY_ELSEWHERE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['OUTPUT_DIR_NOT_WRITABLE', 'OUTPUT_WRITE_FAILED', 'DISK_FULL', 'PATH_TOO_LONG']);

/** Exposed on window.orbit by the preload script. */
export interface OrbitApi {
  readonly platform: Platform;
  getWindowContext(): Promise<WindowContext>;
  closeWindow(): void;
  /** Ask main to resize this window's content (main clamps to the work area). */
  resizeWindow(width: number, height: number): void;
  openWindow(kind: Exclude<WindowKind, 'picker' | 'editor'>): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  getCapabilities(): Promise<CapabilitySnapshot>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  onSettingsChanged(listener: (settings: Settings) => void): () => void;
  getHelperStatus(): Promise<HelperStatus>;
  onHelperStatusChanged(listener: (status: HelperStatus) => void): () => void;
  /** Shows the OS open dialog in main; resolves null when cancelled. */
  openFileDialog(): Promise<FileSelection | null>;
  /** For files dropped on a window (Drop Zone). Paths are resolved in preload, validated in main. */
  registerDroppedFiles(files: readonly File[]): Promise<FileSelection>;
  getSelection(selectionId: string): Promise<FileSelection>;
  getMenu(selectionId: string, mode: WheelMode): Promise<WheelMenu>;
  submitAction(request: SubmitActionRequest): Promise<SubmitActionResult>;
  getEditor(editorId: string): Promise<EditorContext>;
  requestPreview(request: PreviewRequestIpc): Promise<PreviewOutcome>;
  inspectImage(editorId: string): Promise<ImageInfo>;
  commitEditor(request: CommitEditorRequest): Promise<SubmitActionResult>;
  cancelEditor(editorId: string): Promise<void>;
  /** Opens a file dialog for a background image; returns a registered fileId. */
  pickBackgroundImage(editorId: string): Promise<{ readonly fileId: string; readonly name: string } | null>;
  listJobs(): Promise<readonly JobSnapshot[]>;
  onJobsChanged(listener: (jobs: readonly JobSnapshot[]) => void): () => void;
  cancelJob(jobId: string): Promise<void>;
  /** For OUTPUT_DIR_NOT_WRITABLE: asks for another folder and resubmits. */
  retryJobElsewhere(jobId: string): Promise<SubmitActionResult | null>;
  revealOutput(outputId: string): Promise<void>;
  openOutput(outputId: string): Promise<void>;
  openExternal(url: string): Promise<boolean>;

  // ------------------------------------------------- polish pass additions
  /** Small preview of one of the editor's files (≤ THUMBNAIL_MAX_EDGE px) as an orbit-preview:// URL owned by the editor. */
  getEditorThumbnail(request: ThumbnailRequest): Promise<ThumbnailResponse>;
  /** Compress: estimate one file of the editor with these options (superseded requests answer `stale`). */
  requestEstimate(request: EstimateRequest): Promise<EstimateOutcome>;
  /**
   * Removes finished (completed / failed / cancelled) jobs from the list and
   * from history. Output files are never touched and active jobs never
   * cancelled. Resolves with the number of jobs removed.
   */
  clearFinishedJobs(request?: ClearFinishedJobsRequest): Promise<number>;
  /**
   * A cancelled job, or one that failed with one of RETRY_JOB_CODES
   * (canRetryJob), runs again with the same action, options and output folder;
   * its inputs are validated again first (a file that is gone → rejected
   * FILE_NOT_FOUND). One retry per job: repeated calls return the first
   * retry's result.
   */
  retryJob(jobId: string): Promise<SubmitActionResult>;
}
