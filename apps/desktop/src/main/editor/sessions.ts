import {
  ACTION_OPTION_SCHEMAS,
  DEFAULT_PROCESSING_LIMITS,
  OrbitError,
  toErrorInfo,
  type ActionId,
  type EditorContext,
  type ImageInfo,
  type PreviewOutcome,
  type PreviewRequestIpc,
  type PreviewResult,
  type ProcessorInput,
  type SelectedFile,
  type SelectionSource,
  type Settings,
  type SubmitActionResult,
} from '@orbitdrop/contracts';
import { processorSettings } from '../jobs/manager';
import { describeError, silentLogger, type Logger } from '../log';
import type { ProcessorPool } from '../processing/pool';
import { previewUrl, type PreviewStore } from '../preview/store';
import { publicErrorInfo } from '../util/errors';
import { newId } from '../util/ids';
import { PREVIEW_KINDS, editorDefaults } from './defaults';

/**
 * Editor sessions: editorId → action, files and preview state.
 *
 * Previews are seq-ordered per editor. A request with a seq older than the
 * newest one seen is answered `{ ok:false, stale:true }` at once; a newer
 * request cancels the in-flight one in the worker (`cancelPreview`) and the
 * superseded request resolves as stale too. Results are kept in the
 * PreviewStore and returned as orbit-preview:// URLs.
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
}

export interface EditorSessionsDeps {
  readonly pool: Pick<ProcessorPool, 'preview' | 'cancelPreview' | 'inspect'>;
  readonly store: PreviewStore;
  readonly settings: () => Settings;
  readonly log?: Logger;
  /** Longest edge of the editor's source image. */
  readonly sourceMaxEdge?: number;
  /** Default longest edge of tool previews. */
  readonly previewMaxEdge?: number;
  /** Preview images kept per editor (older ones are released). */
  readonly keepPreviews?: number;
}

const STALE_ERROR = { code: 'CANCELLED', message: 'Superseded by a newer preview', retryable: false } as const;

export class EditorSessions {
  private readonly sessions = new Map<string, EditorSession>();
  private readonly log: Logger;

  constructor(private readonly deps: EditorSessionsDeps) {
    this.log = deps.log ?? silentLogger;
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
    };
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
    this.deps.store.releaseOwner(editorId);
    this.sessions.delete(editorId);
    this.log.debug('editor disposed', { editorId });
  }

  get size(): number {
    return this.sessions.size;
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
