import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  type ActionId,
  type EditorContext,
  type EngineProbe,
  type FileFormat,
  type FileSelection,
  type FormatSupport,
  type ImageInfo,
  type JobSnapshot,
  type OrbitApi,
  type Settings,
  type WheelMenu,
  type WheelMode,
} from '@orbitdrop/contracts';
import { buildCapabilitySnapshot, buildWheelMenu } from '@orbitdrop/core';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi, type Mock } from 'vitest';
import { EnvProvider } from '../../src/renderer/src/app/env';

/** OrbitApi whose methods are vitest mocks with sensible defaults. */
export type FakeOrbit = {
  -readonly [K in keyof OrbitApi]: OrbitApi[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : OrbitApi[K];
};

const SUPPORT = (input: boolean, output: boolean): FormatSupport => ({
  input,
  output,
  inputEngine: input ? 'sharp' : 'none',
  outputEngine: output ? 'sharp' : 'none',
});

/** Engine probe like the darwin-arm64 build: no HEIC/BMP encoders. */
export const FAKE_PROBE: EngineProbe = {
  platform: 'darwin',
  arch: 'arm64',
  versions: { sharp: '0.35.5' },
  formats: {
    jpeg: SUPPORT(true, true),
    png: SUPPORT(true, true),
    webp: SUPPORT(true, true),
    gif: SUPPORT(true, false),
    tiff: SUPPORT(true, true),
    avif: SUPPORT(true, true),
    heic: SUPPORT(false, false),
    bmp: SUPPORT(false, false),
    pdf: { input: true, output: true, inputEngine: 'pdfjs', outputEngine: 'pdf-lib' },
    docx: { input: false, output: true, inputEngine: 'none', outputEngine: 'docx' },
    txt: { input: false, output: true, inputEngine: 'none', outputEngine: 'text' },
  } satisfies Record<FileFormat, FormatSupport>,
  pdfRender: true,
  pdfText: true,
  koreanFont: 'Apple SD Gothic Neo',
  errors: [],
  probedAt: 0,
};

export const FAKE_CAPABILITIES = buildCapabilitySnapshot(FAKE_PROBE);

export function sampleMenu(mode: WheelMode, key: WheelMenu['key'] = 'image/jpeg', locale: 'ko' | 'en' = 'ko'): WheelMenu {
  return buildWheelMenu(FAKE_CAPABILITIES, key, mode, locale);
}

export function sampleSelection(overrides: Partial<FileSelection> = {}): FileSelection {
  return {
    selectionId: 'sel1',
    source: 'test',
    files: [{ fileId: 'f1', name: 'photo.jpg', ext: '.jpg', format: 'jpeg', kind: 'image', bytes: 1_234_567 }],
    menuKey: 'image/jpeg',
    ...overrides,
  };
}

export function sampleImageInfo(overrides: Partial<ImageInfo> = {}): ImageInfo {
  return {
    format: 'jpeg',
    bytes: 1_234_567,
    width: 4032,
    height: 3024,
    orientedWidth: 4032,
    orientedHeight: 3024,
    orientation: 1,
    hasAlpha: false,
    channels: 3,
    space: 'srgb',
    density: 72,
    bitDepth: 'uchar',
    hasIccProfile: true,
    iccDescription: 'Display P3',
    hasExif: true,
    hasXmp: false,
    hasIptc: false,
    exif: null,
    pages: null,
    ...overrides,
  };
}

export function sampleEditorContext(actionId: ActionId, overrides: Partial<EditorContext> = {}): EditorContext {
  const image = overrides.image ?? sampleImageInfo();
  return {
    editorId: 'ed1',
    actionId,
    files: [{ fileId: 'f1', name: 'photo.jpg', ext: '.jpg', format: 'jpeg', kind: 'image', bytes: image.bytes }],
    image,
    source: { url: 'data:image/png;base64,', width: 1600, height: Math.round((1600 * image.orientedHeight) / image.orientedWidth) },
    defaults: {},
    settings: DEFAULT_SETTINGS,
    ...overrides,
  };
}

export function sampleJob(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    jobId: 'job1',
    batchId: null,
    sessionId: null,
    actionId: 'convert.png',
    inputName: 'photo.jpg',
    inputCount: 1,
    state: 'running',
    progress: { kind: 'indeterminate' },
    createdAt: Date.UTC(2026, 9, 21, 9, 30),
    startedAt: Date.UTC(2026, 9, 21, 9, 30),
    finishedAt: null,
    outputs: [],
    warnings: [],
    error: null,
    inputBytes: 1_234_567,
    ...overrides,
  };
}

export function createFakeOrbit(overrides: Partial<OrbitApi> = {}): FakeOrbit {
  let settings: Settings = DEFAULT_SETTINGS;
  const unsubscribe = () => undefined;
  const base: FakeOrbit = {
    platform: 'darwin',
    getWindowContext: vi.fn(async () => ({ kind: 'jobs' as const })),
    closeWindow: vi.fn(),
    resizeWindow: vi.fn(),
    openWindow: vi.fn(async () => undefined),
    getAppInfo: vi.fn(async () => ({
      name: 'OrbitDrop',
      version: '0.1.0',
      platform: 'darwin' as const,
      arch: 'arm64',
      electron: '44.9.0',
      chrome: '152.0.0.0',
      node: '24.7.0',
      packaged: false,
      locale: 'ko' as const,
    })),
    getCapabilities: vi.fn(async () => FAKE_CAPABILITIES),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch) => {
      const next = applySettingsPatch(settings, patch);
      if (next === null) throw new Error('INVALID_OPTIONS: invalid settings patch');
      settings = next;
      return next;
    }),
    onSettingsChanged: vi.fn(() => unsubscribe),
    getHelperStatus: vi.fn(async () => ({ state: 'running' as const, helperVersion: '1.0.0', globalDrag: true })),
    onHelperStatusChanged: vi.fn(() => unsubscribe),
    openFileDialog: vi.fn(async () => null),
    registerDroppedFiles: vi.fn(async () => sampleSelection()),
    getSelection: vi.fn(async () => sampleSelection()),
    getMenu: vi.fn(async (_id: string, mode: WheelMode) => sampleMenu(mode)),
    submitAction: vi.fn(async () => ({ kind: 'jobs' as const, jobIds: ['job1'] })),
    getEditor: vi.fn(async () => sampleEditorContext('tool.crop')),
    requestPreview: vi.fn(async (request) => ({ ok: true as const, seq: request.seq, url: 'data:image/png;base64,', width: 400, height: 300 })),
    inspectImage: vi.fn(async () => sampleImageInfo()),
    commitEditor: vi.fn(async () => ({ kind: 'jobs' as const, jobIds: ['job1'] })),
    cancelEditor: vi.fn(async () => undefined),
    pickBackgroundImage: vi.fn(async () => null),
    listJobs: vi.fn(async () => []),
    onJobsChanged: vi.fn(() => unsubscribe),
    cancelJob: vi.fn(async () => undefined),
    retryJobElsewhere: vi.fn(async () => null),
    revealOutput: vi.fn(async () => undefined),
    openOutput: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => true),
  };
  for (const [key, value] of Object.entries(overrides)) {
    const current = (base as Record<string, unknown>)[key];
    if (typeof value === 'function' && typeof current === 'function' && 'mockImplementation' in (current as object)) {
      (current as Mock).mockImplementation(value as (...args: unknown[]) => unknown);
    } else {
      (base as Record<string, unknown>)[key] = value;
    }
  }
  return base;
}

export interface RenderWithEnvOptions {
  readonly orbit?: FakeOrbit;
  readonly settings?: Settings;
}

export function renderWithEnv(ui: ReactElement, options: RenderWithEnvOptions = {}): RenderResult & { orbit: FakeOrbit } {
  const orbit = options.orbit ?? createFakeOrbit();
  const result = render(
    <EnvProvider orbit={orbit as unknown as OrbitApi} initialSettings={options.settings ?? DEFAULT_SETTINGS}>
      {ui}
    </EnvProvider>,
  );
  return { ...result, orbit };
}

/** Promise you resolve/reject by hand (out-of-order IPC responses in tests). */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
