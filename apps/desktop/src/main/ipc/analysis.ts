import { AnalysisKeyRequestSchema, IPC_CHANNELS, type AnalysisKeyTestResult, type AnalysisStatus } from '@orbitdrop/contracts';
import { NO_PAYLOAD } from './channels';
import type { IpcRouter } from './router';

/**
 * Claude analysis over IPC (same router: our windows only, main frame only, payloads validated with
 * zod). The key goes one way only — renderer → main, in saveKey — and every reply is an
 * AnalysisStatus (whether a key is saved and its last four characters) or a test result. The router
 * logs a rejected payload by channel name only, never its content.
 */
export interface AnalysisIpcServices {
  status(): AnalysisStatus;
  saveKey(key: string): Promise<AnalysisStatus>;
  deleteKey(): Promise<AnalysisStatus>;
  testKey(): Promise<AnalysisKeyTestResult>;
}

export function registerAnalysisIpc<R>(router: IpcRouter<R>, s: AnalysisIpcServices): void {
  const C = IPC_CHANNELS;
  router.handle(C.analysisStatus, NO_PAYLOAD, () => s.status());
  router.handle(C.analysisSaveKey, AnalysisKeyRequestSchema, (p) => s.saveKey(p.key));
  router.handle(C.analysisDeleteKey, NO_PAYLOAD, () => s.deleteKey());
  router.handle(C.analysisTestKey, NO_PAYLOAD, () => s.testKey());
}
