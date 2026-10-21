import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as napiCanvas from '@napi-rs/canvas';
import type * as PdfJs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { OrbitError } from '@orbitdrop/contracts';

/**
 * PDF.js (legacy build, for Node/Electron) + @napi-rs/canvas, configured so it
 * behaves the same in plain Node, `ELECTRON_RUN_AS_NODE` and an Electron
 * `utilityProcess`.
 *
 * Why everything is passed explicitly: PDF.js decides "am I in Node?" with
 * `!(process.versions.electron && process.type && process.type !== 'browser')`,
 * which is FALSE in a utilityProcess (`process.type === 'utility'`). It would
 * then pick DOM factories (document.createElement, fetch, FontFace, Web
 * Workers) and fail. So we:
 *  - install DOMMatrix/Path2D/ImageData from @napi-rs/canvas,
 *  - load the worker module in-process and expose it as `globalThis.pdfjsWorker`
 *    (PDF.js then runs its parser on this thread — we are already in a worker
 *    process, so no extra thread is needed),
 *  - pass our own CanvasFactory, FilterFactory and BinaryDataFactory, and turn
 *    off FontFace/OffscreenCanvas/ImageDecoder/eval/system fonts,
 *  - read CMaps, standard fonts and wasm decoders from the installed
 *    pdfjs-dist package (never from the network).
 * pdfjs-dist is ESM-only: its two modules are loaded with a computed
 * `import(fileURL)` (resolved through createRequire), which bundlers that emit
 * CJS (electron-vite main) leave untouched. CJS dependencies (@napi-rs/canvas)
 * are imported statically so a CJS bundle turns them into plain `require()`.
 */

export type PdfJsModule = typeof PdfJs;
export type PdfDocument = PdfJs.PDFDocumentProxy;
export type PdfPage = PdfJs.PDFPageProxy;
type NapiCanvasModule = typeof napiCanvas;
type NapiCanvas = import('@napi-rs/canvas').Canvas;
type NapiContext = import('@napi-rs/canvas').SKRSContext2D;

/** Optional override of the pdfjs-dist folder (e.g. a packaged app's unpacked copy). */
export const PDFJS_DIR_ENV = 'ORBITDROP_PDFJS_DIR';

export interface PdfjsAssets {
  readonly packageDir: string;
  readonly mainModule: string;
  readonly workerModule: string;
  /** file: URLs with a trailing slash, as PDF.js expects. */
  readonly cMapUrl: string;
  readonly standardFontDataUrl: string;
  readonly wasmUrl: string;
  readonly iccUrl: string;
}

export interface PdfEngine {
  readonly pdfjs: PdfJsModule;
  readonly canvas: NapiCanvasModule;
  readonly assets: PdfjsAssets;
  readonly version: string;
}

/** Inside a packaged app prefer `app.asar.unpacked/…` when packaging unpacked pdfjs-dist. */
function preferUnpacked(path: string): string {
  const marker = `${sep}app.asar${sep}`;
  if (!path.includes(marker)) return path;
  const unpacked = path.replace(marker, `${sep}app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : path;
}

function dirUrl(path: string): string {
  const href = pathToFileURL(path).href;
  return href.endsWith('/') ? href : `${href}/`;
}

export function resolvePdfjsAssets(): PdfjsAssets {
  const override = process.env[PDFJS_DIR_ENV]?.trim();
  const packageDir = preferUnpacked(override || dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')));
  return {
    packageDir,
    mainModule: join(packageDir, 'legacy', 'build', 'pdf.mjs'),
    workerModule: join(packageDir, 'legacy', 'build', 'pdf.worker.mjs'),
    cMapUrl: dirUrl(join(packageDir, 'cmaps')),
    standardFontDataUrl: dirUrl(join(packageDir, 'standard_fonts')),
    wasmUrl: dirUrl(join(packageDir, 'wasm')),
    iccUrl: dirUrl(join(packageDir, 'iccs')),
  };
}

function installCanvasGlobals(canvas: NapiCanvasModule): void {
  const g = globalThis as Record<string, unknown>;
  g.DOMMatrix ??= canvas.DOMMatrix;
  g.Path2D ??= canvas.Path2D;
  g.ImageData ??= canvas.ImageData;
  const nav = g.navigator as { language?: string } | undefined;
  if (!nav?.language) {
    try {
      g.navigator = { language: 'en-US', platform: '', userAgent: '' };
    } catch {
      // read-only navigator without language: PDF.js copes
    }
  }
}

let enginePromise: Promise<PdfEngine> | null = null;

async function loadEngine(): Promise<PdfEngine> {
  const canvas = napiCanvas;
  installCanvasGlobals(canvas);
  const assets = resolvePdfjsAssets();
  const g = globalThis as Record<string, unknown>;
  if (!(g.pdfjsWorker as { WorkerMessageHandler?: unknown } | undefined)?.WorkerMessageHandler) {
    g.pdfjsWorker = await import(/* @vite-ignore */ pathToFileURL(assets.workerModule).href);
  }
  const pdfjs = (await import(/* @vite-ignore */ pathToFileURL(assets.mainModule).href)) as PdfJsModule;
  pdfjs.GlobalWorkerOptions.workerSrc ||= pathToFileURL(assets.workerModule).href;
  return { pdfjs, canvas, assets, version: pdfjs.version };
}

/** Load (once per process) and return the configured PDF engine. */
export function loadPdfEngine(): Promise<PdfEngine> {
  if (!enginePromise) {
    enginePromise = loadEngine().catch((error: unknown) => {
      enginePromise = null;
      throw new OrbitError('ENGINE_UNAVAILABLE', 'PDF engine could not be loaded', {
        detail: error instanceof Error ? error.message.slice(0, 300) : String(error),
        cause: error,
      });
    });
  }
  return enginePromise;
}

// ---------------------------------------------------------------- factories

interface CanvasAndContext {
  canvas: NapiCanvas | null;
  context: NapiContext | null;
}

function makeCanvasFactory(canvas: NapiCanvasModule) {
  return class NapiCanvasFactory {
    create(width: number, height: number): CanvasAndContext {
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      const c = canvas.createCanvas(width, height);
      return { canvas: c, context: c.getContext('2d') };
    }

    reset(target: CanvasAndContext, width: number, height: number): void {
      if (!target.canvas) throw new Error('Canvas is not specified');
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      target.canvas.width = width;
      target.canvas.height = height;
    }

    destroy(target: CanvasAndContext): void {
      if (!target.canvas) throw new Error('Canvas is not specified');
      target.canvas.width = 0;
      target.canvas.height = 0;
      target.canvas = null;
      target.context = null;
    }
  };
}

/** SVG filters are a DOM feature; like PDF.js' own Node factory, render without them. */
class NoopFilterFactory {
  addFilter(): string {
    return 'none';
  }
  addHCMFilter(): string {
    return 'none';
  }
  addAlphaFilter(): string {
    return 'none';
  }
  addLuminosityFilter(): string {
    return 'none';
  }
  addKnockoutFilter(): string {
    return 'none';
  }
  addHighlightHCMFilter(): string {
    return 'none';
  }
  addSelectionHCMFilter(): string {
    return 'none';
  }
  addSelectionFilter(): string {
    return 'none';
  }
  createSelectionStyle(): null {
    return null;
  }
  destroy(): void {}
}

type BinaryKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl';

/** Reads CMaps, standard fonts and wasm decoders from the local pdfjs-dist package. */
class LocalBinaryDataFactory {
  readonly #bases: Record<BinaryKind, string | null>;

  constructor(options: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {
    this.#bases = {
      cMapUrl: options.cMapUrl ?? null,
      standardFontDataUrl: options.standardFontDataUrl ?? null,
      wasmUrl: options.wasmUrl ?? null,
    };
  }

  async fetch({ kind, filename }: { kind: BinaryKind; filename: string }): Promise<Uint8Array> {
    const base = this.#bases[kind];
    if (!base) throw new Error(`No base URL for ${kind}`);
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) throw new Error('Invalid resource name');
    const data = await readFile(fileURLToPath(`${base}${filename}`));
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
}

// ---------------------------------------------------------------- documents

export interface OpenedPdf {
  readonly doc: PdfDocument;
  readonly numPages: number;
  /** Releases the document, its pages and the in-process worker port. */
  destroy(): Promise<void>;
}

function errorName(error: unknown): string {
  return (error as { name?: unknown } | null)?.name === undefined ? '' : String((error as { name: unknown }).name);
}

/** Map PDF.js load errors (never including document content) to OrbitErrors. */
export function mapPdfError(error: unknown): OrbitError {
  if (error instanceof OrbitError) return error;
  const name = errorName(error);
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'PasswordException') return new OrbitError('PDF_ENCRYPTED', 'PDF is password protected', { cause: error });
  if (name === 'AbortException' || name === 'RenderingCancelledException') return new OrbitError('CANCELLED', 'Cancelled', { cause: error });
  if (name === 'InvalidPDFException' || name === 'FormatError' || name === 'UnknownErrorException' || name === 'MissingPDFException') {
    return new OrbitError('PDF_CORRUPT', 'PDF could not be read', { detail: `${name}: ${message}`.slice(0, 300), cause: error });
  }
  return new OrbitError('PDF_CORRUPT', 'PDF could not be read', { detail: `${name || 'Error'}: ${message}`.slice(0, 300), cause: error });
}

/**
 * Open a PDF from bytes. The bytes are copied (PDF.js transfers its buffer to
 * the in-process worker). Throws PDF_ENCRYPTED for PDFs that need a user
 * password, PDF_CORRUPT for unreadable files.
 */
export async function openPdf(bytes: Uint8Array, engine?: PdfEngine, options: { maxImagePixels?: number } = {}): Promise<OpenedPdf> {
  const e = engine ?? (await loadPdfEngine());
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);
  const { assets } = e;
  const params = {
    data,
    CanvasFactory: makeCanvasFactory(e.canvas),
    FilterFactory: NoopFilterFactory,
    BinaryDataFactory: LocalBinaryDataFactory,
    cMapUrl: assets.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: assets.standardFontDataUrl,
    wasmUrl: assets.wasmUrl,
    iccUrl: assets.iccUrl,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
    stopAtErrors: false,
    // Embedded images above the input pixel limit are skipped instead of exhausting memory.
    maxImageSize: options.maxImagePixels ?? -1,
    verbosity: e.pdfjs.VerbosityLevel.ERRORS,
  };
  // No onPassword handler: a PDF that needs a user password rejects with PasswordException.
  const task = e.pdfjs.getDocument(params as unknown as Parameters<PdfJsModule['getDocument']>[0]);
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => undefined);
    throw mapPdfError(error);
  }
  return {
    doc,
    numPages: doc.numPages,
    destroy: async () => {
      await task.destroy().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------- rendering

export interface RenderedPage {
  /** Opaque RGBA pixels (straight alpha, all 255). Valid until `release()`. */
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  /** Frees the canvas memory now instead of at the next GC. */
  release(): void;
}

/** Pixel size of a page rendered at `scale` (PDF.js viewport applies /Rotate and the crop box). */
export function pageSizeAt(page: PdfPage, scale: number): { width: number; height: number } {
  const viewport = page.getViewport({ scale });
  return { width: Math.max(1, Math.round(viewport.width)), height: Math.max(1, Math.round(viewport.height)) };
}

/**
 * Render one page on an opaque `background` at `scale` (= dpi / 72).
 * Cancels the PDF.js render task when `signal` aborts.
 */
export async function renderPage(engine: PdfEngine, page: PdfPage, scale: number, background: string, signal?: AbortSignal): Promise<RenderedPage> {
  signal?.throwIfAborted();
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.round(viewport.width));
  const height = Math.max(1, Math.round(viewport.height));
  const canvas: NapiCanvas = engine.canvas.createCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  const task = page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
    background,
  });
  const onAbort = (): void => task.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await task.promise;
  } catch (error) {
    canvas.width = 0;
    canvas.height = 0;
    if (signal?.aborted) throw new OrbitError('CANCELLED', 'Cancelled', { cause: error });
    const mapped = mapPdfError(error);
    throw mapped.code === 'PDF_CORRUPT' ? new OrbitError('PDF_CORRUPT', 'PDF page could not be rendered', { detail: mapped.detail ?? '', cause: error }) : mapped;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const data = canvas.data();
  let released = false;
  return {
    data,
    width,
    height,
    release: () => {
      if (released) return;
      released = true;
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
