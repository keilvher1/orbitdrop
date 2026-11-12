import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, IPC_CHANNELS, OrbitError, applySettingsPatch } from '@orbitdrop/contracts';
import { EVENT_CHANNELS, registerOrbitIpc, type OrbitIpcServices } from '../../src/main/ipc/channels';
import { IpcRouter, resolveSender, type FrameLike, type IpcEventLike, type IpcMainLike, type SenderLike } from '../../src/main/ipc/router';
import { registerSupportIpc, type SupportIpcServices } from '../../src/main/ipc/support';

type Listener = (event: never, ...args: unknown[]) => unknown;

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, Listener>();
  readonly listeners = new Map<string, Listener>();
  handle(channel: string, listener: Listener): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler ${channel}`);
    this.handlers.set(channel, listener);
  }
  on(channel: string, listener: Listener): this {
    this.listeners.set(channel, listener);
    return this;
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  removeAllListeners(channel: string): this {
    this.listeners.delete(channel);
    return this;
  }
  invoke(channel: string, event: IpcEventLike, payload?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler ${channel}`);
    return Promise.resolve(handler(event as never, payload));
  }
  send(channel: string, event: IpcEventLike, payload?: unknown): void {
    this.listeners.get(channel)!(event as never, payload);
  }
}

interface Rec {
  readonly windowId: number;
}

const TRUSTED = 'file:///app/out/renderer/index.html';
const mainFrame: FrameLike = { url: TRUSTED, processId: 7, routingId: 1 };
const ours: SenderLike = { id: 11, mainFrame };
const foreign: SenderLike = { id: 99, mainFrame: { url: TRUSTED, processId: 9, routingId: 1 } };

const fromOurs: IpcEventLike = { sender: ours, senderFrame: mainFrame };
const fromSubframe: IpcEventLike = { sender: ours, senderFrame: { url: TRUSTED, processId: 7, routingId: 5 } };
const fromOurWindowBadPage: IpcEventLike = { sender: { id: 11, mainFrame: { url: 'https://evil.example/', processId: 7, routingId: 1 } }, senderFrame: { url: 'https://evil.example/', processId: 7, routingId: 1 } };
const fromForeign: IpcEventLike = { sender: foreign, senderFrame: foreign.mainFrame };

const guard = {
  lookup: (sender: SenderLike): Rec | undefined => (sender.id === 11 ? { windowId: 1 } : undefined),
  isTrustedUrl: (url: string) => url.startsWith('file:///app/out/renderer/index.html'),
};

const UPDATE_STATE = { state: 'upToDate', currentVersion: '0.1.0', autoCheck: true, lastCheckedAt: 1 } as const;

function services(): OrbitIpcServices<Rec> & Record<string, ReturnType<typeof vi.fn>> {
  const fn = <T>(value?: T) => vi.fn(async () => value);
  return {
    windowContext: vi.fn(() => ({ kind: 'jobs' as const })),
    closeWindow: vi.fn(),
    resizeWindow: vi.fn(),
    openWindow: vi.fn(),
    appInfo: vi.fn(() => ({ name: 'OrbitDrop', version: '0', platform: 'darwin', arch: 'arm64', electron: '', chrome: '', node: '', packaged: false, locale: 'ko' })),
    capabilities: fn(),
    settings: vi.fn(() => DEFAULT_SETTINGS),
    updateSettings: vi.fn(async (patch: unknown) => {
      const next = applySettingsPatch(DEFAULT_SETTINGS, patch);
      if (!next) throw new OrbitError('INVALID_OPTIONS', 'Invalid settings patch');
      return next;
    }),
    helperStatus: vi.fn(() => ({ state: 'disabled' as const })),
    openFileDialog: fn(null),
    registerDroppedPaths: fn(),
    selection: vi.fn(() => {
      throw new OrbitError('INTERNAL', 'Unknown or expired selection');
    }),
    menu: fn(),
    submit: fn({ kind: 'jobs', jobIds: [] }),
    editor: fn(),
    preview: fn(),
    inspect: fn(),
    commit: fn(),
    cancelEditor: fn(),
    pickBackground: fn(null),
    jobs: vi.fn(() => []),
    cancelJob: fn(),
    retryElsewhere: fn(null),
    revealOutput: vi.fn(async () => {
      throw new Error('ENOENT: no such file, open /Users/someone/private.png');
    }),
    openOutput: fn(),
    openExternal: fn(true),
    thumbnail: fn({ fileId: 'f_1', url: 'orbit-preview://p/AAAAAAAAAAAAAAAAAAAAAAAA', width: 96, height: 72 }),
    estimate: fn({ ok: true, seq: 1, fileId: 'f_1', estimatedBytes: 10 }),
    clearFinishedJobs: vi.fn(() => 0),
    retryJob: fn({ kind: 'jobs', jobIds: ['job_2'] }),
    setCloseGuard: vi.fn(),
    updateState: vi.fn(() => UPDATE_STATE),
    checkForUpdates: vi.fn(async () => UPDATE_STATE),
    restartToUpdate: vi.fn(() => ({ ...UPDATE_STATE, state: 'downloaded', version: '0.2.0', restartPending: true })),
  } as unknown as OrbitIpcServices<Rec> & Record<string, ReturnType<typeof vi.fn>>;
}

function supportServices(): SupportIpcServices<Rec> & Record<string, ReturnType<typeof vi.fn>> {
  return {
    windowNotice: vi.fn(() => ({ kind: 'recovered', unsavedLost: true })),
    rendererError: vi.fn(),
    copyDiagnostics: vi.fn(async () => ({ logLines: 3 })),
    openLogFolder: vi.fn(async () => undefined),
    openDataFolder: vi.fn(async () => undefined),
    resetSettings: vi.fn(async () => DEFAULT_SETTINGS),
    openLicense: vi.fn(async () => undefined),
    restartHelper: vi.fn(async () => undefined),
  } as unknown as SupportIpcServices<Rec> & Record<string, ReturnType<typeof vi.fn>>;
}

function setup() {
  const ipc = new FakeIpcMain();
  const s = services();
  const support = supportServices();
  const router = new IpcRouter<Rec>(ipc, guard);
  registerOrbitIpc(router, s);
  registerSupportIpc(router, support);
  return { ipc, s, support, router };
}

describe('resolveSender', () => {
  it('accepts only the main frame of a registered window showing our renderer', () => {
    expect(resolveSender(fromOurs, guard)).toEqual({ windowId: 1 });
    expect(() => resolveSender(fromForeign, guard)).toThrow('Untrusted sender');
    expect(() => resolveSender(fromSubframe, guard)).toThrow('main frame');
    expect(() => resolveSender(fromOurWindowBadPage, guard)).toThrow('Untrusted page');
    expect(() => resolveSender({ sender: ours, senderFrame: null }, guard)).toThrow();
  });
});

describe('IPC channels', () => {
  it('registers every OrbitApi request channel (events are main → renderer only)', () => {
    const { ipc } = setup();
    const registered = new Set([...ipc.handlers.keys(), ...ipc.listeners.keys()]);
    const expected = Object.values(IPC_CHANNELS).filter((c) => !(EVENT_CHANNELS as readonly string[]).includes(c));
    expect([...registered].sort()).toEqual([...expected].sort());
    expect(ipc.listeners.has(IPC_CHANNELS.windowClose) && ipc.listeners.has(IPC_CHANNELS.windowResize)).toBe(true);
  });

  it('rejects calls from foreign senders without running the service', async () => {
    const { ipc, s } = setup();
    const rejection = await ipc.invoke(IPC_CHANNELS.actionSubmit, fromForeign, { selectionId: 'sel_1', actionId: 'convert.jpeg' }).catch((e: unknown) => e as Error);
    expect(rejection).toMatchObject({ name: 'Error', message: 'INTERNAL: Untrusted sender' });
    await expect(ipc.invoke(IPC_CHANNELS.settingsGet, fromSubframe)).rejects.toThrow(/^INTERNAL/);
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.settings).not.toHaveBeenCalled();
    ipc.send(IPC_CHANNELS.windowClose, fromForeign);
    expect(s.closeWindow).not.toHaveBeenCalled();
  });

  it('rejects invalid payloads with INVALID_OPTIONS', async () => {
    const { ipc, s } = setup();
    const bad: [string, unknown][] = [
      [IPC_CHANNELS.actionSubmit, { selectionId: 'sel_1', actionId: 'convert.exe' }],
      [IPC_CHANNELS.actionSubmit, { selectionId: '../../etc', actionId: 'convert.jpeg' }],
      [IPC_CHANNELS.actionSubmit, { selectionId: 'sel_1', actionId: 'convert.jpeg', path: '/etc/passwd' }],
      [IPC_CHANNELS.selectionGet, { id: 'a'.repeat(65) }],
      [IPC_CHANNELS.selectionGet, 'sel_1'],
      [IPC_CHANNELS.menuGet, { selectionId: 'sel_1', mode: 'everything' }],
      [IPC_CHANNELS.editorPreview, { editorId: 'ed_1', seq: -1, options: {} }],
      [IPC_CHANNELS.editorPreview, { editorId: 'ed_1', seq: 1, options: {}, maxEdge: 100000 }],
      [IPC_CHANNELS.windowOpen, { kind: 'editor' }],
      [IPC_CHANNELS.filesRegisterPaths, { paths: [], source: 'dropZone' }],
      [IPC_CHANNELS.filesRegisterPaths, { paths: ['/a'], source: 'globalDrag' }],
      [IPC_CHANNELS.externalOpen, { url: 'x'.repeat(5000) }],
      [IPC_CHANNELS.jobCancel, {}],
      [IPC_CHANNELS.jobRetry, { id: '../job' }],
      [IPC_CHANNELS.jobRetry, { id: 'job_1', force: true }],
      [IPC_CHANNELS.jobsClearFinished, { finishedUpTo: -1 }],
      [IPC_CHANNELS.jobsClearFinished, { finishedUpTo: 'all' }],
      [IPC_CHANNELS.jobsClearFinished, { finishedUpTo: 5, also: 'running' }],
      [IPC_CHANNELS.jobsClearFinished, undefined],
      [IPC_CHANNELS.editorThumbnail, { editorId: 'ed_1', fileId: 'f_1', maxEdge: 4000 }],
      [IPC_CHANNELS.editorThumbnail, { editorId: 'ed_1', fileId: '/etc/passwd' }],
      [IPC_CHANNELS.editorThumbnail, { editorId: 'ed_1', fileId: 'f_1', path: '/a.png' }],
      [IPC_CHANNELS.editorEstimate, { editorId: 'ed_1', fileId: 'f_1', seq: -1, options: {} }],
      [IPC_CHANNELS.editorEstimate, { editorId: 'ed_1', fileId: 'f_1', seq: 1.5, options: {} }],
      [IPC_CHANNELS.editorEstimate, { editorId: 'ed_1', seq: 1, options: {} }],
    ];
    for (const [channel, payload] of bad) {
      const error = await ipc.invoke(channel, fromOurs, payload).then(
        () => null,
        (e: unknown) => e as Error,
      );
      // A plain Error: Electron serializes "<name>: <message>", so the code must start the message of an `Error`.
      expect(error?.name, channel).toBe('Error');
      expect(error?.message, channel).toBe('INVALID_OPTIONS: Invalid request');
    }
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.registerDroppedPaths).not.toHaveBeenCalled();
    for (const service of ['retryJob', 'clearFinishedJobs', 'thumbnail', 'estimate']) expect(s[service], service).not.toHaveBeenCalled();
    ipc.send(IPC_CHANNELS.windowResize, fromOurs, { width: 10, height: 10 });
    expect(s.resizeWindow).not.toHaveBeenCalled();
  });

  it('passes validated payloads and the sender record to the services', async () => {
    const { ipc, s } = setup();
    await ipc.invoke(IPC_CHANNELS.actionSubmit, fromOurs, { selectionId: 'sel_1', actionId: 'tool.crop', fileIds: ['f_1'] });
    expect(s.submit).toHaveBeenCalledWith({ selectionId: 'sel_1', actionId: 'tool.crop', fileIds: ['f_1'] }, { windowId: 1 });
    await ipc.invoke(IPC_CHANNELS.filesRegisterPaths, fromOurs, { paths: ['/Users/me/a.png'], source: 'dropZone' });
    expect(s.registerDroppedPaths).toHaveBeenCalledWith(['/Users/me/a.png'], { windowId: 1 });
    ipc.send(IPC_CHANNELS.windowResize, fromOurs, { width: 520, height: 700 });
    expect(s.resizeWindow).toHaveBeenCalledWith({ windowId: 1 }, 520, 700);
    expect(await ipc.invoke(IPC_CHANNELS.windowContext, fromOurs)).toEqual({ kind: 'jobs' });
    // polish-pass channels
    await ipc.invoke(IPC_CHANNELS.jobRetry, fromOurs, { id: 'job_1' });
    expect(s.retryJob).toHaveBeenCalledWith('job_1', { windowId: 1 });
    await ipc.invoke(IPC_CHANNELS.jobsClearFinished, fromOurs, { finishedUpTo: 1234 });
    await ipc.invoke(IPC_CHANNELS.jobsClearFinished, fromOurs, {});
    expect((s.clearFinishedJobs as unknown as ReturnType<typeof vi.fn>).mock.calls).toEqual([[1234], [undefined]]);
    await ipc.invoke(IPC_CHANNELS.editorThumbnail, fromOurs, { editorId: 'ed_1', fileId: 'f_1', maxEdge: 96 });
    expect(s.thumbnail).toHaveBeenCalledWith({ editorId: 'ed_1', fileId: 'f_1', maxEdge: 96 });
    await ipc.invoke(IPC_CHANNELS.editorEstimate, fromOurs, { editorId: 'ed_1', fileId: 'f_1', seq: 3, options: { quality: 50 } });
    expect(s.estimate).toHaveBeenCalledWith({ editorId: 'ed_1', fileId: 'f_1', seq: 3, options: { quality: 50 } });
  });

  it('refuses the polish-pass channels from foreign senders and sub-frames', async () => {
    const { ipc, s } = setup();
    for (const [channel, payload] of [
      [IPC_CHANNELS.jobRetry, { id: 'job_1' }],
      [IPC_CHANNELS.jobsClearFinished, {}],
      [IPC_CHANNELS.editorThumbnail, { editorId: 'ed_1', fileId: 'f_1' }],
      [IPC_CHANNELS.editorEstimate, { editorId: 'ed_1', fileId: 'f_1', seq: 1, options: {} }],
    ] as const) {
      await expect(ipc.invoke(channel, fromForeign, payload), channel).rejects.toThrow('INTERNAL: Untrusted sender');
      await expect(ipc.invoke(channel, fromSubframe, payload), channel).rejects.toThrow(/^INTERNAL/);
    }
    for (const service of ['retryJob', 'clearFinishedJobs', 'thumbnail', 'estimate']) expect(s[service], service).not.toHaveBeenCalled();
  });

  it('converts errors to "<CODE>: message" and never leaks unexpected error details', async () => {
    const { ipc } = setup();
    await expect(ipc.invoke(IPC_CHANNELS.selectionGet, fromOurs, { id: 'sel_missing' })).rejects.toThrow('INTERNAL: Unknown or expired selection');
    await expect(ipc.invoke(IPC_CHANNELS.settingsUpdate, fromOurs, { globalDrag: { wheelDiameter: 9999 } })).rejects.toThrow('INVALID_OPTIONS: Invalid settings patch');
    const leak = ipc.invoke(IPC_CHANNELS.outputReveal, fromOurs, { id: 'out_1' });
    await expect(leak).rejects.toThrow('INTERNAL: Unexpected error');
    await expect(leak).rejects.not.toThrow(/private\.png/);
  });

  it('close guard: a validated boolean from a trusted main frame reaches the service; anything else is dropped', () => {
    const { ipc, s } = setup();
    expect(EVENT_CHANNELS).toContain(IPC_CHANNELS.windowCloseRequested); // main → renderer only
    expect(ipc.handlers.has(IPC_CHANNELS.windowCloseRequested) || ipc.listeners.has(IPC_CHANNELS.windowCloseRequested)).toBe(false);
    ipc.send(IPC_CHANNELS.windowCloseGuard, fromOurs, { guard: true });
    ipc.send(IPC_CHANNELS.windowCloseGuard, fromOurs, { guard: false });
    expect((s.setCloseGuard as unknown as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [{ windowId: 1 }, true],
      [{ windowId: 1 }, false],
    ]);
    for (const payload of [{ guard: 'yes' }, { guard: true, windowId: 7 }, true, undefined]) ipc.send(IPC_CHANNELS.windowCloseGuard, fromOurs, payload);
    ipc.send(IPC_CHANNELS.windowCloseGuard, fromForeign, { guard: true });
    ipc.send(IPC_CHANNELS.windowCloseGuard, fromSubframe, { guard: true });
    expect(s.setCloseGuard).toHaveBeenCalledTimes(2);
  });

  it('first run / help / diagnostics channels: validated payloads, the sender record, nothing from foreign senders', async () => {
    const { ipc, support } = setup();
    expect(await ipc.invoke(IPC_CHANNELS.windowNotice, fromOurs)).toEqual({ kind: 'recovered', unsavedLost: true });
    expect(support.windowNotice).toHaveBeenCalledWith({ windowId: 1 });
    expect(await ipc.invoke(IPC_CHANNELS.diagnosticsCopy, fromOurs)).toEqual({ logLines: 3 });
    await ipc.invoke(IPC_CHANNELS.logFolderOpen, fromOurs);
    await ipc.invoke(IPC_CHANNELS.dataFolderOpen, fromOurs);
    await ipc.invoke(IPC_CHANNELS.settingsReset, fromOurs);
    await ipc.invoke(IPC_CHANNELS.helperRestart, fromOurs);
    await ipc.invoke(IPC_CHANNELS.licenseOpen, fromOurs, { which: 'chromium' });
    expect(support.openLicense).toHaveBeenCalledWith('chromium');
    for (const service of ['copyDiagnostics', 'openLogFolder', 'openDataFolder', 'resetSettings', 'restartHelper']) expect(support[service], service).toHaveBeenCalledTimes(1);

    // Licence files are named, never given as paths.
    for (const payload of [{ which: '/etc/passwd' }, { which: 'electron', path: '/x' }, 'electron', undefined]) {
      await expect(ipc.invoke(IPC_CHANNELS.licenseOpen, fromOurs, payload)).rejects.toThrow('INVALID_OPTIONS: Invalid request');
    }
    expect(support.openLicense).toHaveBeenCalledTimes(1);
    for (const channel of [IPC_CHANNELS.diagnosticsCopy, IPC_CHANNELS.settingsReset, IPC_CHANNELS.logFolderOpen, IPC_CHANNELS.windowNotice]) {
      await expect(ipc.invoke(channel, fromForeign), channel).rejects.toThrow('INTERNAL: Untrusted sender');
      await expect(ipc.invoke(channel, fromSubframe), channel).rejects.toThrow(/^INTERNAL/);
    }
    expect(support.resetSettings).toHaveBeenCalledTimes(1);
  });

  it('renderer error reports: a size-capped, strict payload from a trusted main frame; anything else is dropped', () => {
    const { ipc, support } = setup();
    const report = { source: 'boundary', name: 'TypeError', message: 'x is undefined', stack: 'TypeError: x\n    at View (file:///app/out/renderer/assets/index.js:1:2)', componentStack: '\n    at View' };
    ipc.send(IPC_CHANNELS.rendererError, fromOurs, report);
    expect(support.rendererError).toHaveBeenCalledWith(report, { windowId: 1 });
    for (const payload of [
      { ...report, message: 'm'.repeat(4001) },
      { ...report, stack: 's'.repeat(16_001) },
      { ...report, source: 'main' },
      { ...report, path: '/Users/me/a.png' },
      { source: 'boundary' },
      'boom',
      undefined,
    ]) {
      ipc.send(IPC_CHANNELS.rendererError, fromOurs, payload);
    }
    ipc.send(IPC_CHANNELS.rendererError, fromForeign, report);
    ipc.send(IPC_CHANNELS.rendererError, fromSubframe, report);
    expect(support.rendererError).toHaveBeenCalledTimes(1);
  });

  it('update channels: answered for our windows, without a payload; foreign senders, sub-frames and payloads are refused', async () => {
    const { ipc, s } = setup();
    expect(EVENT_CHANNELS).toContain(IPC_CHANNELS.updateStateChanged); // main → renderer only
    expect(ipc.handlers.has(IPC_CHANNELS.updateStateChanged) || ipc.listeners.has(IPC_CHANNELS.updateStateChanged)).toBe(false);
    expect(await ipc.invoke(IPC_CHANNELS.updateState, fromOurs)).toEqual(UPDATE_STATE);
    expect(await ipc.invoke(IPC_CHANNELS.updateCheck, fromOurs)).toEqual(UPDATE_STATE);
    expect(await ipc.invoke(IPC_CHANNELS.updateRestart, fromOurs)).toMatchObject({ state: 'downloaded', restartPending: true });
    for (const channel of [IPC_CHANNELS.updateState, IPC_CHANNELS.updateCheck, IPC_CHANNELS.updateRestart]) {
      await expect(ipc.invoke(channel, fromForeign), channel).rejects.toThrow('INTERNAL: Untrusted sender');
      await expect(ipc.invoke(channel, fromSubframe), channel).rejects.toThrow(/^INTERNAL/);
      await expect(ipc.invoke(channel, fromOurWindowBadPage), channel).rejects.toThrow('INTERNAL: Untrusted page');
      for (const payload of [{}, { force: true }, 'now', 0, null]) {
        await expect(ipc.invoke(channel, fromOurs, payload), `${channel} ${JSON.stringify(payload)}`).rejects.toThrow('INVALID_OPTIONS: Invalid request');
      }
    }
    expect(s.updateState).toHaveBeenCalledTimes(1);
    expect(s.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(s.restartToUpdate).toHaveBeenCalledTimes(1);
  });

  it('dispose removes every channel', () => {
    const { ipc, router } = setup();
    router.dispose();
    expect(ipc.handlers.size + ipc.listeners.size).toBe(0);
  });
});
