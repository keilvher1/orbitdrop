import {
  ACTION_OPTION_SCHEMAS,
  DEFAULT_PROCESSING_LIMITS,
  OrbitError,
  THUMBNAIL_MAX_EDGE,
  toErrorInfo,
  type ActionId,
  type EditorContext,
  type EstimateOutcome,
  type EstimateRequest,
  type ImageInfo,
  type OrbitErrorInfo,
  type PreviewOutcome,
  type PreviewRequestIpc,
  type PreviewResult,
  type ProcessorInput,
  type SelectedFile,
  type SelectionSource,
  type Settings,
  type SubmitActionResult,
  type ThumbnailRequest,
  type ThumbnailResponse,
} from '@orbitdrop/contracts';
import { processorSettings } from '../jobs/manager';
import { describeError, silentLogger, type Logger } from '../log';
import type { ProcessorPool } from '../processing/pool';
import { previewUrl, type PreviewStore } from '../preview/store';
import { publicErrorInfo } from '../util/errors';
import { newId } from '../util/ids';
import { BackgroundLimiter } from '../util/limiter';
import { ESTIMATE_KINDS, PREVIEW_KINDS, editorDefaults } from './defaults';

/**
 * Editor sessions: editorId → action, files and preview state.
 *
 * Previews are seq-ordered per editor. A request with a seq older than the
 * newest one seen is answered `{ ok:false, stale:true }` at once; a newer
 * request cancels the in-flight one in the worker (`cancelPreview`) and the
 * superseded request resolves as stale too. Results are kept in the
 * PreviewStore and returned as orbit-preview:// URLs.
 *
 * Background work — file-list thumbnails (images → PDF order editor) and the
 * per-file estimates of a batch Compress — goes through one shared limiter (at
 * most two requests on the preview worker at once, across all editors), so
 * the editors' own previews never wait behind a long list. Thumbnails are
 * cached per editor + file + size while their token is in the store (bounded
 * per editor); estimates have their own per-editor seq: a newer one aborts
 * every older estimate still waiting or running (answered stale). Closing the
 * editor aborts all of it and releases every token it owned.
 */

export interface EditorOrigin {
  readonly source: SelectionSource;
  readonly sessionId: string | null;
}

export interface EditorInit {
  readonly actionId: ActionId;
  readonly files: readonly SelectedFile[];
  readonly inputs: readonly ProcessorInput[];
  readonly origin: EditorOrigin;
}

interface Prepared {
  readonly image: ImageInfo;
  readonly source: { readonly url: string; readonly width: number; readonly height: number };
  readonly defaults: unknown;
}

interface Inflight {
  readonly previewId: string;
  readonly seq: number;
  /** Aborted when superseded: also stops a request still waiting for the preview worker to start. */
  readonly controller: AbortController;
}

/** A thumbnail or estimate waiting for the limiter or running on the preview worker. */
interface BackgroundTask {
  readonly controller: AbortController;
  /** Estimates: the estimate seq it answers (thumbnails have none). */
  readonly seq?: number;
}

interface Thumbnail {
  promise: Promise<{ readonly token: string; readonly width: number; readonly height: number }>;
  /** Set once rendered and stored. */
  token: string | null;
}

export interface EditorSession {
  readonly editorId: string;
  readonly actionId: ActionId;
  readonly files: readonly SelectedFile[];
  readonly inputs: readonly ProcessorInput[];
  readonly origin: EditorOrigin;
  readonly assets: Map<string, ProcessorInput>;
  readonly prepared: Promise<Prepared>;
  latestSeq: number;
  inflight: Inflight | null;
  previewTokens: string[];
  committed: SubmitActionResult | null;
  disposed: boolean;
  /** Thumbnails by `${fileId}:${edge}`, least recently used first. */
  readonly thumbnails: Map<string, Thumbnail>;
  /** Highest estimate seq seen (requests below it are stale). */
  estimateSeq: number;
  readonly background: Set<BackgroundTask>;
}

export interface EditorSessionsDeps {
  readonly pool: Pick<ProcessorPool, 'preview' | 'cancelPreview' | 'inspect'> & Partial<Pick<ProcessorPool, 'clearPreviewCaches'>>;
  readonly store: PreviewStore;
  readonly settings: () => Settings;
  readonly log?: Logger;
  /** Longest edge of the editor's source image. */
  readonly sourceMaxEdge?: number;
  /** Default longest edge of tool previews. */
  readonly previewMaxEdge?: number;
  /** Preview images kept per editor (older ones are released). */
  readonly keepPreviews?: number;
  /** Background requests (thumbnails, estimates) on the preview worker at once, across editors. */
  readonly backgroundConcurrency?: number;
  /** Thumbnail images kept per editor (least recently requested ones are released). */
  readonly keepThumbnails?: number;
}

const STALE_ERROR = { code: 'CANCELLED', message: 'Superseded by a newer preview', retryable: false } as const;
const STALE_ESTIMATE = { code: 'CANCELLED', message: 'Superseded by a newer estimate', retryable: false } as const;
/** Thumbnail edge when the renderer does not ask for one (device px). */
export const DEFAULT_THUMBNAIL_EDGE = 96;
/** The image of an estimate is not used: the processors skip it (estimateOnly). */
const ESTIMATE_MAX_EDGE = 64;

export class EditorSessions {
  private readonly sessions = new Map<string, EditorSession>();
  private readonly log: Logger;
  private readonly background: BackgroundLimiter;

  constructor(private readonly deps: EditorSessionsDeps) {
    this.log = deps.log ?? silentLogger;
    this.background = new BackgroundLimiter(deps.backgroundConcurrency ?? 2);
  }

  create(init: EditorInit): EditorSession {
    if (init.inputs.length === 0) throw new OrbitError('INTERNAL', 'Editor without inputs');
    const editorId = newId('ed');
    const session: EditorSession = {
      editorId,
      actionId: init.actionId,
      files: init.files,
      inputs: init.inputs,
      origin: init.origin,
      assets: new Map(),
      prepared: this.prepare(editorId, init),
      latestSeq: -1,
      inflight: null,
      previewTokens: [],
      committed: null,
      disposed: false,
      thumbnails: new Map(),
      estimateSeq: -1,
      background: new Set(),
    };
    session.prepared.catch((error: unknown) => this.log.warn('editor preparation failed', { editorId, error: describeError(error) }));
    this.sessions.set(editorId, session);
    this.log.info('editor created', { editorId, actionId: init.actionId, files: init.inputs.length });
    return session;
  }

  get(editorId: string): EditorSession | undefined {
    return this.sessions.get(editorId);
  }

  require(editorId: string): EditorSession {
    const session = this.sessions.get(editorId);
    if (!session || session.disposed) throw new OrbitError('INTERNAL', 'Unknown or closed editor');
    return session;
  }

  async context(editorId: string): Promise<EditorContext> {
    const session = this.require(editorId);
    const prepared = await session.prepared;
    return {
      editorId,
      actionId: session.actionId,
      files: session.files,
      image: prepared.image,
      source: prepared.source,
      defaults: prepared.defaults,
      settings: this.deps.settings(),
    };
  }

  async inspect(editorId: string): Promise<ImageInfo> {
    return (await this.require(editorId).prepared).image;
  }

  addAsset(editorId: string, input: ProcessorInput): void {
    this.require(editorId).assets.set(input.fileId, input);
  }

  /** Assets referenced by options (Add Background with a user image). Throws INVALID_OPTIONS for unknown files. */
  assetsFor(session: EditorSession, options: unknown): Record<string, ProcessorInput> | undefined {
    const background = (options as { background?: { kind?: unknown; fileId?: unknown } } | null)?.background;
    if (session.actionId !== 'tool.addBackground' || background?.kind !== 'image') return undefined;
    const asset = typeof background.fileId === 'string' ? session.assets.get(background.fileId) : undefined;
    if (!asset) throw new OrbitError('INVALID_OPTIONS', 'Unknown background image');
    return { [asset.fileId]: asset };
  }

  async preview(request: PreviewRequestIpc): Promise<PreviewOutcome> {
    const session = this.require(request.editorId);
    const { seq } = request;
    if (seq < session.latestSeq) return { ok: false, seq, stale: true, error: STALE_ERROR };
    session.latestSeq = seq;
    if (session.inflight) {
      const previous = session.inflight;
      session.inflight = null;
      previous.controller.abort();
      this.deps.pool.cancelPreview(previous.previewId);
    }

    const kind = PREVIEW_KINDS[session.actionId];
    if (!kind) return { ok: false, seq, error: { code: 'ENGINE_UNAVAILABLE', message: 'This action has no preview', retryable: false } };
    const schema = ACTION_OPTION_SCHEMAS[session.actionId] as { safeParse(value: unknown): { success: boolean; data?: unknown } };
    const parsed = schema.safeParse(request.options ?? {});
    if (!parsed.success) return { ok: false, seq, error: { code: 'INVALID_OPTIONS', message: 'Invalid options', retryable: false } };
    let assets: Record<string, ProcessorInput> | undefined;
    try {
      assets = this.assetsFor(session, parsed.data);
    } catch (error) {
      return { ok: false, seq, error: toErrorInfo(error) };
    }

    const inflight: Inflight = { previewId: newId('pv'), seq, controller: new AbortController() };
    session.inflight = inflight;
    const settings = this.deps.settings();
    let result: PreviewResult;
    try {
      result = await this.deps.pool.preview(
        {
          previewId: inflight.previewId,
          kind,
          input: session.inputs[0]!,
          options: parsed.data,
          maxEdge: request.maxEdge ?? this.deps.previewMaxEdge ?? 1200,
          settings: processorSettings(settings),
          limits: DEFAULT_PROCESSING_LIMITS,
          ...(assets ? { assets } : {}),
        },
        inflight.controller.signal,
      );
    } catch (error) {
      const superseded = session.inflight !== inflight;
      if (!superseded) session.inflight = null;
      if (session.disposed || superseded) return { ok: false, seq, stale: true, error: STALE_ERROR };
      return { ok: false, seq, error: publicErrorInfo(toErrorInfo(error)) };
    }
    if (session.disposed || session.inflight !== inflight) return { ok: false, seq, stale: true, error: STALE_ERROR };
    session.inflight = null;
    const token = this.deps.store.put(result.data, result.mime, session.editorId);
    this.remember(session, token);
    return {
      ok: true,
      seq,
      url: previewUrl(token),
      width: result.width,
      height: result.height,
      ...(result.outputWidth !== undefined ? { outputWidth: result.outputWidth } : {}),
      ...(result.outputHeight !== undefined ? { outputHeight: result.outputHeight } : {}),
      ...(result.estimatedBytes !== undefined ? { estimatedBytes: result.estimatedBytes } : {}),
      ...(result.layout !== undefined ? { layout: result.layout } : {}),
      ...(result.outputFormat !== undefined ? { outputFormat: result.outputFormat } : {}),
      ...(result.warnings !== undefined && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  }

  /**
   * getEditorThumbnail (OrbitApi): a small preview (≤ THUMBNAIL_MAX_EDGE) of
   * one of the session's files, rendered by the preview worker ('thumbnail')
   * through the background limiter. Cached per file + size while its token is
   * still in the store; concurrent requests share one render; a failed render
   * is not cached. The token belongs to the editor (released when it closes).
   */
  async thumbnail(request: ThumbnailRequest): Promise<ThumbnailResponse> {
    const session = this.require(request.editorId);
    const input = session.inputs.find((candidate) => candidate.fileId === request.fileId);
    if (!input) throw new OrbitError('INVALID_OPTIONS', 'Unknown file');
    const edge = Math.min(THUMBNAIL_MAX_EDGE, request.maxEdge ?? DEFAULT_THUMBNAIL_EDGE);
    const key = `${input.fileId}:${edge}`;
    let entry = session.thumbnails.get(key);
    if (entry && entry.token !== null && !this.deps.store.has(entry.token)) entry = undefined; // evicted from the store: render again
    if (entry) session.thumbnails.delete(key); // most recently used goes last
    else entry = this.renderThumbnail(session, input, edge);
    session.thumbnails.set(key, entry);
    let rendered: Awaited<Thumbnail['promise']>;
    try {
      rendered = await entry.promise;
    } catch (error) {
      if (session.thumbnails.get(key) === entry) session.thumbnails.delete(key);
      if (session.disposed) throw new OrbitError('CANCELLED', 'Editor closed');
      const info = publicErrorInfo(toErrorInfo(error));
      throw new OrbitError(info.code, info.message);
    }
    if (session.disposed) throw new OrbitError('CANCELLED', 'Editor closed');
    return { fileId: input.fileId, url: previewUrl(rendered.token), width: rendered.width, height: rendered.height };
  }

  /**
   * requestEstimate (OrbitApi): the Compress estimate of one of the session's
   * files — the size of a real full-resolution encode with these options
   * (processors `estimateOnly`, cached per file + options), run through the
   * background limiter. A request with a newer seq aborts every older estimate
   * of this editor, waiting or running; those, and requests older than the
   * newest seq, answer stale.
   */
  async estimate(request: EstimateRequest): Promise<EstimateOutcome> {
    const session = this.require(request.editorId);
    const { seq, fileId } = request;
    const failed = (error: OrbitErrorInfo): EstimateOutcome => ({ ok: false, seq, fileId, error });
    const stale: EstimateOutcome = { ok: false, seq, fileId, stale: true, error: STALE_ESTIMATE };
    const kind = ESTIMATE_KINDS[session.actionId];
    if (!kind) return failed({ code: 'ENGINE_UNAVAILABLE', message: 'This action has no estimate', retryable: false });
    if (seq < session.estimateSeq) return stale;
    if (seq > session.estimateSeq) {
      session.estimateSeq = seq;
      for (const task of [...session.background]) {
        if (task.seq !== undefined && task.seq < seq) task.controller.abort();
      }
    }
    const input = session.inputs.find((candidate) => candidate.fileId === fileId);
    if (!input) return failed({ code: 'INVALID_OPTIONS', message: 'Unknown file', retryable: false });
    const schema = ACTION_OPTION_SCHEMAS[session.actionId] as { safeParse(value: unknown): { success: boolean; data?: unknown } };
    const parsed = schema.safeParse(request.options ?? {});
    if (!parsed.success) return failed({ code: 'INVALID_OPTIONS', message: 'Invalid options', retryable: false });

    const task: BackgroundTask = { controller: new AbortController(), seq };
    const { signal } = task.controller;
    session.background.add(task);
    try {
      const result = await this.background.run(
        () =>
          this.deps.pool.preview(
            {
              previewId: newId('pv'),
              kind,
              input,
              options: parsed.data,
              maxEdge: ESTIMATE_MAX_EDGE,
              settings: processorSettings(this.deps.settings()),
              limits: DEFAULT_PROCESSING_LIMITS,
              estimateOnly: true,
            },
            signal,
          ),
        signal,
      );
      if (session.disposed || signal.aborted) return stale;
      if (result.estimatedBytes === undefined) return failed({ code: 'INTERNAL', message: 'The processor reported no estimate', retryable: false });
      return {
        ok: true,
        seq,
        fileId,
        estimatedBytes: result.estimatedBytes,
        ...(result.outputWidth !== undefined ? { outputWidth: result.outputWidth } : {}),
        ...(result.outputHeight !== undefined ? { outputHeight: result.outputHeight } : {}),
        ...(result.outputFormat !== undefined ? { outputFormat: result.outputFormat } : {}),
      };
    } catch (error) {
      if (session.disposed || signal.aborted) return stale;
      return failed(publicErrorInfo(toErrorInfo(error)));
    } finally {
      session.background.delete(task);
    }
  }

  dispose(editorId: string): void {
    const session = this.sessions.get(editorId);
    if (!session) return;
    session.disposed = true;
    if (session.inflight) {
      session.inflight.controller.abort();
      this.deps.pool.cancelPreview(session.inflight.previewId);
    }
    session.inflight = null;
    // Thumbnails and estimates still waiting for the limiter never start; running ones are cancelled in the worker.
    for (const task of session.background) task.controller.abort();
    session.background.clear();
    session.thumbnails.clear();
    this.deps.store.releaseOwner(editorId);
    this.sessions.delete(editorId);
    this.log.debug('editor disposed', { editorId });
    // The aux worker's decoded sources can be large; free them once no editor needs them.
    if (this.sessions.size === 0) this.deps.pool.clearPreviewCaches?.();
  }

  get size(): number {
    return this.sessions.size;
  }

  private renderThumbnail(session: EditorSession, input: ProcessorInput, edge: number): Thumbnail {
    const task: BackgroundTask = { controller: new AbortController() };
    const { signal } = task.controller;
    const entry: Thumbnail = { token: null, promise: Promise.resolve({ token: '', width: 0, height: 0 }) };
    session.background.add(task);
    const render = this.background.run(
      () =>
        this.deps.pool.preview(
          {
            previewId: newId('pv'),
            kind: 'thumbnail',
            input,
            options: {},
            maxEdge: edge,
            settings: processorSettings(this.deps.settings()),
            limits: DEFAULT_PROCESSING_LIMITS,
          },
          signal,
        ),
      signal,
    );
    entry.promise = render
      .then((result) => {
        if (session.disposed || signal.aborted) throw new OrbitError('CANCELLED', 'Editor closed');
        const token = this.deps.store.put(result.data, result.mime, session.editorId);
        entry.token = token;
        this.trimThumbnails(session);
        return { token, width: result.width, height: result.height };
      })
      .finally(() => session.background.delete(task));
    entry.promise.catch(() => undefined); // every requester awaits it; never an unhandled rejection
    return entry;
  }

  /** Release the least recently requested thumbnails beyond the per-editor limit. */
  private trimThumbnails(session: EditorSession): void {
    const keep = this.deps.keepThumbnails ?? 120;
    let stored = [...session.thumbnails.values()].filter((entry) => entry.token !== null).length;
    for (const [key, entry] of [...session.thumbnails]) {
      if (stored <= keep) return;
      if (entry.token === null) continue;
      this.deps.store.release(entry.token);
      session.thumbnails.delete(key);
      stored -= 1;
    }
  }

  private remember(session: EditorSession, token: string): void {
    session.previewTokens.push(token);
    const keep = this.deps.keepPreviews ?? 3;
    while (session.previewTokens.length > keep) {
      const old = session.previewTokens.shift();
      if (old) this.deps.store.release(old);
    }
  }

  private async prepare(editorId: string, init: EditorInit): Promise<Prepared> {
    const input = init.inputs[0]!;
    const settings = this.deps.settings();
    const [image, source] = await Promise.all([
      this.deps.pool.inspect(input, DEFAULT_PROCESSING_LIMITS),
      this.deps.pool.preview({
        previewId: newId('pv'),
        kind: 'source',
        input,
        options: {},
        maxEdge: this.deps.sourceMaxEdge ?? 1600,
        settings: processorSettings(settings),
        limits: DEFAULT_PROCESSING_LIMITS,
      }),
    ]);
    const token = this.deps.store.put(source.data, source.mime, editorId, true);
    if (!this.sessions.has(editorId) || this.sessions.get(editorId)?.disposed) {
      this.deps.store.release(token);
      throw new OrbitError('CANCELLED', 'Editor closed');
    }
    return {
      image,
      source: { url: previewUrl(token), width: source.width, height: source.height },
      defaults: editorDefaults(init.actionId, image, settings, init.files.map((f) => f.fileId)),
    };
  }
}
