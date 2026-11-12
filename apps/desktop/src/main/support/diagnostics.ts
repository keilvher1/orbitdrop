import { open } from 'node:fs/promises';
import { FILE_FORMATS, type CapabilitySnapshot, type HelperStatus } from '@orbitdrop/contracts';
import type { Translate } from '../i18n';
import { redactPaths } from '../log';

/**
 * About › 진단 정보 복사: a plain-text report for problem reports — version,
 * build, OS, architecture, drag-helper state, a capability summary and the
 * last lines of main.log. main.log is path-redacted when written; every line
 * goes through the redaction again here (plus the home folder and control
 * characters), and the log part is size-capped. No file contents, no paths.
 */

export const DIAGNOSTICS_LOG_LINES = 200;
/** Upper bound of the log part (characters), whatever the line count. */
export const DIAGNOSTICS_LOG_MAX_CHARS = 64 * 1024;
/** Bytes read from the end of a log file. */
const TAIL_READ_BYTES = 256 * 1024;
const MAX_LINE_CHARS = 1000;

/** The last `max` lines of a text file, reading at most its last `maxBytes`. A missing file has none. */
export async function readTailLines(file: string, max: number, maxBytes = TAIL_READ_BYTES): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'r');
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    if (length <= 0) return [];
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (length < size) lines.shift(); // the first line was cut by the read window
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    return lines.slice(-max);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The last `max` lines of main.log, continuing into the rotated main.log.1 when main.log is short. */
export async function readLogTail(logFile: string, max = DIAGNOSTICS_LOG_LINES): Promise<string[]> {
  const current = await readTailLines(logFile, max);
  if (current.length >= max) return current;
  const previous = await readTailLines(`${logFile}.1`, max - current.length);
  return [...previous, ...current];
}

/** One log line made safe to share: control characters out, the home folder and anything path-like replaced. */
export function redactLogLine(line: string, home: string | null): string {
  let text = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  if (home !== null && home.length > 2) text = text.split(home).join('~');
  text = redactPaths(text);
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}

/** Redacted lines, newest kept when the total would pass `maxChars`. */
export function redactLogLines(lines: readonly string[], home: string | null, maxChars = DIAGNOSTICS_LOG_MAX_CHARS): string[] {
  const out: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = redactLogLine(lines[i]!, home);
    total += line.length + 1;
    if (total > maxChars) break;
    out.push(line);
  }
  return out.reverse();
}

export interface DiagnosticsInput {
  readonly appVersion: string;
  readonly packaged: boolean;
  readonly versions: { readonly electron: string; readonly chrome: string; readonly node: string };
  /** e.g. "macOS 14.8.7". */
  readonly os: string;
  readonly arch: string;
  readonly translated: boolean;
  readonly locale: string;
  readonly helper: HelperStatus;
  readonly capabilities: CapabilitySnapshot | null;
  /** Already redacted (redactLogLines). */
  readonly logLines: readonly string[];
  readonly t: Translate;
}

/** The helper state as technical tokens (developer reasons are redacted and shortened). */
export function helperSummary(status: HelperStatus): string {
  const reason = (text: string): string => redactPaths(text).replace(/\s+/g, ' ').slice(0, 160);
  switch (status.state) {
    case 'running':
      return `running ${status.helperVersion} · globalDrag=${status.globalDrag ? 'yes' : 'no'}${status.reason ? ` · ${reason(status.reason)}` : ''}`;
    case 'needsPermission':
      return `needsPermission (${status.permissions.join(', ')})`;
    case 'unavailable':
      return `unavailable · ${reason(status.reason)}`;
    case 'crashed':
      return `crashed after ${status.restarts} restarts · ${reason(status.reason)}`;
    default:
      return status.state;
  }
}

/** Formats the engines read and write, PDF support, enabled actions and engine versions. */
export function capabilitySummary(snapshot: CapabilitySnapshot | null, t: Translate): string {
  if (snapshot === null) return t('diag.report.enginesPending');
  const { probe, actions } = snapshot;
  const decode = FILE_FORMATS.filter((format) => probe.formats[format]?.input);
  const encode = FILE_FORMATS.filter((format) => probe.formats[format]?.output);
  const all = Object.values(actions);
  const enabled = all.filter((action) => action.enabled).length;
  const versions = Object.entries(probe.versions)
    .map(([name, version]) => `${name} ${version}`)
    .join(', ');
  return [
    `decode ${decode.join(' ') || '—'}`,
    `encode ${encode.join(' ') || '—'}`,
    `pdfRender=${probe.pdfRender ? 'yes' : 'no'}`,
    `pdfText=${probe.pdfText ? 'yes' : 'no'}`,
    `actions ${enabled}/${all.length}`,
    `probeNotes ${probe.errors.length}`,
    ...(versions ? [versions] : []),
  ].join(' · ');
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  const { t } = input;
  const build = `${input.packaged ? t('diag.report.packaged') : t('diag.report.dev')} · Electron ${input.versions.electron} · Chromium ${input.versions.chrome} · Node ${input.versions.node}`;
  const lines = [
    t('diag.report.title'),
    `${t('diag.report.version')}: ${input.appVersion}`,
    `${t('diag.report.build')}: ${build}`,
    `${t('diag.report.os')}: ${input.os}`,
    `${t('diag.report.arch')}: ${input.arch}${input.translated ? ' (Rosetta 2)' : ''}`,
    `${t('diag.report.locale')}: ${input.locale}`,
    `${t('diag.report.helper')}: ${helperSummary(input.helper)}`,
    `${t('diag.report.engines')}: ${capabilitySummary(input.capabilities, t)}`,
    '',
    input.logLines.length > 0 ? t('diag.report.log', { n: input.logLines.length }) : t('diag.report.noLog'),
    ...input.logLines,
  ];
  return `${lines.join('\n')}\n`;
}
