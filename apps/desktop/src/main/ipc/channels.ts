import {
  CommitEditorRequestSchema,
  ExternalOpenRequestSchema,
  IPC_CHANNELS,
  IdRequestSchema,
  MenuRequestSchema,
  PreviewRequestSchema,
  RegisterPathsRequestSchema,
  SubmitActionRequestSchema,
  WindowOpenRequestSchema,
  WindowResizeRequestSchema,
  type AppInfo,
  type CapabilitySnapshot,
  type CommitEditorRequest,
  type EditorContext,
  type FileSelection,
  type HelperStatus,
  type ImageInfo,
  type JobSnapshot,
  type PreviewOutcome,
  type PreviewRequestIpc,
  type Settings,
  type SubmitActionRequest,
  type SubmitActionResult,
  type WheelMenu,
  type WheelMode,
  type WindowContext,
  type WindowKind,
} from '@orbitdrop/contracts';
import type { IpcRouter } from './router';

/**
 * The OrbitApi surface as main-side services. Every method receives only
 * validated payloads and the calling window's record; ids are resolved by the
 * services (unknown ids are errors).
 */
export interface OrbitIpcServices<R> {
  windowContext(record: R): WindowContext;
  closeWindow(record: R): void;
  resizeWindow(record: R, width: number, height: number): void;
  openWindow(kind: Exclude<WindowKind, 'picker' | 'editor'>, record: R): void;
  appInfo(): AppInfo;
  capabilities(): Promise<CapabilitySnapshot>;
  settings(): Settings;
  updateSettings(patch: unknown): Promise<Settings>;
  helperStatus(): HelperStatus;
  openFileDialog(record: R): Promise<FileSelection | null>;
  registerDroppedPaths(paths: readonly string[], record: R): Promise<FileSelection>;
  selection(selectionId: string): FileSelection;
  menu(selectionId: string, mode: WheelMode): Promise<WheelMenu>;
  submit(request: SubmitActionRequest, record: R): Promise<SubmitActionResult>;
  editor(editorId: string): Promise<EditorContext>;
  preview(request: PreviewRequestIpc): Promise<PreviewOutcome>;
  inspect(editorId: string): Promise<ImageInfo>;
  commit(request: CommitEditorRequest, record: R): Promise<SubmitActionResult>;
  cancelEditor(editorId: string, record: R): Promise<void>;
  pickBackground(editorId: string, record: R): Promise<{ readonly fileId: string; readonly name: string } | null>;
  jobs(): readonly JobSnapshot[];
  cancelJob(jobId: string): Promise<void>;
  retryElsewhere(jobId: string, record: R): Promise<SubmitActionResult | null>;
  revealOutput(outputId: string): Promise<void>;
  openOutput(outputId: string): Promise<void>;
  openExternal(url: string): Promise<boolean>;
}

/** Wire every OrbitApi channel. Events (settingsChanged, helperStatusChanged, jobsChanged) are broadcast by main. */
export function registerOrbitIpc<R>(router: IpcRouter<R>, s: OrbitIpcServices<R>): void {
  const C = IPC_CHANNELS;
  router.handle(C.windowContext, null, (_p, record) => s.windowContext(record));
  router.on(C.windowClose, null, (_p, record) => s.closeWindow(record));
  router.on(C.windowResize, WindowResizeRequestSchema, (p, record) => s.resizeWindow(record, p.width, p.height));
  router.handle(C.windowOpen, WindowOpenRequestSchema, (p, record) => s.openWindow(p.kind, record));
  router.handle(C.appInfo, null, () => s.appInfo());
  router.handle(C.capabilities, null, () => s.capabilities());
  router.handle(C.settingsGet, null, () => s.settings());
  router.handle(C.settingsUpdate, { safeParse: (value: unknown) => ({ success: true as const, data: value }) }, (patch) => s.updateSettings(patch));
  router.handle(C.helperStatus, null, () => s.helperStatus());
  router.handle(C.filesOpenDialog, null, (_p, record) => s.openFileDialog(record));
  router.handle(C.filesRegisterPaths, RegisterPathsRequestSchema, (p, record) => s.registerDroppedPaths(p.paths, record));
  router.handle(C.selectionGet, IdRequestSchema, (p) => s.selection(p.id));
  router.handle(C.menuGet, MenuRequestSchema, (p) => s.menu(p.selectionId, p.mode));
  router.handle(C.actionSubmit, SubmitActionRequestSchema, (p, record) => s.submit(p, record));
  router.handle(C.editorGet, IdRequestSchema, (p) => s.editor(p.id));
  router.handle(C.editorPreview, PreviewRequestSchema, (p) => s.preview(p));
  router.handle(C.editorInspect, IdRequestSchema, (p) => s.inspect(p.id));
  router.handle(C.editorCommit, CommitEditorRequestSchema, (p, record) => s.commit(p, record));
  router.handle(C.editorCancel, IdRequestSchema, (p, record) => s.cancelEditor(p.id, record));
  router.handle(C.editorPickBackground, IdRequestSchema, (p, record) => s.pickBackground(p.id, record));
  router.handle(C.jobsList, null, () => s.jobs());
  router.handle(C.jobCancel, IdRequestSchema, (p) => s.cancelJob(p.id));
  router.handle(C.jobRetryElsewhere, IdRequestSchema, (p, record) => s.retryElsewhere(p.id, record));
  router.handle(C.outputReveal, IdRequestSchema, (p) => s.revealOutput(p.id));
  router.handle(C.outputOpen, IdRequestSchema, (p) => s.openOutput(p.id));
  router.handle(C.externalOpen, ExternalOpenRequestSchema, (p) => s.openExternal(p.url));
}

/** Channels main pushes to renderers. */
export const EVENT_CHANNELS = [IPC_CHANNELS.settingsChanged, IPC_CHANNELS.helperStatusChanged, IPC_CHANNELS.jobsChanged] as const;
