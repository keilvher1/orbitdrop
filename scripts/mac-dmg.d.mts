// Types for scripts/mac-dmg.mjs (used by the TypeScript tests in tests/integration).
import type { Runner } from './release-lib.mjs';

export const IDENTITY_PREFIX: string;

export interface NotaryCredentials {
  readonly kind: string;
  readonly args: readonly string[];
  readonly display: readonly string[];
}
export interface SigningIdentity {
  readonly hash: string;
  readonly name: string;
  readonly team: string | null;
}
export interface DmgNotarizationReport {
  file: string;
  ok: boolean;
  identity: string;
  team: string | null;
  timestamp: boolean;
  notarization: { id: string | null; status: string | null; issues?: string | null } | null;
  stapled: boolean;
  spctl: string | null;
  staplerValidate: string | null;
  failedAt: 'sign' | 'notarize' | 'staple' | 'verify' | null;
  error?: string;
}

export function notaryCredentials(env: Record<string, string | undefined>): NotaryCredentials | null;
export function findSigningIdentity(options: { name: string | undefined; run: Runner }): SigningIdentity;
export function signAndNotarizeDmg(options: { dmg: string; identity: SigningIdentity; credentials: NotaryCredentials; run: Runner; log?: (message: string) => void }): DmgNotarizationReport;
