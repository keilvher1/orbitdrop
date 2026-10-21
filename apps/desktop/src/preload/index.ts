/**
 * Preload (sandboxed, contextIsolation on): exposes exactly `OrbitApi` as
 * `window.orbit`. No ipcRenderer, no Node APIs and no paths reach the page:
 *  - every call goes through a fixed channel from IPC_CHANNELS;
 *  - dropped File objects are turned into paths here with
 *    webUtils.getPathForFile and validated by main (registerDroppedFiles);
 *    items without a file on disk (in-memory data, mail attachments, file
 *    promises) reject with VIRTUAL_FILE;
 *  - listeners never receive the IPC event object and every subscription
 *    returns an unsubscribe function;
 *  - rejected calls reject with Error("<ErrorCode>: <message>").
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC_CHANNELS, type OrbitApi, type Platform } from '@orbitdrop/contracts';

const REMOTE_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;

function cleanError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replace(REMOTE_PREFIX, ''));
}

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  try {
    return (await (payload === undefined ? ipcRenderer.invoke(channel) : ipcRenderer.invoke(channel, payload))) as T;
  } catch (error) {
    throw cleanError(error);
  }
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  const wrapped = (_event: IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

function platform(): Platform {
  return process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
}

const api: OrbitApi = {
  platform: platform(),
  getWindowContext: () => invoke(IPC_CHANNELS.windowContext),
  closeWindow: () => ipcRenderer.send(IPC_CHANNELS.windowClose),
  resizeWindow: (width, height) => ipcRenderer.send(IPC_CHANNELS.windowResize, { width: Math.round(width), height: Math.round(height) }),
  openWindow: (kind) => invoke(IPC_CHANNELS.windowOpen, { kind }),
  getAppInfo: () => invoke(IPC_CHANNELS.appInfo),
  getCapabilities: () => invoke(IPC_CHANNELS.capabilities),
  getSettings: () => invoke(IPC_CHANNELS.settingsGet),
  updateSettings: (patch) => invoke(IPC_CHANNELS.settingsUpdate, patch),
  onSettingsChanged: (listener) => subscribe(IPC_CHANNELS.settingsChanged, listener),
  getHelperStatus: () => invoke(IPC_CHANNELS.helperStatus),
  onHelperStatusChanged: (listener) => subscribe(IPC_CHANNELS.helperStatusChanged, listener),
  openFileDialog: () => invoke(IPC_CHANNELS.filesOpenDialog),
  registerDroppedFiles: (files) => {
    const list = Array.from(files as ArrayLike<File>);
    const paths = list.map((file) => webUtils.getPathForFile(file)).filter((path) => typeof path === 'string' && path.length > 0);
    if (paths.length === 0) return Promise.reject(new Error('VIRTUAL_FILE: The dropped items are not files on disk'));
    return invoke(IPC_CHANNELS.filesRegisterPaths, { paths: paths.slice(0, 500), source: 'dropZone' });
  },
  getSelection: (selectionId) => invoke(IPC_CHANNELS.selectionGet, { id: selectionId }),
  getMenu: (selectionId, mode) => invoke(IPC_CHANNELS.menuGet, { selectionId, mode }),
  submitAction: (request) => invoke(IPC_CHANNELS.actionSubmit, request),
  getEditor: (editorId) => invoke(IPC_CHANNELS.editorGet, { id: editorId }),
  requestPreview: (request) => invoke(IPC_CHANNELS.editorPreview, request),
  inspectImage: (editorId) => invoke(IPC_CHANNELS.editorInspect, { id: editorId }),
  commitEditor: (request) => invoke(IPC_CHANNELS.editorCommit, request),
  cancelEditor: (editorId) => invoke(IPC_CHANNELS.editorCancel, { id: editorId }),
  pickBackgroundImage: (editorId) => invoke(IPC_CHANNELS.editorPickBackground, { id: editorId }),
  listJobs: () => invoke(IPC_CHANNELS.jobsList),
  onJobsChanged: (listener) => subscribe(IPC_CHANNELS.jobsChanged, listener),
  cancelJob: (jobId) => invoke(IPC_CHANNELS.jobCancel, { id: jobId }),
  retryJobElsewhere: (jobId) => invoke(IPC_CHANNELS.jobRetryElsewhere, { id: jobId }),
  revealOutput: (outputId) => invoke(IPC_CHANNELS.outputReveal, { id: outputId }),
  openOutput: (outputId) => invoke(IPC_CHANNELS.outputOpen, { id: outputId }),
  openExternal: (url) => invoke(IPC_CHANNELS.externalOpen, { url }),
  getEditorThumbnail: (request) => invoke(IPC_CHANNELS.editorThumbnail, request),
  requestEstimate: (request) => invoke(IPC_CHANNELS.editorEstimate, request),
  clearFinishedJobs: (request) => invoke(IPC_CHANNELS.jobsClearFinished, request ?? {}),
  retryJob: (jobId) => invoke(IPC_CHANNELS.jobRetry, { id: jobId }),
};

contextBridge.exposeInMainWorld('orbit', api);
