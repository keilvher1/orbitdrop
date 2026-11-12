import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROCESSING_LIMITS,
  DEFAULT_SETTINGS,
  OrbitError,
  type ActionId,
  type FileFormat,
  type ProcessorCredentials,
  type ProcessorJob,
  type ProcessorResult,
  type Settings,
} from '@orbitdrop/contracts';
import { buildCapabilitySnapshot, buildHelperMenus } from '@orbitdrop/core';
import { ANALYSIS_KEY_FILE, AnalysisKeyStore, type SecretBox } from '../../src/main/analysis/key-store';
import { AnalysisService } from '../../src/main/analysis/service';
import { ScriptedAnalysisBackend } from '../../src/main/analysis/test-backend';
import { EditorSessions } from '../../src/main/editor/sessions';
import { OutputRegistry } from '../../src/main/files/outputs';
import { FileRegistry } from '../../src/main/files/registry';
import { buildConfigureMessage } from '../../src/main/helper/configure';
import { HistoryStore } from '../../src/main/history/store';
import { JobManager, type PoolRunner } from '../../src/main/jobs/manager';
import { SubmissionService } from '../../src/main/jobs/submission';
import { redactPaths, redactSecrets, scrubPaths, type LogData, type Logger } from '../../src/main/log';
import { workerEnv } from '../../src/main/processing/electron-worker';
import { ProcessorPool } from '../../src/main/processing/pool';
import { PreviewStore } from '../../src/main/preview/store';
import { fakeFleet, standardBehavior } from './fake-worker';
import { fakeValidator, imageInfo, probeWith, snapshotWith } from './helpers';

/** Fake keys in the real format: valid nowhere. */
const KEY = `sk-ant-api03-${'K'.repeat(86)}WXYZ`;
const OTHER_KEY = `sk-ant-api03-${'L'.repeat(86)}ABCD`;

/** A safeStorage stand-in: reversible, never stores the text as typed, counts calls. */
class FakeBox implements SecretBox {
  available = true;
  backend: string | undefined = undefined;
  failEncrypt = false;
  failDecrypt = false;
  encrypts = 0;
  decrypts = 0;
  isEncryptionAvailable(): boolean {
    return this.available;
  }
  encryptString(plainText: string): Buffer {
    this.encrypts += 1;
    if (this.failEncrypt) throw new Error('Error while encrypting the text provided to safeStorage.encryptString');
    return Buffer.from(`fake:${Buffer.from(plainText).toString('hex')}`);
  }
  decryptString(encrypted: Buffer): string {
    this.decrypts += 1;
    if (this.failDecrypt) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString');
    const text = encrypted.toString();
    if (!text.startsWith('fake:')) throw new Error('bad ciphertext');
    return Buffer.from(text.slice(5), 'hex').toString();
  }
  getSelectedStorageBackend(): string {
    return this.backend ?? 'gnome_libsecret';
  }
}

/** A logger that keeps every raw message and value (before any redaction). */
function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (message: string, data?: LogData) => {
    lines.push(`${level} ${message} ${JSON.stringify(data ?? {})}`);
  };
  return { lines, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OrbitError) return error.code;
    throw error;
  }
  return 'ok';
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-analysis-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AnalysisKeyStore', () => {
  it('encrypts the key into its own 0600 file, keeps only the hint in clear, and decrypts it back on demand', async () => {
    const box = new FakeBox();
    const log = recordingLogger();
    const store = new AnalysisKeyStore(dir, box, log);
    await store.load();
    expect(store.hasKey()).toBe(false);
    expect(store.hint()).toBeNull();
    await store.save(`  ${KEY}\n`); // pasted with whitespace around it
    expect(store.hasKey()).toBe(true);
    expect(store.hint()).toBe('…WXYZ');
    expect(store.file).toBe(join(dir, ANALYSIS_KEY_FILE));
    const raw = await readFile(store.file, 'utf8');
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(KEY.slice(13, 60));
    expect(JSON.parse(raw)).toMatchObject({ format: 'orbitdrop-claude-api-key', version: 1, hint: 'WXYZ' });
    if (process.platform !== 'win32') expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    expect(box.decrypts).toBe(0); // saving and showing the status never decrypt
    expect(await store.read()).toBe(KEY);
    expect(box.decrypts).toBe(1);

    // A new run: only the file is read at startup; nothing is decrypted until needed.
    const again = new AnalysisKeyStore(dir, box, log);
    await again.load();
    expect([again.hasKey(), again.hint(), box.decrypts]).toEqual([true, '…WXYZ', 1]);
    await again.save(OTHER_KEY);
    expect(await again.read()).toBe(OTHER_KEY);
    await again.remove();
    expect([again.hasKey(), again.hint()]).toEqual([false, null]);
    await expect(stat(again.file)).rejects.toMatchObject({ code: 'ENOENT' });
    await again.remove(); // nothing to delete: fine
    expect(await codeOf(again.read())).toBe('ANALYSIS_NOT_CONFIGURED');
    expect(log.lines.join('\n')).not.toContain(KEY.slice(13, 40));
  });

  it('refuses to save when the OS cannot encrypt (and on Linux without a real key store); nothing is written', async () => {
    const box = new FakeBox();
    box.available = false;
    const store = new AnalysisKeyStore(dir, box);
    expect(store.encryptionAvailable()).toBe(false);
    expect(await codeOf(store.save(KEY))).toBe('ANALYSIS_KEY_STORAGE_UNAVAILABLE');
    expect(box.encrypts).toBe(0);
    await expect(stat(store.file)).rejects.toMatchObject({ code: 'ENOENT' });

    const linux = new FakeBox();
    linux.backend = 'basic_text';
    const linuxStore = new AnalysisKeyStore(dir, linux, undefined, 'linux');
    expect(linuxStore.encryptionAvailable()).toBe(false);
    expect(await codeOf(linuxStore.save(KEY))).toBe('ANALYSIS_KEY_STORAGE_UNAVAILABLE');
    linux.backend = 'kwallet6';
    expect(linuxStore.encryptionAvailable()).toBe(true);
    // macOS / Windows never ask for the backend.
    expect(new AnalysisKeyStore(dir, linux, undefined, 'darwin').encryptionAvailable()).toBe(true);

    const failing = new FakeBox();
    failing.failEncrypt = true;
    const log = recordingLogger();
    const error = await new AnalysisKeyStore(dir, failing, log).save(KEY).then(
      () => null,
      (e: unknown) => e as OrbitError,
    );
    expect(error?.code).toBe('ANALYSIS_KEY_STORAGE_UNAVAILABLE');
    expect(JSON.stringify(error?.toInfo())).not.toContain(KEY);
    expect(log.lines).toEqual(['warn the API key could not be encrypted {"error":"Error"}']);
    await expect(stat(join(dir, ANALYSIS_KEY_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks the format before encrypting anything', async () => {
    const box = new FakeBox();
    const store = new AnalysisKeyStore(dir, box);
    for (const bad of ['', 'hello', `sk-proj-${'a'.repeat(80)}`, `sk-ant-${'a'.repeat(20)} ${'b'.repeat(20)}`]) {
      expect(await codeOf(store.save(bad)), bad.slice(0, 12)).toBe('ANALYSIS_KEY_INVALID');
    }
    expect(box.encrypts).toBe(0);
    expect(store.hasKey()).toBe(false);
  });

  it('a key that cannot be decrypted here, or a damaged file, is reported — never the content', async () => {
    const box = new FakeBox();
    const store = new AnalysisKeyStore(dir, box);
    await store.save(KEY);
    box.failDecrypt = true;
    expect(await codeOf(store.read())).toBe('ANALYSIS_KEY_STORAGE_UNAVAILABLE');
    box.failDecrypt = false;
    box.available = false;
    expect(await codeOf(store.read())).toBe('ANALYSIS_KEY_STORAGE_UNAVAILABLE');

    await writeFile(store.file, '{ not json');
    const damaged = new AnalysisKeyStore(dir, new FakeBox(), recordingLogger());
    await damaged.load();
    expect(damaged.hasKey()).toBe(false);
    await writeFile(store.file, JSON.stringify({ format: 'orbitdrop-claude-api-key', version: 1, hint: 'WXYZ', encrypted: 'x', key: KEY }));
    await damaged.load();
    expect(damaged.hasKey()).toBe(false); // unknown fields: not ours
  });
});

describe('AnalysisService', () => {
  function service(options: { enabled?: boolean; verify?: (key: string, signal: AbortSignal) => Promise<void>; verifyTimeoutMs?: number } = {}) {
    let settings: Settings = { ...DEFAULT_SETTINGS, analysis: { enabled: options.enabled ?? true, instruction: '' } };
    const box = new FakeBox();
    const keys = new AnalysisKeyStore(dir, box);
    const onKeyChanged = vi.fn();
    const verify = vi.fn(options.verify ?? (async () => undefined));
    const log = recordingLogger();
    const analysis = new AnalysisService({ keys, settings: () => settings, verify, onKeyChanged, log, verifyTimeoutMs: options.verifyTimeoutMs ?? 2000 });
    return { analysis, box, keys, verify, onKeyChanged, log, setEnabled: (enabled: boolean) => (settings = { ...settings, analysis: { ...settings.analysis, enabled } }) };
  }

  it('is available only when enabled and a key is saved; statuses carry the hint, never the key', async () => {
    const { analysis, onKeyChanged, setEnabled, log } = service({ enabled: false });
    expect(analysis.status()).toEqual({ enabled: false, hasKey: false, keyHint: null, encryptionAvailable: true, available: false });
    const saved = await analysis.saveKey(KEY);
    expect(saved).toEqual({ enabled: false, hasKey: true, keyHint: '…WXYZ', encryptionAvailable: true, available: false });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(onKeyChanged).toHaveBeenCalledTimes(1);
    setEnabled(true);
    expect(analysis.available()).toBe(true);
    expect((await analysis.deleteKey()).available).toBe(false);
    expect(onKeyChanged).toHaveBeenCalledTimes(2);
    await analysis.deleteKey(); // nothing changed: no reconfigure
    expect(onKeyChanged).toHaveBeenCalledTimes(2);
    expect(log.lines.join('\n')).not.toContain(KEY.slice(13, 40));
  });

  it('"연결 확인": ok, a mapped failure, no key, one check at a time, and a time limit', async () => {
    const outcomes: (() => Promise<void>)[] = [async () => undefined, async () => Promise.reject(new OrbitError('ANALYSIS_AUTH_FAILED', 'The API refused the key'))];
    const { analysis, verify } = service({ verify: (_key) => (outcomes.shift() ?? (async () => undefined))() });
    expect(await analysis.testKey()).toEqual({ ok: false, error: { code: 'ANALYSIS_NOT_CONFIGURED', message: 'No API key is saved', retryable: false } });
    expect(verify).not.toHaveBeenCalled();
    await analysis.saveKey(KEY);
    const [first, second] = await Promise.all([analysis.testKey(), analysis.testKey()]);
    expect(first).toEqual({ ok: true });
    expect(second).toBe(first);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0]).toBe(KEY); // the decrypted key goes to the check, nowhere else
    const failed = await analysis.testKey();
    expect(failed).toEqual({ ok: false, error: { code: 'ANALYSIS_AUTH_FAILED', message: 'The API refused the key', retryable: false } });

    const slow = service({ verify: (_key, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new OrbitError('CANCELLED', 'Cancelled')))), verifyTimeoutMs: 20 });
    await slow.analysis.saveKey(KEY);
    expect(await slow.analysis.testKey()).toMatchObject({ ok: false, error: { code: 'ANALYSIS_UNAVAILABLE' } });
  });

  it('credentials for a job attempt: the key for tool.analyze only, and only while available', async () => {
    const { analysis, setEnabled } = service({ enabled: true });
    expect(await codeOf(analysis.credentialsFor('tool.analyze'))).toBe('ANALYSIS_NOT_CONFIGURED');
    await analysis.saveKey(KEY);
    expect(await analysis.credentialsFor('tool.analyze')).toEqual({ anthropicApiKey: KEY });
    expect(await analysis.credentialsFor('convert.jpeg')).toBeUndefined();
    setEnabled(false);
    expect(await codeOf(analysis.credentialsFor('tool.analyze'))).toBe('ANALYSIS_NOT_CONFIGURED');
  });

  it('the E2E stand-in never stores the key as typed and scripts the check', async () => {
    const backend = new ScriptedAnalysisBackend();
    const store = new AnalysisKeyStore(dir, backend);
    await store.save(KEY);
    expect(await readFile(store.file, 'utf8')).not.toContain(KEY);
    expect(await store.read()).toBe(KEY);
    backend.verifyOutcome = 'ANALYSIS_RATE_LIMITED';
    expect(await codeOf(backend.verify(KEY, new AbortController().signal))).toBe('ANALYSIS_RATE_LIMITED');
    expect(backend.verifyCalls).toBe(1);
  });
});

// ------------------------------------------------------------------ submission and jobs

const FILES: Record<string, FileFormat> = { '/in/a.pdf': 'pdf', '/in/b.jpg': 'jpeg', '/in/c.png': 'png' };

function pipeline(
  options: { available?: boolean; wired?: boolean; run?: PoolRunner; credentials?: (actionId: ActionId) => Promise<ProcessorCredentials | undefined>; settings?: Partial<Settings> } = {},
) {
  let available = options.available ?? true;
  const settings: Settings = { ...DEFAULT_SETTINGS, locale: 'en', analysis: { enabled: true, instruction: 'Check the totals.' }, ...options.settings };
  const snapshot = snapshotWith();
  const files = new FileRegistry({ validate: fakeValidator(FILES), snapshot: () => snapshot });
  const ran: { job: ProcessorJob; credentials: ProcessorCredentials | undefined }[] = [];
  const jobs = new JobManager({
    run:
      options.run ??
      (async (job, ctx) => {
        ran.push({ job, credentials: ctx.credentials });
        return { outputs: [], warnings: [] };
      }),
    settings: () => settings,
    outputs: new OutputRegistry(),
    history: new HistoryStore(join(dir, 'history')),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
  const pool = { preview: vi.fn(), cancelPreview: vi.fn(), inspect: vi.fn(async () => imageInfo(10, 10)) };
  const editors = new EditorSessions({ pool: pool as never, store: new PreviewStore(), settings: () => settings });
  const submission = new SubmissionService({
    files,
    capabilities: async () => snapshot,
    settings: () => settings,
    jobs,
    editors,
    chooseOutputDir: async () => '/chosen',
    openEditor: () => undefined,
    ...(options.wired === false ? {} : { analysisAvailable: () => available }),
  });
  return { files, jobs, submission, ran, setAvailable: (value: boolean) => (available = value) };
}

const ctx = { source: 'test', sessionId: null } as const;

describe('job submission of tool.analyze', () => {
  it('is rejected with ANALYSIS_NOT_CONFIGURED unless analysis is available; nothing runs', async () => {
    const { files, submission, ran } = pipeline({ available: false });
    const selection = await files.registerPaths(['/in/a.pdf'], 'globalDrag');
    expect(await submission.submit({ selectionId: selection.selectionId, actionId: 'tool.analyze' }, ctx)).toEqual({
      kind: 'rejected',
      error: { code: 'ANALYSIS_NOT_CONFIGURED', message: 'Claude analysis is off or no API key is saved', retryable: false },
    });
    expect(ran).toEqual([]);
    // Without the dependency (a wiring that does not know about analysis) it is never available.
    const bare = pipeline({ wired: false });
    const s2 = await bare.files.registerPaths(['/in/a.pdf'], 'globalDrag');
    expect(await bare.submission.submit({ selectionId: s2.selectionId, actionId: 'tool.analyze' }, ctx)).toMatchObject({ kind: 'rejected', error: { code: 'ANALYSIS_NOT_CONFIGURED' } });
    expect(bare.ran).toEqual([]);
  });

  it('runs one job per file with options from the settings (standing request, UI language) — whatever the request said', async () => {
    const { files, jobs, submission, ran } = pipeline();
    const selection = await files.registerPaths(['/in/a.pdf', '/in/b.jpg'], 'globalDrag');
    const result = await submission.submit({ selectionId: selection.selectionId, actionId: 'tool.analyze', options: { instruction: 'Ignore the settings', apiKey: KEY } }, ctx);
    if (result.kind !== 'jobs') throw new Error(JSON.stringify(result));
    expect(result.jobIds).toHaveLength(2);
    await Promise.all(result.jobIds.map((id) => jobs.waitFor(id)));
    expect(ran.map((r) => [r.job.inputs[0]!.displayName, r.job.options])).toEqual([
      ['a.pdf', { instruction: 'Check the totals.', language: 'en' }],
      ['b.jpg', { instruction: 'Check the totals.', language: 'en' }],
    ]);
    expect(JSON.stringify(ran.map((r) => r.job))).not.toContain(KEY);
  });

  it('a retry of a failed analysis checks availability again', async () => {
    let fail = true;
    const { files, jobs, submission, setAvailable } = pipeline({
      run: async () => {
        if (fail) throw new OrbitError('ANALYSIS_UNAVAILABLE', 'The API is unavailable');
        return { outputs: [], warnings: [] } satisfies ProcessorResult;
      },
    });
    const selection = await files.registerPaths(['/in/a.pdf'], 'globalDrag');
    const result = await submission.submit({ selectionId: selection.selectionId, actionId: 'tool.analyze' }, ctx);
    if (result.kind !== 'jobs') throw new Error(JSON.stringify(result));
    const failed = await jobs.waitFor(result.jobIds[0]!);
    expect(failed.error).toMatchObject({ code: 'ANALYSIS_UNAVAILABLE', retryable: true });
    setAvailable(false);
    expect(await submission.retryJob(failed.jobId, ctx)).toMatchObject({ kind: 'rejected', error: { code: 'ANALYSIS_NOT_CONFIGURED' } });
    setAvailable(true);
    fail = false;
    const retried = await submission.retryJob(failed.jobId, ctx);
    if (retried.kind !== 'jobs') throw new Error(JSON.stringify(retried));
    expect((await jobs.waitFor(retried.jobIds[0]!)).state).toBe('completed');
  });

  it('the job manager reads credentials for every attempt and passes them next to the job; a failing read fails the job', async () => {
    const credentials = vi.fn(async (actionId: ActionId) => (actionId === 'tool.analyze' ? { anthropicApiKey: KEY } : undefined));
    let attempts = 0;
    const seen: (ProcessorCredentials | undefined)[] = [];
    const { files, jobs, submission } = pipeline({
      credentials,
      run: async (job, runCtx) => {
        seen.push(runCtx.credentials);
        expect(JSON.stringify(job)).not.toContain(KEY);
        attempts += 1;
        if (job.actionId === 'tool.analyze' && attempts === 1) throw new OrbitError('WORKER_CRASHED', 'crashed'); // automatic retry
        return { outputs: [], warnings: [] };
      },
    });
    const selection = await files.registerPaths(['/in/a.pdf', '/in/c.png'], 'globalDrag');
    const analyzed = await submission.submit({ selectionId: selection.selectionId, actionId: 'tool.analyze', fileIds: [selection.files[0]!.fileId] }, ctx);
    if (analyzed.kind !== 'jobs') throw new Error(JSON.stringify(analyzed));
    expect((await jobs.waitFor(analyzed.jobIds[0]!)).state).toBe('completed');
    expect(seen).toEqual([{ anthropicApiKey: KEY }, { anthropicApiKey: KEY }]);
    expect(credentials).toHaveBeenCalledTimes(2);

    const converted = await submission.submit({ selectionId: selection.selectionId, actionId: 'convert.jpeg', fileIds: [selection.files[1]!.fileId] }, ctx);
    if (converted.kind !== 'jobs') throw new Error(JSON.stringify(converted));
    await jobs.waitFor(converted.jobIds[0]!);
    expect(seen.at(-1)).toBeUndefined();

    credentials.mockImplementation(async () => {
      throw new OrbitError('ANALYSIS_NOT_CONFIGURED', 'Claude analysis is off or no API key is saved');
    });
    const later = await submission.submit({ selectionId: selection.selectionId, actionId: 'tool.analyze', fileIds: [selection.files[0]!.fileId] }, ctx);
    if (later.kind !== 'jobs') throw new Error(JSON.stringify(later));
    expect((await jobs.waitFor(later.jobIds[0]!)).error?.code).toBe('ANALYSIS_NOT_CONFIGURED');
  });
});

describe('the wheels follow availability', () => {
  const snapshot = buildCapabilitySnapshot(probeWith());
  const strings = { dropHint: 'Drop', unsupported: 'No', multiFileUnsupported: 'One', fileCount: '{n}' };
  const configure = (analysis?: boolean) =>
    buildConfigureMessage({ settings: DEFAULT_SETTINGS, snapshot, theme: 'light', reduceMotion: false, highContrast: false, strings, ...(analysis === undefined ? {} : { analysis }) });

  it('unavailable: the configure message is exactly the one without analysis', () => {
    expect(configure(false)).toEqual(configure());
    expect(configure().menus.map((m) => ({ key: m.key, convert: m.convert.map((s) => s.actionId), tools: m.tools.map((s) => s.actionId) }))).toEqual(
      buildHelperMenus(snapshot, 'ko').map((m) => ({ key: m.key, convert: m.convert.map((s) => s.actionId), tools: m.tools.map((s) => s.actionId) })),
    );
    expect(JSON.stringify(configure())).not.toContain('tool.analyze');
  });

  it('available: "Claude 분석" joins the image tools and is the PDF / mixed tools wheel', () => {
    const menus = configure(true).menus;
    expect(menus.find((m) => m.key === 'image/jpeg')?.tools.at(-1)).toMatchObject({ actionId: 'tool.analyze', label: 'Claude 분석', icon: 'analyze', enabled: true, batch: true });
    expect(menus.find((m) => m.key === 'pdf')?.tools.map((s) => s.actionId)).toEqual(['tool.analyze']);
    expect(menus.find((m) => m.key === 'mixed')?.tools.map((s) => s.actionId)).toEqual(['tool.analyze']);
  });
});

describe('the key out of band', () => {
  it('the pool sends credentials in the run message next to the job, only for the job that has them', async () => {
    const fleet = fakeFleet(
      standardBehavior((message, worker) => {
        if (message.type === 'run') worker.emit({ type: 'done', jobId: message.job.jobId, result: { outputs: [], warnings: [] } });
      }),
    );
    const pool = new ProcessorPool({ fork: fleet.fork, jobWorkers: 1, cleanup: async () => undefined });
    pool.start();
    const base: ProcessorJob = {
      jobId: 'job_a',
      actionId: 'tool.analyze',
      inputs: [{ fileId: 'f1', path: '/in/a.pdf', displayName: 'a.pdf', sourceDir: '/in', format: 'pdf', bytes: 10 }],
      options: { instruction: '', language: 'ko' },
      outputDir: null,
      settings: { pdfDpi: 300, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 },
      limits: DEFAULT_PROCESSING_LIMITS,
    };
    await pool.run(base, { signal: new AbortController().signal, onProgress: () => undefined, credentials: { anthropicApiKey: KEY } });
    await pool.run({ ...base, jobId: 'job_b', actionId: 'convert.png' }, { signal: new AbortController().signal, onProgress: () => undefined });
    const runs = fleet.jobs().flatMap((worker) => worker.ofType('run'));
    expect(runs.map((m) => [m.job.jobId, m.credentials])).toEqual([
      ['job_a', { anthropicApiKey: KEY }],
      ['job_b', undefined],
    ]);
    expect(runs.every((m) => !JSON.stringify(m.job).includes(KEY))).toBe(true);
    expect('credentials' in runs[1]!).toBe(false);
    await pool.shutdown(200);
  });

  it('workers never inherit ANTHROPIC_* variables (base URL, key, log level, headers)', () => {
    const inherited = { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'https://evil.example', ANTHROPIC_API_KEY: KEY, anthropic_log: 'debug', ANTHROPIC_CUSTOM_HEADERS: 'x: y' };
    for (const packaged of [false, true]) {
      const env = workerEnv({ ORBITDROP_PARENT_PID: '1' }, packaged, inherited);
      expect(Object.keys(env).filter((name) => name.toUpperCase().startsWith('ANTHROPIC_'))).toEqual([]);
      expect(env.PATH).toBe('/usr/bin');
    }
  });

  it('log and error text redaction masks anything that looks like a key (last line of defense)', () => {
    expect(redactSecrets(`key=${KEY} end`)).toBe('key=sk-ant-<redacted> end');
    expect(redactPaths(`failed with ${KEY} at /Users/me/a.pdf`)).toBe('failed with sk-ant-<redacted> at <path>');
    expect(scrubPaths(`"${KEY}"`)).not.toContain(KEY.slice(7));
  });
});

