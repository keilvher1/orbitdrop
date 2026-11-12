import {
  OrbitError,
  toErrorInfo,
  type ActionId,
  type AnalysisKeyTestResult,
  type AnalysisStatus,
  type ProcessorCredentials,
  type Settings,
} from '@orbitdrop/contracts';
import { silentLogger, type Logger } from '../log';
import { publicErrorInfo } from '../util/errors';
import type { AnalysisKeyStore } from './key-store';

/**
 * Claude analysis in main: whether it is available (settings.analysis.enabled and a saved key —
 * what the wheels and job submission ask), the Settings actions on the key (save, delete, "연결
 * 확인") and the credentials of a job attempt. The renderer only ever gets an AnalysisStatus; the
 * decrypted key leaves this service only towards the API: as `credentials` for the worker's `run`
 * message, or into `verify` (main's own "연결 확인" request).
 */
export interface AnalysisServiceDeps {
  readonly keys: AnalysisKeyStore;
  readonly settings: () => Settings;
  /** "연결 확인": resolves when the API accepts the key, throws the mapped OrbitError otherwise. */
  readonly verify: (apiKey: string, signal: AbortSignal) => Promise<void>;
  /** A key was saved or deleted: availability may have changed (the app re-configures the helper). */
  readonly onKeyChanged?: () => void;
  readonly log?: Logger;
  /** Longest "연결 확인" (its requests have their own, shorter timeouts and retries). */
  readonly verifyTimeoutMs?: number;
}

export class AnalysisService {
  private readonly log: Logger;
  /** One "연결 확인" at a time: a second click gets the first one's answer. */
  private testing: Promise<AnalysisKeyTestResult> | null = null;

  constructor(private readonly deps: AnalysisServiceDeps) {
    this.log = deps.log ?? silentLogger;
  }

  /** Enabled in Settings and a key saved: the wheels offer "Claude 분석" and jobs may run. */
  available(): boolean {
    return this.deps.settings().analysis.enabled && this.deps.keys.hasKey();
  }

  status(): AnalysisStatus {
    const enabled = this.deps.settings().analysis.enabled;
    const hasKey = this.deps.keys.hasKey();
    return { enabled, hasKey, keyHint: this.deps.keys.hint(), encryptionAvailable: this.deps.keys.encryptionAvailable(), available: enabled && hasKey };
  }

  async saveKey(raw: string): Promise<AnalysisStatus> {
    const had = this.deps.keys.hasKey();
    await this.deps.keys.save(raw);
    this.log.info(had ? 'Claude API key replaced' : 'Claude API key saved');
    this.changed();
    return this.status();
  }

  async deleteKey(): Promise<AnalysisStatus> {
    const had = this.deps.keys.hasKey();
    await this.deps.keys.remove();
    if (had) {
      this.log.info('Claude API key deleted');
      this.changed();
    }
    return this.status();
  }

  /** "연결 확인": the saved key against the API (a free models request). Never throws. */
  testKey(): Promise<AnalysisKeyTestResult> {
    this.testing ??= this.runTest().finally(() => {
      this.testing = null;
    });
    return this.testing;
  }

  /**
   * Credentials of one job attempt (JobManager reads them for every attempt): the key for
   * tool.analyze, nothing for any other action. ANALYSIS_NOT_CONFIGURED when analysis was turned
   * off or the key deleted after the job was submitted.
   */
  async credentialsFor(actionId: ActionId): Promise<ProcessorCredentials | undefined> {
    if (actionId !== 'tool.analyze') return undefined;
    if (!this.available()) throw new OrbitError('ANALYSIS_NOT_CONFIGURED', 'Claude analysis is off or no API key is saved');
    return { anthropicApiKey: await this.deps.keys.read() };
  }

  private async runTest(): Promise<AnalysisKeyTestResult> {
    if (!this.deps.keys.hasKey()) return { ok: false, error: { code: 'ANALYSIS_NOT_CONFIGURED', message: 'No API key is saved', retryable: false } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.verifyTimeoutMs ?? 60_000);
    timer.unref?.();
    try {
      const key = await this.deps.keys.read();
      await this.deps.verify(key, controller.signal);
      this.log.info('Claude API key checked', { ok: true });
      return { ok: true };
    } catch (error) {
      // Our own time limit is a connection that never answered, not a cancel by the user.
      const info = controller.signal.aborted ? new OrbitError('ANALYSIS_UNAVAILABLE', 'The API did not answer in time').toInfo() : publicErrorInfo(toErrorInfo(error));
      this.log.info('Claude API key check failed', { code: info.code });
      return { ok: false, error: info };
    } finally {
      clearTimeout(timer);
    }
  }

  private changed(): void {
    try {
      this.deps.onKeyChanged?.();
    } catch (error) {
      this.log.warn('analysis availability listener failed', { error: error instanceof Error ? error.name : 'error' });
    }
  }
}
