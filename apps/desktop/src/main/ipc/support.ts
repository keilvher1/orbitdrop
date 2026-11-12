import {
  IPC_CHANNELS,
  LicenseOpenRequestSchema,
  RendererErrorReportSchema,
  type DiagnosticsResult,
  type LicenseFile,
  type RendererErrorReport,
  type Settings,
  type WindowNotice,
} from '@orbitdrop/contracts';
import type { IpcRouter } from './router';

/**
 * First run, help, diagnostics and crash handling over IPC (same router: our
 * windows only, main frame only, payloads validated with zod). The page never
 * sends or receives a path: folders and licence files are resolved in main,
 * diagnostics go straight to the clipboard.
 */
export interface SupportIpcServices<R> {
  windowNotice(record: R): WindowNotice | null;
  rendererError(report: RendererErrorReport, record: R): void;
  copyDiagnostics(): Promise<DiagnosticsResult>;
  openLogFolder(): Promise<void>;
  openDataFolder(): Promise<void>;
  resetSettings(): Promise<Settings>;
  openLicense(which: LicenseFile): Promise<void>;
  restartHelper(): Promise<void>;
}

export function registerSupportIpc<R>(router: IpcRouter<R>, s: SupportIpcServices<R>): void {
  const C = IPC_CHANNELS;
  router.handle(C.windowNotice, null, (_p, record) => s.windowNotice(record));
  router.on(C.rendererError, RendererErrorReportSchema, (p, record) => s.rendererError(p, record));
  router.handle(C.diagnosticsCopy, null, () => s.copyDiagnostics());
  router.handle(C.logFolderOpen, null, () => s.openLogFolder());
  router.handle(C.dataFolderOpen, null, () => s.openDataFolder());
  router.handle(C.settingsReset, null, () => s.resetSettings());
  router.handle(C.licenseOpen, LicenseOpenRequestSchema, (p) => s.openLicense(p.which));
  router.handle(C.helperRestart, null, () => s.restartHelper());
}
