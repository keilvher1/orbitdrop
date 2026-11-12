import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { OrbitError, analysisKeyHint, isPlausibleAnalysisKey, normalizeAnalysisKey } from '@orbitdrop/contracts';
import { silentLogger, type Logger } from '../log';
import { SerialQueue, readJson, writeJsonAtomic } from '../util/atomic-json';

/**
 * The Anthropic API key of Claude analysis: `<userData>/claude-api-key.json`, its own file (never
 * settings.json), mode 0600, written atomically. The key is stored only as Electron safeStorage
 * ciphertext (macOS: a Keychain-held key; Windows: DPAPI); next to it the file keeps its last four
 * characters in clear, so Settings can say "저장됨 · …abcd" without decrypting anything. The key is
 * decrypted only when a job attempt or "연결 확인" needs it, and nothing here logs it, returns it to
 * a caller other than `read()`, or puts it into an error.
 */

/** Electron's safeStorage as far as the key store uses it (injected: unit and E2E tests use a fake). */
export interface SecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: 'basic_text' is no real encryption and counts as unavailable. */
  getSelectedStorageBackend?(): string;
}

export const ANALYSIS_KEY_FILE = 'claude-api-key.json';

const FORMAT = 'orbitdrop-claude-api-key';

const KeyFileSchema = z.strictObject({
  format: z.literal(FORMAT),
  version: z.literal(1),
  /** The key's last four characters (what Settings shows). */
  hint: z.string().regex(/^[A-Za-z0-9_-]{4}$/),
  /** safeStorage ciphertext of the key, base64. */
  encrypted: z.string().min(1).max(16_384),
});
type KeyFile = z.infer<typeof KeyFileSchema>;

function storageUnavailable(message: string): OrbitError {
  return new OrbitError('ANALYSIS_KEY_STORAGE_UNAVAILABLE', message);
}

/** Error name only: an encryption error never needs its message in the log. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class AnalysisKeyStore {
  readonly file: string;
  /** Hint of the saved key, null without one (load() fills it; save/remove keep it current). */
  private hintChars: string | null = null;
  private readonly writes = new SerialQueue();

  constructor(
    dir: string,
    private readonly box: SecretBox,
    private readonly log: Logger = silentLogger,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.file = join(dir, ANALYSIS_KEY_FILE);
  }

  /** Read what is saved (startup). An unusable file counts as no key and is left alone. */
  async load(): Promise<void> {
    const stored = await this.readFile();
    this.hintChars = stored?.hint ?? null;
  }

  hasKey(): boolean {
    return this.hintChars !== null;
  }

  /** '…' + the last four characters of the saved key, or null. */
  hint(): string | null {
    return this.hintChars === null ? null : `…${this.hintChars}`;
  }

  /** Whether the OS can encrypt the key here (Linux's plain-text fallback does not count). */
  encryptionAvailable(): boolean {
    try {
      if (!this.box.isEncryptionAvailable()) return false;
      if (this.platform === 'linux' && this.box.getSelectedStorageBackend?.() === 'basic_text') return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check, encrypt and store a pasted key (whitespace around it is dropped). ANALYSIS_KEY_INVALID for
   * anything that is not an Anthropic API key, ANALYSIS_KEY_STORAGE_UNAVAILABLE when the OS cannot
   * encrypt it — then nothing is written. Replaces a key saved before.
   */
  async save(raw: string): Promise<void> {
    const key = normalizeAnalysisKey(raw);
    if (!isPlausibleAnalysisKey(key)) throw new OrbitError('ANALYSIS_KEY_INVALID', 'Not an Anthropic API key');
    if (!this.encryptionAvailable()) throw storageUnavailable('The OS cannot encrypt the key on this computer');
    let encrypted: Buffer;
    try {
      encrypted = this.box.encryptString(key);
    } catch (error) {
      this.log.warn('the API key could not be encrypted', { error: errorName(error) });
      throw storageUnavailable('The key could not be encrypted');
    }
    const hint = analysisKeyHint(key).slice(1);
    const content: KeyFile = { format: FORMAT, version: 1, hint, encrypted: encrypted.toString('base64') };
    await this.writes.run(() => writeJsonAtomic(this.file, content));
    this.hintChars = hint;
  }

  /** Delete the saved key (no error when there is none). */
  async remove(): Promise<void> {
    await this.writes.run(async () => {
      try {
        await unlink(this.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
    this.hintChars = null;
  }

  /**
   * The saved key, decrypted — only for the request that needs it (a job attempt, "연결 확인").
   * ANALYSIS_NOT_CONFIGURED without a key; ANALYSIS_KEY_STORAGE_UNAVAILABLE when it cannot be
   * decrypted here (e.g. the file came from another computer or the OS key store was reset).
   */
  async read(): Promise<string> {
    const stored = await this.readFile();
    if (stored === null) {
      this.hintChars = null;
      throw new OrbitError('ANALYSIS_NOT_CONFIGURED', 'No API key is saved');
    }
    if (!this.encryptionAvailable()) throw storageUnavailable('The OS cannot decrypt the key on this computer');
    let key: string;
    try {
      key = this.box.decryptString(Buffer.from(stored.encrypted, 'base64'));
    } catch (error) {
      this.log.warn('the saved API key could not be decrypted', { error: errorName(error) });
      throw storageUnavailable('The saved key could not be decrypted');
    }
    if (!isPlausibleAnalysisKey(key)) throw storageUnavailable('The saved key could not be decrypted');
    return key;
  }

  private async readFile(): Promise<KeyFile | null> {
    let raw: Awaited<ReturnType<typeof readJson>>;
    try {
      raw = await readJson(this.file);
    } catch (error) {
      this.log.warn('the API key file could not be read', { error: errorName(error) });
      return null;
    }
    if (raw.kind === 'missing') return null;
    const parsed = raw.kind === 'ok' ? KeyFileSchema.safeParse(raw.value) : null;
    if (!parsed?.success) {
      this.log.warn('the API key file is not usable; analysis acts as if no key were saved');
      return null;
    }
    return parsed.data;
  }
}
