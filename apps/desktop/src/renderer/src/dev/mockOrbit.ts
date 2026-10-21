import {
  ACTIONS,
  BACKGROUND_PRESETS,
  COMPOSITION_LIMITS,
  DEFAULT_SETTINGS,
  FORMAT_INFO,
  TERMINAL_JOB_STATES,
  applySettingsPatch,
  formatFromExtension,
  inputKindOf,
  menuKeyFor,
  needsEditor,
  type ActionId,
  type AppInfo,
  type EditorContext,
  type EngineProbe,
  type FileFormat,
  type FileSelection,
  type FormatSupport,
  type HelperStatus,
  type ImageInfo,
  type JobSnapshot,
  type Locale,
  type OrbitApi,
  type Platform,
  type SelectedFile,
  type Settings,
  type WheelMode,
  type WindowContext,
} from '@orbitdrop/contracts';
import { adjustMenuForFileCount, buildCapabilitySnapshot, buildWheelMenu, convertedName, toolResultName } from '@orbitdrop/core';
import { canvasUrl, documentImage, logoImage, patternImage, photoImage } from './mockImages';
import { renderMockPreview, type MockSource } from './mockPreviews';

/**
 * DEV HARNESS ONLY. An in-browser OrbitApi with fake selections, menus, editor
 * contexts, previews (generated canvases) and jobs, so every renderer view can
 * be developed, tested and screenshotted without Electron. Query parameters
 * (see `scenarioFromQuery`) pick the window and its state.
 */

export type MockMenu = 'pdf' | 'jpg' | 'png' | 'images' | 'mixed' | 'unsupported';
export type MockTool = 'crop' | 'addBackground' | 'compress' | 'metadata' | 'edit' | 'annotate' | 'redact' | 'pdf';

export interface MockScenario {
  readonly view: WindowContext['kind'];
  readonly menu: MockMenu;
  readonly mode: WheelMode;
  readonly tool: MockTool;
  readonly image: 'photo' | 'document' | 'logo';
  readonly platform: Platform;
  readonly locale: Locale;
  readonly helper: HelperStatus['state'];
  readonly jobs: 'demo' | 'empty';
  readonly reduceMotion: Settings['accessibility']['reduceMotion'];
  readonly highContrast: Settings['accessibility']['highContrast'];
  /** Artificial preview latency in ms (exercises pending states). */
  readonly latency: number;
}

const TOOLS: readonly MockTool[] = ['crop', 'addBackground', 'compress', 'metadata', 'edit', 'annotate', 'redact', 'pdf'];

export function scenarioFromQuery(search: string): MockScenario | null {
  const q = new URLSearchParams(search);
  const view = q.get('view');
  const views: readonly WindowContext['kind'][] = ['picker', 'editor', 'jobs', 'settings', 'dropzone', 'about'];
  if (view === null || !views.includes(view as WindowContext['kind'])) return null;
  const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = q.get(name);
    return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  };
  const tool = pick<MockTool>('tool', TOOLS, 'crop');
  return {
    view: view as WindowContext['kind'],
    menu: pick<MockMenu>('menu', ['pdf', 'jpg', 'png', 'images', 'mixed', 'unsupported'], 'jpg'),
    mode: pick<WheelMode>('mode', ['convert', 'tools'], 'convert'),
    tool,
    image: pick('image', ['photo', 'document', 'logo'] as const, tool === 'crop' || tool === 'addBackground' ? 'document' : 'photo'),
    platform: pick<Platform>('platform', ['darwin', 'win32', 'linux'], 'darwin'),
    locale: pick<Locale>('lang', ['ko', 'en'], 'ko'),
    helper: pick<HelperStatus['state']>('helper', ['disabled', 'starting', 'running', 'needsPermission', 'unavailable', 'crashed'], 'running'),
    jobs: pick('jobs', ['demo', 'empty'] as const, 'demo'),
    reduceMotion: pick('rm', ['system', 'on', 'off'] as const, 'system'),
    highContrast: pick('hc', ['system', 'on', 'off'] as const, 'system'),
    latency: Number(q.get('latency') ?? 120) || 0,
  };
}

const support = (input: boolean, output: boolean, engine: FormatSupport['inputEngine'] = 'sharp'): FormatSupport => ({
  input,
  output,
  inputEngine: input ? engine : 'none',
  outputEngine: output ? engine : 'none',
  ...(input && output ? {} : { note: 'not in this build' }),
});

/** Like the measured darwin-arm64 build: no HEIC encoder, no BMP. */
export const MOCK_PROBE: EngineProbe = {
  platform: 'darwin',
  arch: 'arm64',
  versions: { sharp: '0.35.5', libvips: '8.18.7', pdfjs: '6.4.299' },
  formats: {
    jpeg: support(true, true),
    png: support(true, true),
    webp: support(true, true),
    gif: support(true, false),
    tiff: support(true, true),
    avif: support(true, true),
    heic: support(true, false),
    bmp: support(false, false),
    pdf: { input: true, output: true, inputEngine: 'pdfjs', outputEngine: 'pdf-lib' },
    docx: { input: false, output: true, inputEngine: 'none', outputEngine: 'docx' },
    txt: { input: false, output: true, inputEngine: 'none', outputEngine: 'text' },
  },
  pdfRender: true,
  pdfText: true,
  koreanFont: 'Apple SD Gothic Neo',
  errors: [],
  probedAt: Date.now(),
};

function file(fileId: string, name: string, bytes: number, problem?: SelectedFile['problem']): SelectedFile {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  const format = (formatFromExtension(ext) ?? null) as FileFormat | null;
  const kind = format === null ? null : (inputKindOf(format) ?? null);
  return { fileId, name, ext, format: problem ? null : format, kind: problem ? null : kind, bytes, ...(problem ? { problem } : {}) };
}

function selectionFor(menu: MockMenu): FileSelection {
  const files: SelectedFile[] = (() => {
    switch (menu) {
      case 'pdf':
        return [file('f-pdf', 'Page 001.pdf', 1_240_000)];
      case 'png':
        return [file('f-png', 'screenshot.png', 2_480_000)];
      case 'images':
        return [file('f-a', 'IMG_2041.jpg', 3_120_000), file('f-b', 'diagram.png', 412_000), file('f-c', 'sticker.webp', 96_000)];
      case 'mixed':
        return [file('f-pdf', 'report.pdf', 2_040_000), file('f-a', 'IMG_2041.jpg', 3_120_000)];
      case 'unsupported':
        return [
          file('f-zip', 'archive.zip', 10_400_000, { code: 'UNSUPPORTED_FORMAT', message: 'zip' }),
          file('f-dir', 'Photos', 0, { code: 'NOT_A_FILE', message: 'folder' }),
        ];
      default:
        return [file('f-jpg', 'Page 001.jpg', 1_200_000)];
    }
  })();
  const usable = files.filter((f) => !f.problem);
  return { selectionId: `sel-${menu}`, source: 'test', files, menuKey: menuKeyFor(usable.map((f) => f.format ?? undefined)) };
}

interface MockEditorAsset {
  readonly ctx: EditorContext;
  readonly source: MockSource;
}

function imageInfo(kind: MockScenario['image'], format: FileFormat): ImageInfo {
  const size = kind === 'document' ? { width: 2550, height: 3300 } : kind === 'logo' ? { width: 1024, height: 1024 } : { width: 4032, height: 3024 };
  const photo = kind === 'photo';
  return {
    format,
    bytes: kind === 'document' ? 1_200_000 : kind === 'logo' ? 186_000 : 3_120_000,
    // The photo is stored rotated (EXIF orientation 6) to exercise oriented coordinates.
    width: photo ? size.height : size.width,
    height: photo ? size.width : size.height,
    orientedWidth: size.width,
    orientedHeight: size.height,
    orientation: photo ? 6 : 1,
    hasAlpha: kind === 'logo',
    channels: kind === 'logo' ? 4 : 3,
    space: 'srgb',
    density: kind === 'document' ? 300 : 72,
    bitDepth: 'uchar',
    hasIccProfile: photo,
    iccDescription: photo ? 'Display P3' : null,
    hasExif: photo,
    hasXmp: photo,
    hasIptc: false,
    exif: photo
      ? {
          make: 'Apple',
          model: 'iPhone 17 Pro',
          lens: 'iPhone 17 Pro back triple camera 6.86mm f/1.78',
          software: '26.0',
          dateTimeOriginal: '2026:10:12 18:42:07',
          exposureTime: '1/120',
          fNumber: 1.78,
          iso: 64,
          focalLength: 6.86,
          gps: { latitude: 37.5665, longitude: 126.978 },
          other: [
            { tag: 'WhiteBalance', value: 'Auto' },
            { tag: 'Flash', value: 'Off, did not fire' },
          ],
        }
      : null,
    pages: null,
  };
}

const ACTION_FOR_TOOL: Record<MockTool, ActionId> = {
  crop: 'tool.crop',
  addBackground: 'tool.addBackground',
  compress: 'tool.compress',
  metadata: 'tool.metadata',
  edit: 'tool.edit',
  annotate: 'tool.annotate',
  redact: 'tool.redact',
  pdf: 'convert.pdf',
};

/** Same idea as main's editorDefaults (main/editor/defaults.ts). */
function defaultsFor(actionId: ActionId, info: ImageInfo, settings: Settings, fileIds: readonly string[]): unknown {
  const width = info.orientedWidth;
  const height = info.orientedHeight;
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));
  switch (actionId) {
    case 'tool.crop':
      return { rect: { x: 0, y: 0, width, height }, aspect: 'free', outputFormat: 'input', flattenBackground: '#FFFFFF' };
    case 'tool.addBackground': {
      const maxEdge = settings.background.maxEdge;
      const base = Math.min(maxEdge, Math.max(width, height));
      return {
        background: { kind: 'preset', presetId: BACKGROUND_PRESETS[0]?.id ?? 'ember' },
        padding: clamp(base * 0.08, 0, COMPOSITION_LIMITS.padding.max),
        cornerRadius: clamp(base * 0.03, 0, COMPOSITION_LIMITS.cornerRadius.max),
        shadow: clamp(base * 0.02, 0, COMPOSITION_LIMITS.shadow.max),
        ratio: 'auto',
        maxEdge,
        format: 'png',
        quality: 92,
      };
    }
    case 'tool.compress':
      return { format: 'input', quality: 75, maxEdge: null, pngMode: 'palette', keepMetadata: false };
    case 'tool.metadata':
      return { mode: 'strip', iccPolicy: 'convertToSrgb', outputFormat: 'input' };
    case 'tool.edit':
      return { rotate: 0, flipH: false, flipV: false, brightness: 0, contrast: 0, saturation: 0, outputFormat: 'input' };
    case 'tool.annotate':
      return { shapes: [], outputFormat: 'input' };
    case 'tool.redact':
      return { regions: [], outputFormat: 'input' };
    case 'convert.pdf':
      return { flattenBackground: '#FFFFFF', keepMetadata: false, pageSize: 'image', marginPt: 0, order: [...fileIds], pageSeparator: 'marker' };
    default:
      return {};
  }
}

function demoJobs(now: number): JobSnapshot[] {
  const base = (over: Partial<JobSnapshot> & Pick<JobSnapshot, 'jobId' | 'actionId' | 'inputName' | 'state'>): JobSnapshot => ({
    batchId: null,
    sessionId: null,
    inputCount: 1,
    progress: { kind: 'indeterminate' },
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    outputs: [],
    warnings: [],
    error: null,
    inputBytes: 1_200_000,
    ...over,
  });
  const out = (outputId: string, name: string, format: FileFormat, bytes: number, extra: object = {}) => ({ outputId, name, format, bytes, dirDisplay: 'Desktop', ...extra });
  return [
    base({ jobId: 'j-run-det', actionId: 'convert.jpeg', inputName: 'report.pdf', state: 'running', progress: { kind: 'determinate', done: 3, total: 10, unit: 'page' }, createdAt: now - 4000, inputBytes: 5_400_000 }),
    base({ jobId: 'j-run-ind', actionId: 'tool.addBackground', inputName: 'Page 001 Cropped.jpg', state: 'running', progress: { kind: 'indeterminate', stage: 'encoding' }, createdAt: now - 3000 }),
    base({ jobId: 'j-queued', actionId: 'convert.webp', inputName: 'IMG_2041.jpg', inputCount: 3, state: 'queued', startedAt: null, createdAt: now - 2000 }),
    base({
      jobId: 'j-done-crop',
      actionId: 'tool.crop',
      inputName: 'Page 001.jpg',
      state: 'completed',
      progress: { kind: 'determinate', done: 1, total: 1, unit: 'step' },
      createdAt: now - 60_000,
      finishedAt: now - 58_000,
      outputs: [out('o-crop', 'Page 001 Cropped.jpg', 'jpeg', 1_105_000, { width: 2550, height: 2550 })],
    }),
    base({
      jobId: 'j-done-compress',
      actionId: 'tool.compress',
      inputName: 'screenshot.png',
      state: 'completed',
      createdAt: now - 120_000,
      finishedAt: now - 118_000,
      inputBytes: 412_000,
      outputs: [out('o-cmp', 'screenshot Compressed.png', 'png', 436_000, { width: 1440, height: 900 })],
      warnings: [{ code: 'OUTPUT_LARGER_THAN_INPUT', params: { inputBytes: 412_000, outputBytes: 436_000 } }],
    }),
    base({
      jobId: 'j-fail-dir',
      actionId: 'convert.png',
      inputName: 'scan.pdf',
      state: 'failed',
      createdAt: now - 180_000,
      finishedAt: now - 179_000,
      error: { code: 'OUTPUT_DIR_NOT_WRITABLE', message: 'EACCES', retryable: true },
    }),
    base({
      jobId: 'j-done-docx',
      actionId: 'convert.docx',
      inputName: 'thesis.pdf',
      state: 'completed',
      createdAt: now - 240_000,
      finishedAt: now - 236_000,
      outputs: [out('o-docx', 'thesis.docx', 'docx', 88_000, { pages: 12 })],
      warnings: [{ code: 'DOCX_TEXT_ONLY' }, { code: 'PDF_PAGES_WITHOUT_TEXT', params: { pages: '2, 5' } }],
    }),
    base({
      jobId: 'j-fail-text',
      actionId: 'convert.txt',
      inputName: 'scan-only.pdf',
      state: 'failed',
      createdAt: now - 300_000,
      finishedAt: now - 299_000,
      error: { code: 'PDF_NO_TEXT', message: 'no text', retryable: false },
    }),
    base({ jobId: 'j-cancel', actionId: 'convert.avif', inputName: 'IMG_2041.jpg', state: 'cancelled', createdAt: now - 360_000, finishedAt: now - 359_000 }),
  ];
}

function notifyHarness(message: string): void {
  console.info(`[orbit mock] ${message}`);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('orbit-mock', { detail: message }));
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createMockOrbit(scenario: MockScenario): OrbitApi {
  let settings: Settings = applySettingsPatch(DEFAULT_SETTINGS, {
    locale: scenario.locale,
    accessibility: { reduceMotion: scenario.reduceMotion, highContrast: scenario.highContrast },
  }) ?? DEFAULT_SETTINGS;
  const settingsListeners = new Set<(s: Settings) => void>();
  const helperListeners = new Set<(s: HelperStatus) => void>();
  const jobListeners = new Set<(jobs: readonly JobSnapshot[]) => void>();
  const capabilities = buildCapabilitySnapshot(MOCK_PROBE);
  const selections = new Map<string, FileSelection>();
  const editors = new Map<string, Promise<MockEditorAsset>>();
  let bgImage: HTMLCanvasElement | null = null;
  let jobs: JobSnapshot[] = scenario.jobs === 'demo' ? demoJobs(Date.now()) : [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter += 1)}`;

  const initialSelection = selectionFor(scenario.menu);
  selections.set(initialSelection.selectionId, initialSelection);

  const emitJobs = () => {
    const snapshot = [...jobs];
    for (const listener of jobListeners) listener(snapshot);
  };

  const updateJob = (jobId: string, patch: Partial<JobSnapshot>) => {
    jobs = jobs.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j));
    emitJobs();
  };

  /** Simulated worker: a real main process reports progress events like these. */
  const runJob = (jobId: string, steps: number, finish: () => Partial<JobSnapshot>) => {
    let done = 0;
    const tick = () => {
      const job = jobs.find((j) => j.jobId === jobId);
      if (!job || TERMINAL_JOB_STATES.has(job.state)) return;
      done += 1;
      if (done >= steps) {
        updateJob(jobId, { state: 'completed', finishedAt: Date.now(), ...finish() });
        return;
      }
      updateJob(jobId, { state: 'running', startedAt: job.startedAt ?? Date.now(), progress: steps > 1 ? { kind: 'determinate', done, total: steps, unit: 'step' } : { kind: 'indeterminate', stage: 'encoding' } });
      setTimeout(tick, 700);
    };
    setTimeout(tick, 400);
  };

  if (scenario.jobs === 'demo' && scenario.view === 'jobs' && scenario.latency > 0) {
    // Keep the determinate demo job moving so the bar can be seen updating (stops at 9/10 for screenshots).
    let page = 3;
    const timer = setInterval(() => {
      page += 1;
      if (page >= 9) clearInterval(timer);
      updateJob('j-run-det', { progress: { kind: 'determinate', done: page, total: 10, unit: 'page' } });
    }, 1500);
  }

  const createEditor = (actionId: ActionId, selection: FileSelection): string => {
    const editorId = nextId('ed');
    const files = selection.files.filter((f) => !f.problem);
    const first = files[0];
    const format: FileFormat = (first?.format as FileFormat | null) ?? 'jpeg';
    const kind: MockScenario['image'] =
      scenario.view === 'editor' ? scenario.image : first?.name.startsWith('Page') ? 'document' : format === 'png' ? 'logo' : 'photo';
    editors.set(
      editorId,
      (async () => {
        const info = imageInfo(kind, kind === 'logo' ? 'png' : format);
        const preview = { width: Math.round((1600 * info.orientedWidth) / Math.max(info.orientedWidth, info.orientedHeight)), height: Math.round((1600 * info.orientedHeight) / Math.max(info.orientedWidth, info.orientedHeight)) };
        const canvas = kind === 'document' ? documentImage(preview.width, preview.height) : kind === 'logo' ? logoImage(preview.width, preview.height) : photoImage(preview.width, preview.height);
        const { url } = await canvasUrl(canvas, kind === 'logo' ? 'image/png' : 'image/jpeg', 0.9);
        const ctx: EditorContext = {
          editorId,
          actionId,
          files,
          image: info,
          source: { url, width: preview.width, height: preview.height },
          defaults: defaultsFor(actionId, info, settings, files.map((f) => f.fileId)),
          settings,
        };
        return { ctx, source: { canvas, oriented: { width: info.orientedWidth, height: info.orientedHeight }, bytes: info.bytes, format: info.format } };
      })(),
    );
    return editorId;
  };

  const editorSelection = (): FileSelection => {
    if (scenario.tool === 'pdf') {
      return {
        selectionId: 'sel-pdf-order',
        source: 'test',
        files: [file('p1', 'IMG_2041.jpg', 3_120_000), file('p2', 'IMG_2042.jpg', 2_980_000), file('p3', 'receipt.png', 412_000), file('p4', 'whiteboard.webp', 806_000)],
        menuKey: 'images',
      };
    }
    const name = scenario.image === 'document' ? 'Page 001.jpg' : scenario.image === 'logo' ? 'logo.png' : 'IMG_2041.jpg';
    const bytes = scenario.image === 'document' ? 1_200_000 : scenario.image === 'logo' ? 186_000 : 3_120_000;
    return { selectionId: 'sel-editor', source: 'test', files: [file('f-e', name, bytes)], menuKey: name.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  };

  const initialEditorId = scenario.view === 'editor' ? createEditor(ACTION_FOR_TOOL[scenario.tool], editorSelection()) : null;

  const enqueue = (actionId: ActionId, selection: FileSelection, merge: boolean): string[] => {
    const files = selection.files.filter((f) => !f.problem);
    const groups = merge ? [files] : files.map((f) => [f]);
    return groups.map((group) => {
      const firstFile = group[0];
      const jobId = nextId('job');
      const action = ACTIONS[actionId];
      const target = action.output === 'input' ? (firstFile?.format ?? 'jpeg') : action.output;
      const ext = FORMAT_INFO[target as FileFormat]?.extension ?? '.bin';
      const name = action.mode === 'tools' ? toolResultName(firstFile?.name ?? 'file', action.outputSuffix, ext) : convertedName(firstFile?.name ?? 'file', ext);
      jobs = [
        {
          jobId,
          batchId: null,
          sessionId: null,
          actionId,
          inputName: firstFile?.name ?? 'file',
          inputCount: group.length,
          state: 'queued',
          progress: { kind: 'indeterminate' },
          createdAt: Date.now(),
          startedAt: null,
          finishedAt: null,
          outputs: [],
          warnings: [],
          error: null,
          inputBytes: group.reduce((s, f) => s + f.bytes, 0),
        },
        ...jobs,
      ];
      const inputBytes = group.reduce((s, f) => s + f.bytes, 0);
      runJob(jobId, actionId === 'convert.pdf' ? group.length : 3, () => {
        const bytes = actionId === 'tool.compress' ? Math.round(inputBytes * 0.46) : Math.round(inputBytes * 0.8);
        return { outputs: [{ outputId: nextId('out'), name, dirDisplay: 'Desktop', format: target as FileFormat, bytes }] };
      });
      emitJobs();
      return jobId;
    });
  };

  const api: OrbitApi = {
    platform: scenario.platform,
    async getWindowContext() {
      switch (scenario.view) {
        case 'picker':
          return { kind: 'picker', selectionId: initialSelection.selectionId, initialMode: scenario.mode };
        case 'editor':
          return { kind: 'editor', editorId: initialEditorId ?? 'missing' };
        default:
          return { kind: scenario.view } as WindowContext;
      }
    },
    closeWindow() {
      notifyHarness('closeWindow()');
    },
    resizeWindow(width, height) {
      (window as unknown as { __orbitMockSize?: { width: number; height: number } }).__orbitMockSize = { width, height };
      document.documentElement.dataset.mockWidth = String(width);
      document.documentElement.dataset.mockHeight = String(height);
    },
    async openWindow(kind) {
      notifyHarness(`openWindow(${kind})`);
    },
    async getAppInfo(): Promise<AppInfo> {
      return { name: 'OrbitDrop', version: '0.1.0', platform: scenario.platform, arch: 'arm64', electron: '44.9.0', chrome: '152.0.7843.0', node: '24.7.0', packaged: false, locale: settings.locale };
    },
    async getCapabilities() {
      return capabilities;
    },
    async getSettings() {
      return settings;
    },
    async updateSettings(patch) {
      const next = applySettingsPatch(settings, patch);
      if (next === null) throw new Error('INVALID_OPTIONS: invalid settings patch');
      settings = next;
      for (const listener of settingsListeners) listener(settings);
      return settings;
    },
    onSettingsChanged(listener) {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    },
    async getHelperStatus(): Promise<HelperStatus> {
      switch (scenario.helper) {
        case 'running':
          return { state: 'running', helperVersion: '0.1.0', globalDrag: true };
        case 'needsPermission':
          return { state: 'needsPermission', permissions: ['accessibility', 'inputMonitoring'] };
        case 'unavailable':
          return { state: 'unavailable', reason: 'helper binary not found' };
        case 'crashed':
          return { state: 'crashed', restarts: 3, reason: 'exited with code 1' };
        default:
          return { state: scenario.helper } as HelperStatus;
      }
    },
    onHelperStatusChanged(listener) {
      helperListeners.add(listener);
      return () => helperListeners.delete(listener);
    },
    async openFileDialog() {
      await delay(150);
      const selection = selectionFor('jpg');
      selections.set(selection.selectionId, selection);
      return selection;
    },
    async registerDroppedFiles(files) {
      await delay(120);
      const list = Array.from(files);
      if (list.length === 0) throw new Error('FILE_NOT_FOUND: No files from the file system were dropped');
      const selected = list.map((f, i) => {
        const format = formatFromExtension(f.name.slice(f.name.lastIndexOf('.')));
        const usable = format !== undefined && inputKindOf(format) !== undefined && capabilities.probe.formats[format].input;
        return file(`drop${i}`, f.name, f.size, usable ? undefined : { code: 'UNSUPPORTED_FORMAT', message: 'unsupported' });
      });
      const usable = selected.filter((f) => !f.problem);
      const selection: FileSelection = { selectionId: nextId('sel'), source: 'dropZone', files: selected, menuKey: usable.length ? menuKeyFor(usable.map((f) => f.format ?? undefined)) : null };
      selections.set(selection.selectionId, selection);
      return selection;
    },
    async getSelection(selectionId) {
      const selection = selections.get(selectionId);
      if (!selection) throw new Error('INTERNAL: unknown selection');
      return selection;
    },
    async getMenu(selectionId, mode) {
      const selection = selections.get(selectionId);
      if (!selection?.menuKey) throw new Error('UNSUPPORTED_FORMAT: nothing usable');
      const count = selection.files.filter((f) => !f.problem).length;
      const menu = buildWheelMenu(capabilities, selection.menuKey, mode, settings.locale);
      return adjustMenuForFileCount(menu, count, settings.locale === 'ko' ? '여러 파일을 함께 처리할 수 없음' : 'Not available for several files');
    },
    async submitAction(request) {
      await delay(200);
      const selection = selections.get(request.selectionId);
      if (!selection) return { kind: 'rejected', error: { code: 'INTERNAL', message: 'unknown selection', retryable: false } };
      const action = ACTIONS[request.actionId];
      const count = selection.files.filter((f) => !f.problem).length;
      if (needsEditor(action, count)) {
        const editorId = createEditor(request.actionId, selection);
        notifyHarness(`editor opened: ${request.actionId}`);
        return { kind: 'editor', editorId };
      }
      return { kind: 'jobs', jobIds: enqueue(request.actionId, selection, action.merges) };
    },
    async getEditor(editorId) {
      const editor = editors.get(editorId);
      if (!editor) throw new Error('INTERNAL: Unknown or closed editor');
      return (await editor).ctx;
    },
    async requestPreview(request) {
      const editor = editors.get(request.editorId);
      if (!editor) return { ok: false, seq: request.seq, error: { code: 'INTERNAL', message: 'Unknown editor', retryable: false } };
      const { ctx, source } = await editor;
      if (scenario.latency > 0) await delay(scenario.latency * (0.6 + Math.random() * 0.8));
      try {
        const result = await renderMockPreview(ctx.actionId, request.options, source, request.maxEdge ?? 1200, bgImage);
        return { ok: true, seq: request.seq, ...result };
      } catch (error) {
        return { ok: false, seq: request.seq, error: { code: 'INVALID_OPTIONS', message: error instanceof Error ? error.message : String(error), retryable: false } };
      }
    },
    async inspectImage(editorId) {
      const editor = editors.get(editorId);
      if (!editor) throw new Error('INTERNAL: Unknown editor');
      await delay(250);
      return (await editor).ctx.image;
    },
    async commitEditor(request) {
      const editor = editors.get(request.editorId);
      if (!editor) return { kind: 'rejected', error: { code: 'INTERNAL', message: 'Unknown editor', retryable: false } };
      const { ctx } = await editor;
      notifyHarness(`commitEditor(${ctx.actionId}) ${JSON.stringify(request.options).slice(0, 160)}`);
      const selection: FileSelection = { selectionId: 'sel-commit', source: 'test', files: ctx.files, menuKey: null };
      return { kind: 'jobs', jobIds: enqueue(ctx.actionId, selection, ACTIONS[ctx.actionId].merges) };
    },
    async cancelEditor(editorId) {
      notifyHarness(`cancelEditor(${editorId})`);
    },
    async pickBackgroundImage() {
      await delay(150);
      bgImage = patternImage(1600, 1200);
      return { fileId: 'bg-pattern', name: 'pattern.jpg' };
    },
    async listJobs() {
      return [...jobs];
    },
    onJobsChanged(listener) {
      jobListeners.add(listener);
      return () => jobListeners.delete(listener);
    },
    async cancelJob(jobId) {
      updateJob(jobId, { state: 'cancelled', finishedAt: Date.now() });
    },
    async retryJobElsewhere(jobId) {
      notifyHarness(`retryJobElsewhere(${jobId}) — folder picker`);
      const job = jobs.find((j) => j.jobId === jobId);
      if (!job) return null;
      const newId = nextId('job');
      jobs = [{ ...job, jobId: newId, state: 'queued', error: null, createdAt: Date.now(), finishedAt: null }, ...jobs];
      runJob(newId, 3, () => ({ outputs: [{ outputId: nextId('out'), name: job.inputName.replace(/\.pdf$/, '.png'), dirDisplay: 'Documents', format: 'png', bytes: 980_000 }] }));
      emitJobs();
      return { kind: 'jobs', jobIds: [newId] };
    },
    async revealOutput(outputId) {
      notifyHarness(`revealOutput(${outputId})`);
    },
    async openOutput(outputId) {
      notifyHarness(`openOutput(${outputId})`);
    },
    async openExternal(url) {
      notifyHarness(`openExternal(${url})`);
      return true;
    },
  };
  return api;
}
