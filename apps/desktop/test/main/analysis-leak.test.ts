import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type FileFormat, type JobSnapshot, type MainToProcessorMessage } from '@orbitdrop/contracts';
import { buildCapabilitySnapshot } from '@orbitdrop/core';
import { AnalysisKeyStore, type SecretBox } from '../../src/main/analysis/key-store';
import { AnalysisService } from '../../src/main/analysis/service';
import { EditorSessions } from '../../src/main/editor/sessions';
import { OutputRegistry } from '../../src/main/files/outputs';
import { FileRegistry } from '../../src/main/files/registry';
import { HistoryStore } from '../../src/main/history/store';
import { bindTranslate } from '../../src/main/i18n';
import { JobManager, type JobRecordView } from '../../src/main/jobs/manager';
import { SubmissionService } from '../../src/main/jobs/submission';
import { closeLogSink, configureLogSink, createLogger, type LogData, type Logger } from '../../src/main/log';
import { Notifier, type NotificationRequest } from '../../src/main/notifications';
import { ProcessorPool } from '../../src/main/processing/pool';
import { PreviewStore } from '../../src/main/preview/store';
import { SettingsStore } from '../../src/main/settings/store';
import { SupportController } from '../../src/main/support/controller';
import { RendererErrorLog } from '../../src/main/support/crash';
import { fakeFleet, standardBehavior } from './fake-worker';
import { fakeValidator, imageInfo, probeWith } from './helpers';

/**
 * "The key never leaks": the whole main-process path of Claude analysis — Settings saving the key,
 * submission, the job manager, the processor pool with a worker that crashes once (automatic retry),
 * failures, history, notifications, the diagnostics export and every IPC reply — with a fake key,
 * checking every place jobs, run messages or options are logged, persisted or exported. Loggers are
 * wrapped to record what each component *tries* to log, before any redaction, so the redaction in
 * log.ts (a last line of defense) cannot hide a leak.
 */

const KEY = `sk-ant-api03-${'Zq9'.repeat(29)}LEAK`;
/** A distinctive piece of the key: also caught when only part of it would leak. */
const PIECE = 'Zq9Zq9Zq9Zq9';

/** Reversible stand-in for safeStorage (hex behind a marker: the key never appears as typed). */
const box: SecretBox = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`box:${Buffer.from(plain).toString('hex')}`),
  decryptString: (encrypted) => Buffer.from(encrypted.toString().slice(4), 'hex').toString(),
};

const attempted: string[] = [];
/** createLogger(scope), plus a record of every raw message and value it is given. */
function logger(scope: string): Logger {
  const real = createLogger(scope);
  const wrap =
    (level: keyof Logger) =>
    (message: string, data?: LogData): void => {
      attempted.push(`${scope} ${level} ${message} ${JSON.stringify(data ?? {})}`);
      real[level](message, data);
    };
  return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
}

const FILES: Record<string, FileFormat> = { '/in/report.pdf': 'pdf', '/in/photo.jpg': 'jpeg', '/in/scan.png': 'png' };

let root: string;
let logFile: string;
const runMessages: MainToProcessorMessage[] = [];
const notifications: NotificationRequest[] = [];
const settled: JobRecordView[] = [];
const replies: unknown[] = [];
let snapshots: JobSnapshot[] = [];
let diagnostics = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orbitdrop-leak-'));
  logFile = join(root, 'logs', 'main.log');
  configureLogSink({ file: logFile, stderr: false, debug: true });

  const settings = new SettingsStore(join(root, 'data'), logger('settings'), 'darwin');
  await settings.load();
  await settings.update({ analysis: { enabled: true, instruction: 'Check the totals.' } });
  const history = new HistoryStore(join(root, 'data'), logger('history'));
  await history.load();
  const keys = new AnalysisKeyStore(join(root, 'data'), box, logger('analysis'));
  await keys.load();
  const analysis = new AnalysisService({ keys, settings: () => settings.get(), verify: async () => undefined, log: logger('analysis') });

  // IPC replies of Settings › Claude 분석.
  replies.push(analysis.status());
  replies.push(await analysis.saveKey(`  ${KEY}  `));
  replies.push(await analysis.testKey());
  replies.push(analysis.status());

  // Workers: the first attempt of report.pdf crashes (the queue retries it with the key read again), photo.jpg
  // fails with an error text that (wrongly) quotes the key, scan.png succeeds.
  let crashed = false;
  const fleet = fakeFleet(
    standardBehavior((message, worker) => {
      if (message.type !== 'run') return;
      runMessages.push(message);
      const name = message.job.inputs[0]!.displayName;
      if (name === 'report.pdf' && !crashed) {
        crashed = true;
        worker.exit(1);
        return;
      }
      if (name === 'photo.jpg') {
        worker.emit({ type: 'failed', jobId: message.job.jobId, error: { code: 'ANALYSIS_FAILED', message: `request failed for ${KEY}`, detail: `auth ${KEY}`, retryable: false } });
        return;
      }
      worker.emit({ type: 'done', jobId: message.job.jobId, result: { outputs: [{ path: join(root, 'out', `${name} Analysis.md`), format: 'md', bytes: 120 }], warnings: [{ code: 'ANALYSIS_TRUNCATED' }] } });
    }),
  );
  const pool = new ProcessorPool({ fork: fleet.fork, jobWorkers: 1, restartBaseMs: 1, restartMaxMs: 2, cleanup: async () => undefined, log: logger('pool') });
  pool.start();

  const snapshot = buildCapabilitySnapshot(probeWith());
  const files = new FileRegistry({ validate: fakeValidator(FILES), snapshot: () => snapshot });
  const notifier = new Notifier({
    show: (request) => notifications.push(request),
    enabled: () => true,
    locale: () => 'en',
    t: bindTranslate(() => 'en'),
    jobs: { batch: (batchId) => jobs.batch(batchId) },
    revealOutput: () => undefined,
    openJobs: () => undefined,
    log: logger('notify'),
  });
  const jobs: JobManager = new JobManager({
    run: (job, ctx) => pool.run(job, ctx),
    settings: () => settings.get(),
    credentials: (actionId) => analysis.credentialsFor(actionId),
    outputs: new OutputRegistry(),
    history,
    onSettled: (view) => {
      settled.push(view);
      notifier.onJobSettled(view);
    },
    log: logger('jobs'),
    broadcastDelayMs: 1,
  });
  const editors = new EditorSessions({ pool: { preview: async () => Promise.reject(new Error('unused')), cancelPreview: () => undefined, inspect: async () => imageInfo(1, 1) } as never, store: new PreviewStore(), settings: () => settings.get() });
  const submission = new SubmissionService({
    files,
    capabilities: async () => snapshot,
    settings: () => settings.get(),
    jobs,
    editors,
    chooseOutputDir: async () => null,
    openEditor: () => undefined,
    analysisAvailable: () => analysis.available(),
    log: logger('submit'),
  });

  const selection = await files.registerPaths(Object.keys(FILES), 'globalDrag');
  const result = await submission.submit({ selectionId: selection.selectionId, actionId: 'tool.analyze', options: { note: KEY } }, { source: 'globalDrag', sessionId: 'drag-1' });
  replies.push(result);
  if (result.kind !== 'jobs') throw new Error(`submission failed: ${JSON.stringify(result)}`);
  await Promise.all(result.jobIds.map((id) => jobs.waitFor(id)));
  jobs.flushBroadcast();
  snapshots = jobs.list();
  replies.push(snapshots);
  replies.push(await analysis.deleteKey());

  await pool.shutdown(200);
  await Promise.all([settings.flush(), history.flush()]);
  // A crash report from a view that (wrongly) carried the key in its error text: written redacted.
  new RendererErrorLog(logger('renderer')).report(
    { kind: 'settings', windowId: 3 },
    { source: 'boundary', name: 'TypeError', message: `cannot read ${KEY}`, stack: `TypeError: ${KEY}\n    at AnalysisPanel (index.js:1:2)` },
  );
  attempted.splice(attempted.findIndex((line) => line.startsWith('renderer ')), 1); // that raw input is the simulated bug itself
  const support = new SupportController({
    platform: 'darwin',
    arch: 'arm64',
    translated: false,
    appVersion: '1.0.0',
    packaged: true,
    versions: { electron: '44.9.0', chrome: '152', node: '24.7.0' },
    osVersion: () => '26.0',
    homeDir: null,
    paths: { userData: join(root, 'data'), logFile, resourcesPath: root, appPath: root },
    locale: () => 'en',
    t: bindTranslate(() => 'en'),
    helperStatus: () => ({ state: 'disabled' }),
    capabilities: () => snapshot,
    shell: { openExternal: async () => undefined, openPath: async () => '', showItemInFolder: () => undefined },
    writeClipboard: () => undefined,
    exists: () => false,
    ensureDir: () => undefined,
  });
  diagnostics = (await support.diagnostics()).text;
  closeLogSink();
});

afterAll(async () => {
  closeLogSink();
  await rm(root, { recursive: true, force: true });
});

const leaks = (text: string): boolean => text.includes(KEY) || text.includes(PIECE);

describe('a fake API key never leaves the key store except towards the worker', () => {
  it('the scenario really ran: three jobs, one crash retried, one failure, two reports', () => {
    expect(snapshots.map((job) => [job.inputName, job.state])).toEqual(
      expect.arrayContaining([
        ['report.pdf', 'completed'],
        ['photo.jpg', 'failed'],
        ['scan.png', 'completed'],
      ]),
    );
    expect(runMessages.filter((m) => m.type === 'run' && m.job.inputs[0]!.displayName === 'report.pdf')).toHaveLength(2);
    expect(notifications.length).toBeGreaterThan(0);
  });

  it('the only place it travels: next to the job in every run message (the crash retry included), never inside the job', () => {
    expect(runMessages).toHaveLength(4);
    for (const message of runMessages) {
      if (message.type !== 'run') throw new Error('not a run message');
      expect(message.credentials).toEqual({ anthropicApiKey: KEY });
      expect(leaks(JSON.stringify(message.job))).toBe(false);
      expect(message.job.options).toEqual({ instruction: 'Check the totals.', language: 'ko' });
    }
  });

  it('no component even tries to log it, and main.log does not contain it', async () => {
    expect(attempted.length).toBeGreaterThan(10);
    expect(attempted.filter(leaks)).toEqual([]);
    const log = await readFile(logFile, 'utf8');
    expect(log).toContain('Claude API key saved');
    // The crash report that carried it (a simulated renderer bug) was written with the key masked.
    expect(log).toMatch(/renderer view crashed .*cannot read sk-ant-<redacted>/);
    expect(leaks(log)).toBe(false);
  });

  it('not in settings.json, history.json or anywhere in the data folder except encrypted in its own file', async () => {
    const data = join(root, 'data');
    const names = await readdir(data);
    expect(names.sort()).toEqual(['history.json', 'settings.json']); // the key file was deleted at the end
    for (const name of names) expect(leaks(await readFile(join(data, name), 'utf8')), name).toBe(false);
    const settings = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')) as { analysis: unknown };
    expect(settings.analysis).toEqual({ enabled: true, instruction: 'Check the totals.' });
  });

  it('not in job snapshots, job records (specs and options), errors, history or notifications', () => {
    expect(leaks(JSON.stringify(snapshots))).toBe(false);
    expect(leaks(JSON.stringify(settled.map((view) => ({ spec: view.spec, snapshot: view.snapshot }))))).toBe(false);
    const failed = snapshots.find((job) => job.inputName === 'photo.jpg');
    expect(failed?.error).toMatchObject({ code: 'ANALYSIS_FAILED', message: 'request failed for sk-ant-<redacted>' });
    expect(leaks(JSON.stringify(notifications))).toBe(false);
  });

  it('not in any IPC reply (statuses carry only the last four characters)', () => {
    expect(replies.length).toBe(7);
    expect(leaks(JSON.stringify(replies))).toBe(false);
    expect(replies[1]).toMatchObject({ hasKey: true, keyHint: '…LEAK' });
  });

  it('not in the diagnostics export (support report with the log tail)', () => {
    expect(diagnostics).toContain('Claude API key saved');
    expect(leaks(diagnostics)).toBe(false);
  });

  it('the defaults are untouched: analysis is still off for a fresh settings file', () => {
    expect(DEFAULT_SETTINGS.analysis.enabled).toBe(false);
  });
});
