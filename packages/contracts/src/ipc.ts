import { z } from 'zod';
import type { ActionId, WheelMode } from './actions';
import type { CapabilitySnapshot, Platform } from './capabilities';
import type { CompositionLayout } from './composition';
import type { OrbitErrorInfo } from './errors';
import type { FileSelection, SelectedFile } from './files';
import type { JobSnapshot } from './jobs';
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
  jobsList: 'orbit:jobs:list',
  jobsChanged: 'orbit:jobs:changed',
  jobCancel: 'orbit:job:cancel',
  jobRetryElsewhere: 'orbit:job:retry-elsewhere',
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
}
