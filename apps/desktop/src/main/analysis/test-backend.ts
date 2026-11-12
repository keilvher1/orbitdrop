import { OrbitError, type ErrorCode } from '@orbitdrop/contracts';
import type { SecretBox } from './key-store';

/**
 * Automation only (ORBITDROP_E2E=1, unpackaged builds; see app.ts): stands in for the OS key store
 * and the Anthropic API, so Playwright runs and electron-verify never touch the Keychain / DPAPI and
 * never send anything to the network. Test hooks script it (test-hooks.ts `scriptAnalysis`).
 *
 * "Encryption" reverses the text behind a marker: enough for the tests to check that the key file
 * never holds the key as typed.
 */
export class ScriptedAnalysisBackend implements SecretBox {
  /** What isEncryptionAvailable() answers. */
  encryption = true;
  /** Outcome of "연결 확인": 'ok' or the error code the check fails with. */
  verifyOutcome: 'ok' | ErrorCode = 'ok';
  /** How often "연결 확인" reached the (scripted) API. */
  verifyCalls = 0;

  isEncryptionAvailable(): boolean {
    return this.encryption;
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`e2e:${[...plainText].reverse().join('')}`, 'utf8');
  }

  decryptString(encrypted: Buffer): string {
    const text = encrypted.toString('utf8');
    if (!text.startsWith('e2e:')) throw new Error('Not encrypted by this backend');
    return [...text.slice(4)].reverse().join('');
  }

  async verify(_apiKey: string, signal: AbortSignal): Promise<void> {
    this.verifyCalls += 1;
    if (signal.aborted) throw new OrbitError('CANCELLED', 'Cancelled');
    if (this.verifyOutcome !== 'ok') throw new OrbitError(this.verifyOutcome, 'Scripted for an E2E test');
  }
}
