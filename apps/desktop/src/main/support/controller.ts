import { dirname } from 'node:path';
import { OrbitError, type CapabilitySnapshot, type DiagnosticsResult, type HelperStatus, type LicenseFile, type Locale } from '@orbitdrop/contracts';
import type { Translate } from '../i18n';
import { silentLogger, type Logger } from '../log';
import { isRendererExternalUrl } from '../security';
import { DIAGNOSTICS_LOG_LINES, buildDiagnostics, readLogTail, redactLogLines } from './diagnostics';
import { issueUrl, osName, websiteUrl } from './help';
import { licenseCandidates } from './legal';

/**
 * Help, diagnostics, data folder and licence actions (tray › 도움말, About,
 * Settings › General). Electron is injected (shell, clipboard), so the logic
 * is unit-tested; app.ts wires it. No network use: web pages open in the
 * user's browser, and only pages on the allowlist.
 */
export interface SupportShell {
  openExternal(url: string): Promise<void>;
  /** Resolves with '' on success, an error message otherwise (Electron's shell.openPath). */
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

export interface SupportDeps {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The x64 build under Rosetta 2. */
  readonly translated: boolean;
  readonly appVersion: string;
  readonly packaged: boolean;
  readonly versions: { readonly electron: string; readonly chrome: string; readonly node: string };
  /** process.getSystemVersion(), e.g. "14.8.7" or "10.0.26100". */
  readonly osVersion: () => string;
  /** The user's home folder (replaced by ~ in shared log lines), or null. */
  readonly homeDir: string | null;
  readonly paths: {
    readonly userData: string;
    /** <userData>/logs/main.log */
    readonly logFile: string;
    readonly resourcesPath: string;
    readonly appPath: string;
  };
  readonly locale: () => Locale;
  readonly t: Translate;
  readonly helperStatus: () => HelperStatus;
  readonly capabilities: () => CapabilitySnapshot | null;
  readonly shell: SupportShell;
  readonly writeClipboard: (text: string) => void;
  readonly exists: (path: string) => boolean;
  readonly ensureDir: (path: string) => void;
  readonly log?: Logger;
}

export class SupportController {
  private readonly log: Logger;

  constructor(private readonly deps: SupportDeps) {
    this.log = deps.log ?? silentLogger;
  }

  get logsDir(): string {
    return dirname(this.deps.paths.logFile);
  }

  /** "macOS 14.8.7" */
  osDescription(): string {
    let version = '';
    try {
      version = this.deps.osVersion();
    } catch {
      // unknown
    }
    return `${osName(this.deps.platform)} ${version}`.trim();
  }

  websiteUrl(): string {
    return websiteUrl(this.deps.locale());
  }

  /** The new-issue form, prefilled with the app version, OS version and architecture only. */
  issueUrl(): string {
    const arch = `${this.deps.arch}${this.deps.translated ? ' (Rosetta 2)' : ''}`;
    return issueUrl({ appVersion: this.deps.appVersion, os: this.osDescription(), arch }, this.deps.t);
  }

  openWebsite(): Promise<void> {
    return this.openWeb(this.websiteUrl(), 'website');
  }

  reportProblem(): Promise<void> {
    return this.openWeb(this.issueUrl(), 'issue');
  }

  async openLogFolder(): Promise<void> {
    await this.openFolder(this.logsDir, 'logs');
  }

  async openDataFolder(): Promise<void> {
    await this.openFolder(this.deps.paths.userData, 'data');
  }

  /** The diagnostics text (see diagnostics.ts) and how many log lines it has. */
  async diagnostics(): Promise<{ readonly text: string; readonly logLines: number }> {
    const raw = await readLogTail(this.deps.paths.logFile, DIAGNOSTICS_LOG_LINES);
    const logLines = redactLogLines(raw, this.deps.homeDir);
    const text = buildDiagnostics({
      appVersion: this.deps.appVersion,
      packaged: this.deps.packaged,
      versions: this.deps.versions,
      os: this.osDescription(),
      arch: this.deps.arch,
      translated: this.deps.translated,
      locale: this.deps.locale(),
      helper: this.deps.helperStatus(),
      capabilities: this.deps.capabilities(),
      logLines,
      t: this.deps.t,
    });
    return { text, logLines: logLines.length };
  }

  /** About › 진단 정보 복사: written to the clipboard by main; the page only learns the line count. */
  async copyDiagnostics(): Promise<DiagnosticsResult> {
    const { text, logLines } = await this.diagnostics();
    this.deps.writeClipboard(text);
    this.log.info('diagnostics copied to the clipboard', { logLines, chars: text.length });
    return { logLines };
  }

  /** About › 오픈 소스 라이선스: the shipped file in the OS default app (or shown in its folder when no app opens it). */
  async openLicense(which: LicenseFile): Promise<void> {
    const candidates = licenseCandidates(which, { packaged: this.deps.packaged, resourcesPath: this.deps.paths.resourcesPath, appPath: this.deps.paths.appPath });
    const path = candidates.find((candidate) => this.deps.exists(candidate));
    if (path === undefined) {
      this.log.warn('licence file not found', { which });
      throw new OrbitError('FILE_NOT_FOUND', 'The licence file is missing');
    }
    const error = await this.deps.shell.openPath(path);
    if (error) {
      this.log.warn('no app opened the licence file; showing it in its folder', { which });
      this.deps.shell.showItemInFolder(path);
    }
  }

  private async openWeb(url: string, what: string): Promise<void> {
    if (!isRendererExternalUrl(url)) {
      this.log.warn('help page refused by the allowlist', { what });
      return;
    }
    await this.deps.shell.openExternal(url);
  }

  private async openFolder(dir: string, what: string): Promise<void> {
    try {
      this.deps.ensureDir(dir);
    } catch {
      // opening reports what is wrong
    }
    const error = await this.deps.shell.openPath(dir);
    if (error) {
      this.log.warn('could not open a folder', { what });
      throw new OrbitError('INTERNAL', 'The folder could not be opened');
    }
  }
}
