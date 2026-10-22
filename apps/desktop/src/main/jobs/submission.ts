import {
  ACTIONS,
  ACTION_OPTION_SCHEMAS,
  OrbitError,
  RETRY_ELSEWHERE_CODES,
  canRetryJob,
  toErrorInfo,
  type ActionId,
  type CapabilitySnapshot,
  type CommitEditorRequest,
  type ErrorCode,
  type OrbitErrorInfo,
  type Point,
  type ProcessorInput,
  type Settings,
  type SubmitActionRequest,
  type SubmitActionResult,
} from '@orbitdrop/contracts';
import { buildSelectedFile, canRewriteSameFormat, resolveSubmission, supports } from '@orbitdrop/core';
import type { ValidatedInput } from '@orbitdrop/core/node';
import type { EditorSession, EditorSessions } from '../editor/sessions';
import { isUsable, toProcessorInput, type FileRegistry, type UsableFile } from '../files/registry';
import { silentLogger, type Logger } from '../log';
import { publicErrorInfo } from '../util/errors';
import { newId } from '../util/ids';
import type { JobManager, JobOrigin, JobSpec } from './manager';

/**
 * The shared pipeline after a FileSelection exists (global drag, Drop Zone,
 * open dialog, tests):
 *   core `resolveSubmission` (capability gate via `supports`, same-format
 *   files skipped with a warning — or re-encoded when only the name was wrong —
 *   needsEditor, one job per file or one merged job) → editor window, or
 *   options validation → output folder ('source' or 'ask') → JobManager.
 */

export interface SubmitContext extends JobOrigin {
  /** Window the request came from (dialog parent / editor placement). */
  readonly windowId?: number;
  /** Where an editor window should open (drop point); defaults to the sender window or the pointer. */
  readonly anchor?: Point;
}

export interface SubmissionDeps {
  readonly files: FileRegistry;
  readonly capabilities: () => Promise<CapabilitySnapshot>;
  readonly settings: () => Settings;
  readonly jobs: JobManager;
  readonly editors: EditorSessions;
  /** Ask the user for an output folder; null when cancelled. */
  readonly chooseOutputDir: (request: { readonly windowId?: number; readonly reason: 'ask' | 'retry' }) => Promise<string | null>;
  /** Show the editor window for a new editor session. */
  readonly openEditor: (session: EditorSession, context: SubmitContext) => void;
  readonly log?: Logger;
}

/** Error codes for which choosing another output folder can help (shared with the renderer through contracts). */
export { RETRY_ELSEWHERE_CODES };

export function rejected(code: ErrorCode, message: string): SubmitActionResult {
  return { kind: 'rejected', error: { code, message, retryable: false } };
}

function rejectedFrom(error: unknown): SubmitActionResult {
  const info: OrbitErrorInfo = publicErrorInfo(toErrorInfo(error));
  return { kind: 'rejected', error: info };
}

const EDITOR_CLOSED: SubmitActionResult = { kind: 'rejected', error: { code: 'CANCELLED', message: 'The editor was closed before saving', retryable: false } };

function parseOptions(actionId: ActionId, raw: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  const schema = ACTION_OPTION_SCHEMAS[actionId] as { safeParse(value: unknown): { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[] }[] } } };
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const fields = (parsed.error?.issues ?? []).map((issue) => issue.path.map(String).join('.') || '(root)').slice(0, 5);
  return { ok: false, message: `Invalid options: ${fields.join(', ')}` };
}

export class SubmissionService {
  private readonly log: Logger;
  /** One commit per editor at a time (a double click on Apply shows one dialog and writes once). */
  private readonly committing = new Map<string, Promise<SubmitActionResult>>();
  /** One "save elsewhere" per failed job at a time. */
  private readonly retrying = new Map<string, Promise<SubmitActionResult | null>>();
  /** One retryJob per failed job at a time (a double click submits once). */
  private readonly retryingJobs = new Map<string, Promise<SubmitActionResult>>();

  constructor(private readonly deps: SubmissionDeps) {
    this.log = deps.log ?? silentLogger;
  }

  async submit(request: SubmitActionRequest, context: SubmitContext): Promise<SubmitActionResult> {
    try {
      return await this.submitInner(request, context);
    } catch (error) {
      this.log.warn('submit failed', { actionId: request.actionId, code: toErrorInfo(error).code });
      return rejectedFrom(error);
    }
  }

  private async submitInner(request: SubmitActionRequest, context: SubmitContext): Promise<SubmitActionResult> {
    const record = this.deps.files.getSelectionRecord(request.selectionId);
    if (!record) return rejected('INTERNAL', 'Unknown or expired selection');

    const { actionId } = request;
    const snapshot = await this.deps.capabilities();
    // Core decides: which files run, which are skipped (already in the target format), editor or jobs.
    const plan = resolveSubmission(record.selection, actionId, snapshot, request.fileIds);
    if (plan.kind === 'rejected') return { kind: 'rejected', error: plan.error };

    const usable = new Map(record.files.filter(isUsable).map((file) => [file.fileId, file] as const));
    const pick = (ids: readonly string[]): UsableFile[] | null => {
      const files = ids.map((id) => usable.get(id));
      return files.every((file): file is UsableFile => file !== undefined) ? files : null;
    };
    const runnable = pick(plan.fileIds);
    const sameFormat = pick(plan.skipped.map((s) => s.fileId));
    if (!runnable || !sameFormat || runnable.length + sameFormat.length === 0) return rejected('INTERNAL', 'Selection changed');
    if (runnable.length === 0) {
      // Every file already has the target format: recorded as skipped ("already this format"),
      // without asking for an output folder — nothing is written.
      const batchId = sameFormat.length > 1 ? newId('b') : null;
      const jobIds = sameFormat.map((file) => this.deps.jobs.addSkipped(this.specFor(actionId, [file], {}, null, context), batchId, { code: 'SKIPPED_SAME_FORMAT' }));
      return { kind: 'jobs', jobIds };
    }

    if (plan.needsEditor) {
      const session = this.deps.editors.create({
        actionId,
        files: runnable.map((f) => f.selected),
        inputs: runnable.map(toProcessorInput),
        origin: { source: context.source, sessionId: context.sessionId },
      });
      this.deps.openEditor(session, context);
      return { kind: 'editor', editorId: session.editorId };
    }

    const options = parseOptions(actionId, request.options);
    if (!options.ok) return rejected('INVALID_OPTIONS', options.message);

    const outputDir = await this.outputDir(context);
    if (outputDir === undefined) return rejected('CANCELLED', 'No output folder chosen');

    let jobFiles: UsableFile[][] = plan.jobs.map((ids) => pick(ids) ?? []);
    const order = (options.value as { order?: readonly string[] }).order;
    if (plan.merges && order) {
      const byId = new Map(runnable.map((f) => [f.fileId, f]));
      if (order.length !== runnable.length || order.some((id) => !byId.has(id))) return rejected('INVALID_OPTIONS', 'Order must list every file once');
      jobFiles = [order.map((id) => byId.get(id)!)];
    }
    const specs: JobSpec[] = jobFiles.filter((files) => files.length > 0).map((files) => this.specFor(actionId, files, options.value, outputDir, context));
    const batchId = specs.length + sameFormat.length > 1 ? newId('b') : null;
    const jobIds = this.deps.jobs.submit(specs, batchId);
    for (const file of sameFormat) jobIds.push(this.deps.jobs.addSkipped(this.specFor(actionId, [file], options.value, outputDir, context), batchId, { code: 'SKIPPED_SAME_FORMAT' }));
    return { kind: 'jobs', jobIds };
  }

  async commitEditor(request: CommitEditorRequest, context: SubmitContext): Promise<SubmitActionResult> {
    const inFlight = this.committing.get(request.editorId);
    if (inFlight) return inFlight;
    const work = this.commitEditorInner(request, context).finally(() => this.committing.delete(request.editorId));
    this.committing.set(request.editorId, work);
    return work;
  }

  /**
   * Closing or cancelling the editor while the commit is still validating or
   * asking for a folder cancels it: `disposed` is re-checked after every await
   * and nothing is submitted ("nothing has been written"). Closing it after the
   * jobs were submitted leaves them running.
   */
  private async commitEditorInner(request: CommitEditorRequest, context: SubmitContext): Promise<SubmitActionResult> {
    const session = this.deps.editors.get(request.editorId);
    if (!session) return rejected('INTERNAL', 'Unknown editor');
    if (session.committed) return session.committed; // double click on Apply: one result only
    if (session.disposed) return EDITOR_CLOSED;
    try {
      const action = ACTIONS[session.actionId];
      const options = parseOptions(session.actionId, request.options);
      if (!options.ok) return rejected('INVALID_OPTIONS', options.message);
      const check = await this.validateEditorOptions(session, options.value);
      if (session.disposed) return EDITOR_CLOSED;
      if (check) return check;
      const assets = this.deps.editors.assetsFor(session, options.value);
      const outputDir = await this.outputDir(context);
      if (session.disposed) return EDITOR_CLOSED;
      if (outputDir === undefined) return rejected('CANCELLED', 'No output folder chosen');
      if (session.committed) return session.committed;

      let inputs = session.inputs;
      const order = (options.value as { order?: readonly string[] }).order;
      if (action.merges && order) {
        const byId = new Map(inputs.map((input) => [input.fileId, input]));
        if (order.length !== inputs.length || order.some((id) => !byId.has(id))) return rejected('INVALID_OPTIONS', 'Order must list every file once');
        inputs = order.map((id) => byId.get(id)!);
      }
      const origin: SubmitContext = { ...context, source: session.origin.source, sessionId: session.origin.sessionId };
      const specs: JobSpec[] = action.merges
        ? [this.specFromInputs(session.actionId, inputs, options.value, outputDir, origin, assets)]
        : inputs.map((input) => this.specFromInputs(session.actionId, [input], options.value, outputDir, origin, assets));
      const jobIds = this.deps.jobs.submit(specs, specs.length > 1 ? newId('b') : null);
      session.committed = { kind: 'jobs', jobIds };
      return session.committed;
    } catch (error) {
      return rejectedFrom(error);
    }
  }

  /** OUTPUT_DIR_NOT_WRITABLE (and similar): ask for another folder and run the job again there. */
  retryElsewhere(jobId: string, context: SubmitContext): Promise<SubmitActionResult | null> {
    const inFlight = this.retrying.get(jobId);
    if (inFlight) return inFlight;
    const work = this.retryElsewhereInner(jobId, context).finally(() => this.retrying.delete(jobId));
    this.retrying.set(jobId, work);
    return work;
  }

  private async retryElsewhereInner(jobId: string, context: SubmitContext): Promise<SubmitActionResult | null> {
    const job = this.deps.jobs.get(jobId);
    if (!job) return rejected('FILE_NOT_FOUND', 'The job is no longer available');
    const { snapshot } = job;
    if (snapshot.state !== 'failed' || !snapshot.error || !RETRY_ELSEWHERE_CODES.has(snapshot.error.code)) {
      return rejected('INVALID_OPTIONS', 'This job cannot be retried in another folder');
    }
    const dir = await this.deps.chooseOutputDir({ ...(context.windowId !== undefined ? { windowId: context.windowId } : {}), reason: 'retry' });
    if (dir === null) return null;
    const spec: JobSpec = { ...job.spec, outputDir: dir };
    return { kind: 'jobs', jobIds: this.deps.jobs.submit([spec], null) };
  }

  /**
   * retryJob (OrbitApi): run a cancelled job, or one that failed with one of
   * RETRY_JOB_CODES (timeout, crashed worker, write/disk/network trouble, cloud
   * placeholder) — contracts `canRetryJob` — again with the same action,
   * options, output folder and origin. Its inputs and assets are validated
   * again first — a file may be gone, replaced by an unreadable one, or still a
   * placeholder. Concurrent calls share one attempt and a job is retried once:
   * later calls return the first retry's jobs. Jobs listed from history after a
   * restart cannot be retried (their options are not kept): FILE_NOT_FOUND,
   * like retryElsewhere.
   */
  retryJob(jobId: string, context: SubmitContext): Promise<SubmitActionResult> {
    const inFlight = this.retryingJobs.get(jobId);
    if (inFlight) return inFlight;
    const work = this.retryJobInner(jobId, context).finally(() => this.retryingJobs.delete(jobId));
    this.retryingJobs.set(jobId, work);
    return work;
  }

  private async retryJobInner(jobId: string, _context: SubmitContext): Promise<SubmitActionResult> {
    const job = this.deps.jobs.get(jobId);
    if (!job) return rejected('FILE_NOT_FOUND', 'The job is no longer available');
    const earlier = this.deps.jobs.retriedAs(jobId);
    if (earlier) return { kind: 'jobs', jobIds: [...earlier] };
    const { snapshot, spec } = job;
    if (!canRetryJob(snapshot)) return rejected('INVALID_OPTIONS', 'This job cannot be retried');
    try {
      const capabilities = await this.deps.capabilities();
      const inputs = await this.revalidateInputs(spec.inputs, capabilities, (input) => {
        if (!supports(capabilities, spec.actionId, { kind: input.kind, format: input.format }) && !canRewriteSameFormat(capabilities, spec.actionId, input)) {
          throw new OrbitError('UNSUPPORTED_FORMAT', `${spec.actionId} does not accept ${input.format} input`);
        }
      });
      const assetList = Object.values(spec.assets ?? {});
      const assets = await this.revalidateInputs(assetList, capabilities, (input) => {
        if (input.kind !== 'image') throw new OrbitError('UNSUPPORTED_FORMAT', 'Background must be an image');
      });
      const retry: JobSpec = {
        ...spec,
        inputs,
        ...(assets.length > 0 ? { assets: Object.fromEntries(assets.map((input) => [input.fileId, input])) } : {}),
      };
      const jobIds = this.deps.jobs.submit([retry], null);
      this.deps.jobs.markRetried(jobId, jobIds);
      this.log.info('job retried', { jobId, retryJobId: jobIds[0], actionId: spec.actionId, code: snapshot.error?.code ?? snapshot.state });
      return { kind: 'jobs', jobIds };
    } catch (error) {
      const result = rejectedFrom(error);
      this.log.warn('job retry refused', { jobId, code: result.kind === 'rejected' ? result.error.code : undefined });
      return result;
    }
  }

  /**
   * Fresh ProcessorInputs for a retry: path, format and size from a new
   * validation; fileId (images → PDF orders by it), display name and source
   * folder (where outputs go) stay those of the original job.
   */
  private async revalidateInputs(
    inputs: readonly ProcessorInput[],
    capabilities: CapabilitySnapshot,
    check: (input: ValidatedInput) => void,
  ): Promise<ProcessorInput[]> {
    if (inputs.length === 0) return [];
    const fresh = await this.deps.files.revalidate(inputs.map((input) => input.path));
    return inputs.map((input, index) => {
      const validated = fresh[index]!;
      const problem = buildSelectedFile({ fileId: input.fileId, input: validated }, capabilities).problem;
      if (problem) throw new OrbitError(problem.code, problem.message);
      check(validated);
      return { fileId: input.fileId, path: validated.realPath, displayName: input.displayName, sourceDir: input.sourceDir, format: validated.format, bytes: validated.bytes };
    });
  }

  private async validateEditorOptions(session: EditorSession, options: unknown): Promise<SubmitActionResult | null> {
    if (session.actionId === 'tool.crop') {
      const image = await session.prepared;
      const rect = (options as { rect: { x: number; y: number; width: number; height: number } }).rect;
      if (rect.x + rect.width > image.image.orientedWidth || rect.y + rect.height > image.image.orientedHeight) {
        return rejected('INVALID_OPTIONS', 'Crop area is outside the image');
      }
    }
    return null;
  }

  /** undefined = cancelled by the user; null = next to the source files. */
  private async outputDir(context: SubmitContext): Promise<string | null | undefined> {
    if (this.deps.settings().output.location !== 'ask') return null;
    const dir = await this.deps.chooseOutputDir({ ...(context.windowId !== undefined ? { windowId: context.windowId } : {}), reason: 'ask' });
    return dir ?? undefined;
  }

  private specFor(actionId: ActionId, files: readonly UsableFile[], options: unknown, outputDir: string | null, context: JobOrigin): JobSpec {
    return this.specFromInputs(actionId, files.map(toProcessorInput), options, outputDir, context, undefined);
  }

  private specFromInputs(
    actionId: ActionId,
    inputs: readonly ProcessorInput[],
    options: unknown,
    outputDir: string | null,
    context: JobOrigin,
    assets: Record<string, ProcessorInput> | undefined,
  ): JobSpec {
    return {
      actionId,
      inputs,
      options,
      outputDir,
      origin: { source: context.source, sessionId: context.sessionId },
      ...(assets ? { assets } : {}),
    };
  }
}
