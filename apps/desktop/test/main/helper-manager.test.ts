import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  HELPER_MAX_LINE_BYTES,
  HelperConfigureSchema,
  type HelperConfigureMessage,
  type HelperDropMessage,
  type HelperStatus,
} from '@orbitdrop/contracts';
import { buildConfigureMessage } from '../../src/main/helper/configure';
import { LineReader } from '../../src/main/helper/line-reader';
import { helperCandidates, helperExecutableName } from '../../src/main/helper/locate';
import { HelperManager, type HelperChild, type HelperManagerOptions } from '../../src/main/helper/manager';
import { snapshotWith, tick, waitFor } from './helpers';

class FakeChild extends EventEmitter implements HelperChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly received: Record<string, unknown>[] = [];
  killed = false;
  exited = false;
  /** When true, `kill()` does not make the process exit (hung helper). */
  ignoreKill = false;

  constructor() {
    super();
    const reader = new LineReader(HELPER_MAX_LINE_BYTES, (line) => this.received.push(JSON.parse(line) as Record<string, unknown>));
    this.stdin.on('data', (chunk: Buffer) => reader.push(chunk));
    this.stdin.on('finish', () => {
      // Parent closed stdin (EOF): a real helper exits.
      setTimeout(() => this.exit(0), 5);
    });
  }

  kill(): boolean {
    this.killed = true;
    if (!this.ignoreKill) setTimeout(() => this.exit(null, 'SIGTERM'), 1);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(text: string): void {
    this.stdout.write(text);
  }

  ofType(type: string): Record<string, unknown>[] {
    return this.received.filter((m) => m.type === type);
  }
}

const READY = {
  v: 1,
  type: 'ready',
  helperVersion: '0.1.0',
  platform: 'darwin',
  arch: 'arm64',
  osVersion: '26.6',
  pid: 4242,
  globalDrag: { available: true },
} as const;

function drop(sessionId: string, files = ['/Users/test/Page 001.pdf']): HelperDropMessage {
  return { v: 1, type: 'drop', sessionId, actionId: 'convert.jpeg', mode: 'convert', files, dropEffect: 'copy' };
}

function configureMessage(enabled = true): HelperConfigureMessage {
  return buildConfigureMessage({
    settings: { ...DEFAULT_SETTINGS, globalDrag: { ...DEFAULT_SETTINGS.globalDrag, enabled } },
    snapshot: snapshotWith(),
    theme: 'light',
    reduceMotion: false,
    highContrast: false,
    strings: { dropHint: '여기에 놓기', unsupported: '지원하지 않는 파일', multiFileUnsupported: '한 번에 한 파일만', fileCount: '{n}개 파일' },
  });
}

describe('configure strings', () => {
  it('sends the specific unsupported texts when given (helpers fall back to `unsupported` without them)', () => {
    const base = { settings: DEFAULT_SETTINGS, snapshot: snapshotWith(), theme: 'light' as const, reduceMotion: false, highContrast: false };
    const strings = { dropHint: '여기에 놓기', unsupported: '지원하지 않는 파일', multiFileUnsupported: '한 번에 한 파일만', fileCount: '{n}개 파일' };
    expect(buildConfigureMessage({ ...base, strings }).strings).toEqual(strings);
    const specific = buildConfigureMessage({ ...base, strings: { ...strings, unsupportedFolder: '폴더는 처리할 수 없음', unsupportedNonFile: '파일이 아님', unsupportedVirtual: '먼저 '.repeat(40) } });
    expect(specific.strings).toMatchObject({ unsupportedFolder: '폴더는 처리할 수 없음', unsupportedNonFile: '파일이 아님' });
    expect([...specific.strings.unsupportedVirtual!].length).toBe(60); // clipped like the other texts
  });
});

interface Harness {
  manager: HelperManager;
  children: FakeChild[];
  drops: HelperDropMessage[];
  statuses: HelperStatus[];
  enabled: { value: boolean };
}

const managers: HelperManager[] = [];

function harness(overrides: Partial<HelperManagerOptions> = {}, locate: string | null = '/fake/OrbitDropHelper'): Harness {
  const children: FakeChild[] = [];
  const drops: HelperDropMessage[] = [];
  const statuses: HelperStatus[] = [];
  const enabled = { value: true };
  const manager = new HelperManager({
    locate: async () => (locate ? { path: locate, source: 'dev' } : null),
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    configure: () => configureMessage(enabled.value),
    enabled: () => enabled.value,
    onDrop: (message) => {
      drops.push(message);
    },
    onStatus: (status) => statuses.push(status),
    platform: 'darwin',
    backoffBaseMs: 10,
    backoffMaxMs: 40,
    readyTimeoutMs: 2000,
    shutdownTimeoutMs: 100,
    ...overrides,
  });
  managers.push(manager);
  return { manager, children, drops, statuses, enabled };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
});

describe('LineReader', () => {
  it('splits lines across chunks, handles CRLF and multi-byte characters split between chunks', () => {
    const lines: string[] = [];
    const reader = new LineReader(1024, (line) => lines.push(line));
    const text = Buffer.from('{"a":"한글"}\r\n{"b":2}\n', 'utf8');
    // split inside the first Hangul character (3 bytes in UTF-8)
    const cut = text.indexOf(Buffer.from('한', 'utf8')) + 1;
    reader.push(text.subarray(0, cut));
    reader.push(text.subarray(cut));
    expect(lines).toEqual(['{"a":"한글"}', '{"b":2}']);
  });

  it('drops an over-long line entirely and recovers at the next newline', () => {
    const lines: string[] = [];
    let overflows = 0;
    const reader = new LineReader(16, (line) => lines.push(line), () => (overflows += 1));
    reader.push('x'.repeat(10));
    reader.push('y'.repeat(10)); // now 20 bytes without newline → overflow, discard mode
    reader.push('zzz\nok\n');
    expect(lines).toEqual(['ok']);
    expect(overflows).toBe(1);
    expect(reader.pendingBytes).toBe(0);
    reader.push(`${'a'.repeat(17)}\nfine\n`); // complete over-long line in one chunk
    expect(lines).toEqual(['ok', 'fine']);
    expect(overflows).toBe(2);
  });
});

describe('helper location', () => {
  it('prefers ORBITDROP_HELPER_PATH, then the packaged or dev staging folder', () => {
    const dev = helperCandidates({ packaged: false, resourcesPath: '/res', appPath: '/app', platform: 'darwin', arch: 'arm64' });
    expect(dev[0]).toEqual({ path: '/app/resources/helper/darwin-arm64/OrbitDropHelper', source: 'dev' });
    const packaged = helperCandidates({ envPath: '/custom/helper', packaged: true, resourcesPath: '/res', appPath: '/app', platform: 'darwin', arch: 'arm64' });
    expect(packaged[0]).toEqual({ path: '/custom/helper', source: 'env' });
    expect(packaged[1]).toEqual({ path: '/res/helper/OrbitDropHelper', source: 'packaged' });
    expect(helperExecutableName('win32')).toBe('OrbitDropHelper.exe');
  });
});

describe('configure message', () => {
  it('is valid for the protocol schema and carries settings, menus and strings', () => {
    const message = configureMessage();
    expect(HelperConfigureSchema.safeParse(message).success).toBe(true);
    expect(message.geometry.diameter).toBe(DEFAULT_SETTINGS.globalDrag.wheelDiameter);
    expect(message.modifiers).toEqual({ convert: ['shift'], tools: ['alt', 'shift'] });
    expect(message.extensions['.pdf']).toBe('pdf');
    expect(message.extensions['.jpg']).toBe('image/jpeg');
    expect(message.extensions['.heic']).toBeUndefined(); // not decodable in this build
    const pdf = message.menus.find((m) => m.key === 'pdf')!;
    expect(pdf.convert.map((s) => s.actionId)).toEqual(['convert.docx', 'convert.jpeg', 'convert.png', 'convert.txt']);
    expect(message.strings.dropHint).toBe('여기에 놓기');
  });
});

describe('HelperManager', () => {
  it('reports unavailable when the binary is missing (fallback paths keep working)', async () => {
    const h = harness({}, null);
    await h.manager.start();
    expect(h.manager.status).toEqual({ state: 'unavailable', reason: 'Helper binary not found' });
    expect(h.children).toHaveLength(0);
    expect(await h.manager.waitForReady(10)).toBeNull();
  });

  it('configures the helper on ready and queries permissions on macOS', async () => {
    const h = harness();
    await h.manager.start();
    expect(h.manager.status.state).toBe('starting');
    const child = h.children[0]!;
    child.send(READY);
    await waitFor(() => child.ofType('configure').length === 1, 1000, 'configure');
    const configure = child.ofType('configure')[0]!;
    expect(HelperConfigureSchema.safeParse(configure).success).toBe(true);
    expect(configure.enabled).toBe(true);
    expect(child.ofType('queryPermissions')).toHaveLength(1);
    expect(h.manager.status).toEqual({ state: 'running', helperVersion: '0.1.0', globalDrag: true });
  });

  it('drops invalid and oversized lines and keeps working', async () => {
    const h = harness();
    await h.manager.start();
    const child = h.children[0]!;
    child.sendRaw('not json\n');
    child.sendRaw(`${JSON.stringify({ v: 1, type: 'drop', sessionId: 's1', actionId: 'convert.nope', mode: 'convert', files: ['/a'], dropEffect: 'copy' })}\n`);
    child.sendRaw(`${JSON.stringify({ v: 2, type: 'pong', nonce: 1 })}\n`);
    child.sendRaw(`${'x'.repeat(HELPER_MAX_LINE_BYTES + 10)}\n`);
    child.send(READY);
    await waitFor(() => h.manager.status.state === 'running', 1000, 'running');
    expect(h.manager.invalidLineCount).toBe(3);
    expect(h.drops).toHaveLength(0);
  });

  it('accepts one drop per session, on the next tick, and ignores duplicates and drops after cancel', async () => {
    const h = harness();
    await h.manager.start();
    const child = h.children[0]!;
    child.send(READY);
    await waitFor(() => h.manager.status.state === 'running');

    // This listener runs right after the manager's own 'data' listener: a drop handled in the
    // same tick (synchronously or in a microtask) would change the count before the check runs.
    let deliveredSynchronously = false;
    child.stdout.on('data', () => {
      const before = h.drops.length;
      queueMicrotask(() => {
        if (h.drops.length !== before) deliveredSynchronously = true;
      });
    });

    child.send({ v: 1, type: 'state', sessionId: 's1', state: 'WheelActive', mode: 'convert', menuKey: 'pdf', fileCount: 1 });
    child.send(drop('s1'));
    child.send(drop('s1')); // duplicate
    child.send({ v: 1, type: 'cancelled', sessionId: 's2', reason: 'escape' });
    child.send(drop('s2')); // late drop after cancel
    await waitFor(() => h.drops.length >= 1);
    await tick();
    await tick();
    expect(h.drops.map((d) => d.sessionId)).toEqual(['s1']);
    expect(deliveredSynchronously).toBe(false);
    expect(h.manager.tracker.stateOf('s1')).toBe('DropCommitted');
  });

  it('restarts a crashed helper with backoff, tags sessions per process, then gives up after the cap', async () => {
    const h = harness({ maxRestarts: 2 });
    await h.manager.start();
    const first = h.children[0]!;
    first.send(READY);
    await waitFor(() => h.manager.status.state === 'running');
    first.send({ v: 1, type: 'state', sessionId: 'old', state: 'WheelActive', mode: 'convert' });
    await tick();
    first.exit(1);
    await waitFor(() => h.children.length === 2, 1000, 'second spawn');
    expect(h.manager.tracker.stateOf('old')).toBe('Cancelled'); // the dead process's open session was closed
    const second = h.children[1]!;
    second.send(READY);
    await waitFor(() => second.ofType('configure').length === 1);

    first.send(drop('late-from-dead-process')); // output of the previous process after the restart
    await tick();
    await tick();
    expect(h.drops).toHaveLength(0);

    // Lines of the current process are tagged with its generation: a fresh session drops normally, and
    // even a session id reused from the old process cannot be confused with the old (cancelled) session.
    second.send(drop('fresh'));
    second.send(drop('old'));
    await waitFor(() => h.drops.length === 2, 1000, 'drops of the new process');
    expect(h.drops.map((d) => d.sessionId)).toEqual(['fresh', 'old']);

    second.exit(1);
    await waitFor(() => h.children.length === 3, 1000, 'third spawn');
    h.children[2]!.exit(1);
    await waitFor(() => h.manager.status.state === 'crashed', 1000, 'crashed');
    expect(h.manager.status).toMatchObject({ state: 'crashed', restarts: 2 });
    expect(h.children).toHaveLength(3);
  });

  it('restarts a helper that stops answering pings', async () => {
    const h = harness({ pingIntervalMs: 15, missedPongLimit: 2 });
    await h.manager.start();
    const child = h.children[0]!;
    child.send(READY);
    await waitFor(() => child.ofType('ping').length >= 1, 1000, 'ping');
    await waitFor(() => child.killed, 1000, 'kill');
    await waitFor(() => h.children.length === 2, 1000, 'respawn');
  });

  it('keeps answering helpers alive', async () => {
    const h = harness({ pingIntervalMs: 10, missedPongLimit: 2 });
    await h.manager.start();
    const child = h.children[0]!;
    child.stdin.on('data', () => {
      for (const ping of child.ofType('ping').splice(0)) child.send({ v: 1, type: 'pong', nonce: ping.nonce });
      child.received.splice(0, child.received.length, ...child.received.filter((m) => m.type !== 'ping'));
    });
    child.send(READY);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(child.killed).toBe(false);
  });

  it('reports missing permissions and polls until they are granted', async () => {
    const h = harness({ permissionPollMs: 15 });
    await h.manager.start();
    const child = h.children[0]!;
    child.send({ ...READY, globalDrag: { available: false, reason: 'accessibility permission missing' } });
    child.send({ v: 1, type: 'permissions', items: [{ name: 'accessibility', required: true, granted: false }] });
    await waitFor(() => h.manager.status.state === 'needsPermission');
    expect(h.manager.status).toEqual({ state: 'needsPermission', permissions: ['accessibility'] });
    await waitFor(() => child.ofType('queryPermissions').length >= 3, 1000, 'polling');
    child.send({ ...READY });
    child.send({ v: 1, type: 'permissions', items: [{ name: 'accessibility', required: true, granted: true }] });
    await waitFor(() => h.manager.status.state === 'running');
  });

  it('sends a new configure only when it changed, and reports disabled', async () => {
    const h = harness();
    await h.manager.start();
    const child = h.children[0]!;
    child.send(READY);
    await waitFor(() => child.ofType('configure').length === 1);
    h.manager.reconfigure();
    await tick();
    expect(child.ofType('configure')).toHaveLength(1);
    h.enabled.value = false;
    h.manager.reconfigure();
    await waitFor(() => child.ofType('configure').length === 2);
    expect(child.ofType('configure')[1]!.enabled).toBe(false);
    expect(h.manager.status).toEqual({ state: 'disabled' });
  });

  it('shuts down with a shutdown message and EOF, killing a helper that does not exit', async () => {
    const h = harness();
    await h.manager.start();
    const child = h.children[0]!;
    child.send(READY);
    await waitFor(() => h.manager.status.state === 'running');
    await h.manager.stop();
    expect(child.ofType('shutdown')).toHaveLength(1);
    expect(child.exited).toBe(true);
    expect(child.killed).toBe(false);

    const h2 = harness();
    await h2.manager.start();
    const stubborn = h2.children[0]!;
    stubborn.stdin.removeAllListeners('finish');
    stubborn.send(READY);
    await waitFor(() => h2.manager.status.state === 'running');
    const stop = h2.manager.stop();
    await waitFor(() => stubborn.killed, 1000, 'kill after timeout');
    await stop;
    expect(h2.children).toHaveLength(1); // no restart after an intentional stop
  });

  it('a helper that never reports ready is restarted', async () => {
    const h = harness({ readyTimeoutMs: 30 });
    await h.manager.start();
    await waitFor(() => h.children[0]!.killed, 1000, 'kill');
    await waitFor(() => h.children.length === 2, 1000, 'respawn');
  });

  it('logs no file paths for drops', async () => {
    const lines: string[] = [];
    const log = { debug: vi.fn(), info: (m: string, d?: object) => lines.push(m + JSON.stringify(d ?? {})), warn: vi.fn(), error: vi.fn() };
    const h = harness({ log });
    await h.manager.start();
    const child = h.children[0]!;
    child.send(READY);
    await waitFor(() => h.manager.status.state === 'running');
    child.send(drop('s9', ['/Users/someone/Secret Plans.pdf']));
    await waitFor(() => h.drops.length === 1);
    expect(lines.join('\n')).not.toContain('Secret Plans');
    expect(lines.join('\n')).toContain('s9');
  });
});
