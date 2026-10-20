import {
  ACTIONS,
  IMAGE_FORMATS,
  OrbitError,
  isActionId,
  menuKeyFor,
  needsEditor as actionNeedsEditor,
  type ActionId,
  type CapabilitySnapshot,
  type ErrorCode,
  type FileFormat,
  type FileSelection,
  type ImageFormat,
  type InputKind,
  type MenuKey,
  type OrbitErrorInfo,
  type SelectedFile,
  type SelectionSource,
} from '@orbitdrop/contracts';
import { isReadableFormat, supports } from './capabilities';

/**
 * Pure selection logic shared by main (FileSelection, submitAction) and, for
 * `menuKeyForPaths`, by the native helpers (golden vectors: selection section).
 * Browser-safe: no Node built-ins.
 */

// ------------------------------------------------------------------ path classification

const SEPARATORS = /[\\/]/;

/**
 * Last component of a path. Both '/' and '\' separate components on every
 * platform; trailing separators are ignored ("C:\\photos\\" → "photos").
 */
export function fileNameOfPath(path: string): string {
  let end = path.length;
  while (end > 0 && SEPARATORS.test(path[end - 1]!)) end -= 1;
  const trimmed = path.slice(0, end);
  let start = trimmed.length;
  while (start > 0 && !SEPARATORS.test(trimmed[start - 1]!)) start -= 1;
  return trimmed.slice(start);
}

/** ASCII-only lower-casing (A–Z → a–z); every other character is kept as is. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Extension of a file name or path, lower-cased (ASCII only), including the dot.
 * '' when the name has no dot, only a leading dot (".png" is a hidden file
 * without extension) or ends with a dot ("photo.").
 */
export function extensionOfPath(path: string): string {
  const name = fileNameOfPath(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return asciiLower(name.slice(dot));
}

/** Format named by a single-file menu key ('pdf' | 'image/<fmt>'); undefined for anything else. */
export function formatOfSingleFileKey(key: string): FileFormat | undefined {
  if (key === 'pdf') return 'pdf';
  if (key.startsWith('image/')) {
    const format = key.slice('image/'.length);
    if ((IMAGE_FORMATS as readonly string[]).includes(format)) return format as ImageFormat;
  }
  return undefined;
}

/**
 * Menu key for dragged paths, using the helper's extension map (the
 * `extensions` field of the helper `configure` message). Mirrors contracts
 * `menuKeyFor`: every path must map to 'pdf' or 'image/<fmt>', otherwise the
 * selection is unsupported (null) — the wheel never offers an action that would
 * silently skip files.
 *  - empty list, an empty path or a path ending in '/' or '\' (a folder) → null
 *  - extension = extensionOfPath(path); looked up as an own key of the map
 *  - map values other than 'pdf' / 'image/<fmt>' count as unknown
 */
export function menuKeyForPaths(paths: readonly string[], extensionMap: Readonly<Record<string, string>>): MenuKey | null {
  if (paths.length === 0) return null;
  const formats: (FileFormat | undefined)[] = [];
  for (const path of paths) {
    if (path.length === 0 || SEPARATORS.test(path[path.length - 1]!)) return null;
    const ext = extensionOfPath(path);
    const key = ext !== '' && Object.hasOwn(extensionMap, ext) ? extensionMap[ext] : undefined;
    const format = key === undefined ? undefined : formatOfSingleFileKey(key);
    if (format === undefined) return null;
    formats.push(format);
  }
  return menuKeyFor(formats);
}

// ------------------------------------------------------------------ FileSelection

/** What main knows about a validated file (structurally satisfied by core/node ValidatedInput). */
export interface ValidatedFileInfo {
  readonly displayName: string;
  readonly format: FileFormat;
  readonly kind: InputKind;
  readonly bytes: number;
  readonly extensionMismatch: boolean;
}

export interface SelectionProblem {
  readonly code: ErrorCode;
  /** Developer-facing English text (the renderer localizes by code). */
  readonly message: string;
}

export type SelectionCandidate =
  | { readonly fileId: string; readonly input: ValidatedFileInfo }
  | { readonly fileId: string; readonly path: string; readonly error: SelectionProblem; readonly bytes?: number };

export interface BuildSelectionOptions {
  /** When given, files this build cannot read get an UNSUPPORTED_FORMAT problem. */
  readonly snapshot?: CapabilitySnapshot;
  /** Files beyond this many get a TOO_MANY_FILES problem (default 500, the IPC limit). */
  readonly maxFiles?: number;
}

export const DEFAULT_MAX_SELECTION_FILES = 500;

function problemOf(code: ErrorCode, message: string): SelectionProblem {
  return { code, message };
}

/** Renderer-facing entry for one candidate (no paths leave main: only the file name). */
export function buildSelectedFile(candidate: SelectionCandidate, snapshot?: CapabilitySnapshot): SelectedFile {
  if ('input' in candidate) {
    const { input } = candidate;
    const unreadable = snapshot !== undefined && !isReadableFormat(snapshot.probe, input.format);
    return {
      fileId: candidate.fileId,
      name: input.displayName,
      ext: extensionOfPath(input.displayName),
      format: input.format,
      kind: input.kind,
      bytes: input.bytes,
      ...(input.extensionMismatch ? { extensionMismatch: true } : {}),
      ...(unreadable ? { problem: problemOf('UNSUPPORTED_FORMAT', `This build cannot read ${input.format} files`) } : {}),
    };
  }
  return {
    fileId: candidate.fileId,
    name: fileNameOfPath(candidate.path),
    ext: extensionOfPath(candidate.path),
    format: null,
    kind: null,
    bytes: candidate.bytes ?? 0,
    problem: problemOf(candidate.error.code, candidate.error.message),
  };
}

/** Files that can be offered actions: no problem and a known input format. */
export function usableFiles(files: readonly SelectedFile[]): SelectedFile[] {
  return files.filter((f) => f.problem === undefined && f.format !== null && f.kind !== null);
}

/** Menu key for the usable files of a selection; null when none is usable. */
export function selectionMenuKey(files: readonly SelectedFile[]): MenuKey | null {
  const usable = usableFiles(files);
  return usable.length === 0 ? null : menuKeyFor(usable.map((f) => f.format ?? undefined));
}

/**
 * Build a FileSelection from candidates in drop / dialog order. The order is
 * kept exactly (it is the default processing order and the page order when
 * images are merged into a PDF); rejected paths stay in place with a problem;
 * a repeated fileId is listed once (first occurrence).
 */
export function buildFileSelection(
  selectionId: string,
  source: SelectionSource,
  candidates: readonly SelectionCandidate[],
  options: BuildSelectionOptions = {},
): FileSelection {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_SELECTION_FILES;
  const seen = new Set<string>();
  const files: SelectedFile[] = [];
  let usable = 0;
  for (const candidate of candidates) {
    if (seen.has(candidate.fileId)) continue;
    seen.add(candidate.fileId);
    const file = buildSelectedFile(candidate, options.snapshot);
    if (file.problem !== undefined) {
      files.push(file);
    } else if (usable >= maxFiles) {
      files.push({ ...file, problem: problemOf('TOO_MANY_FILES', `Only ${maxFiles} files can be processed at once`) });
    } else {
      usable += 1;
      files.push(file);
    }
  }
  return { selectionId, source, files, menuKey: selectionMenuKey(files) };
}

// ------------------------------------------------------------------ submitAction

export interface SubmissionPlan {
  readonly kind: 'plan';
  readonly actionId: ActionId;
  /** Files that will be processed, in processing order. */
  readonly fileIds: readonly string[];
  /** Requested files left out because they already have the target format (job warning SKIPPED_SAME_FORMAT). */
  readonly skipped: readonly { readonly fileId: string; readonly warning: 'SKIPPED_SAME_FORMAT' }[];
  /** Open an editor before running (tools always; images → PDF with several images). */
  readonly needsEditor: boolean;
  /** All files go into one output (images → one PDF). */
  readonly merges: boolean;
  /** One entry per job with the fileIds it processes (merging actions: one job with every file). */
  readonly jobs: readonly (readonly string[])[];
}

export interface SubmissionRejection {
  readonly kind: 'rejected';
  readonly error: OrbitErrorInfo;
}

export type SubmissionResolution = SubmissionPlan | SubmissionRejection;

export interface ResolveSubmissionOptions {
  /** Upper bound of files in one submission (default 500). */
  readonly maxFiles?: number;
}

function reject(code: ErrorCode, message: string, detail?: string): SubmissionRejection {
  return { kind: 'rejected', error: new OrbitError(code, message, detail === undefined ? undefined : { detail }).toInfo() };
}

/**
 * Decide what submitAction does for a selection, so main stays thin:
 *  1. unknown action → INVALID_OPTIONS
 *  2. files = `fileIds` (deduplicated, in the given order) or every usable file
 *     in selection order; an unknown id → INVALID_OPTIONS; a requested file
 *     with a problem → that problem's code; nothing to run → the first file
 *     problem, else INVALID_OPTIONS (empty selection)
 *  3. more than maxFiles → TOO_MANY_FILES
 *  4. action disabled in this build → ENGINE_UNAVAILABLE
 *  5. convert.<fmt> on a file already in <fmt> → skipped (warning), never an error;
 *     any other unsupported file → UNSUPPORTED_FORMAT for the whole request
 *     (nothing is silently dropped); everything skipped → UNSUPPORTED_FORMAT
 *  6. several files for a non-batch action → TOO_MANY_FILES
 *  7. needsEditor per contracts `needsEditor(action, fileCount)`; jobs: one per
 *     file, or a single job for merging actions.
 */
export function resolveSubmission(
  selection: FileSelection,
  actionId: string,
  snapshot: CapabilitySnapshot,
  fileIds?: readonly string[],
  options: ResolveSubmissionOptions = {},
): SubmissionResolution {
  if (!isActionId(actionId)) return reject('INVALID_OPTIONS', 'Unknown action');
  const action = ACTIONS[actionId];
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_SELECTION_FILES;

  let requested: SelectedFile[];
  if (fileIds !== undefined) {
    const byId = new Map(selection.files.map((f) => [f.fileId, f] as const));
    const seen = new Set<string>();
    requested = [];
    for (const id of fileIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const file = byId.get(id);
      if (file === undefined) return reject('INVALID_OPTIONS', 'Unknown file id');
      if (file.problem !== undefined) return reject(file.problem.code, file.problem.message);
      if (file.format === null || file.kind === null) return reject('UNSUPPORTED_FORMAT', 'Unsupported or unknown file type');
      requested.push(file);
    }
  } else {
    requested = usableFiles(selection.files);
  }

  if (requested.length === 0) {
    const firstProblem = selection.files.find((f) => f.problem !== undefined)?.problem;
    if (firstProblem !== undefined) return reject(firstProblem.code, firstProblem.message);
    return reject('INVALID_OPTIONS', 'No files to process');
  }
  if (requested.length > maxFiles) return reject('TOO_MANY_FILES', 'Too many files', `${requested.length} > ${maxFiles}`);

  const cap = snapshot.actions[actionId];
  if (!cap?.enabled) return reject('ENGINE_UNAVAILABLE', cap?.reason?.en ?? 'Action unavailable in this build');

  const run: string[] = [];
  const skipped: { fileId: string; warning: 'SKIPPED_SAME_FORMAT' }[] = [];
  for (const file of requested) {
    const format = file.format!;
    const kind = file.kind!;
    if (actionId === `convert.${format}`) {
      skipped.push({ fileId: file.fileId, warning: 'SKIPPED_SAME_FORMAT' });
      continue;
    }
    if (!supports(snapshot, actionId, { kind, format })) {
      return reject('UNSUPPORTED_FORMAT', `${action.id} does not accept ${format} input`, format);
    }
    run.push(file.fileId);
  }
  if (run.length === 0) return reject('UNSUPPORTED_FORMAT', 'Every file already has the target format');
  if (!action.batch && run.length > 1) return reject('TOO_MANY_FILES', `${action.id} works on one file at a time`);

  return {
    kind: 'plan',
    actionId,
    fileIds: run,
    skipped,
    needsEditor: actionNeedsEditor(action, run.length),
    merges: action.merges,
    jobs: action.merges ? [run] : run.map((id) => [id]),
  };
}
