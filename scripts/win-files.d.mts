// Types for scripts/win-files.mjs (used by the TypeScript tests in tests/integration).
import type { spawnSync } from 'node:child_process';

export interface PeLayout {
  readonly checksumOffset: number;
  readonly securityEntryOffset: number | null;
  readonly certificateTable: { readonly offset: number; readonly size: number } | null;
}
export interface WindowsFileFacts {
  readonly path: string;
  readonly productName: string | null;
  readonly productVersion: string | null;
  readonly fileVersion?: string | null;
  readonly companyName?: string | null;
  /** Get-AuthenticodeSignature's Status: Valid, NotSigned, HashMismatch, UnknownError, … */
  readonly signature: string;
  readonly signer?: string | null;
  readonly timestamped?: boolean;
}

export function peLayout(buf: Buffer): PeLayout;
export function signatureAddedOnly(unsigned: Buffer, signed: Buffer): { ok: true } | { ok: false; reason: string };
export function readWindowsFileFacts(paths: readonly string[], options?: { run?: typeof spawnSync }): WindowsFileFacts[];
export function versionInfoProblems(facts: readonly WindowsFileFacts[], expected: { productName: string; version: string }): string[];
export function signatureProblems(facts: readonly WindowsFileFacts[], options: { expected: 'signed' | 'unsigned'; signer?: RegExp | null }): string[];
