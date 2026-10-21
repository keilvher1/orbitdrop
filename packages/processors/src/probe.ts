import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp, { type Sharp } from 'sharp';
import {
  FILE_FORMATS,
  type EngineProbe,
  type FileFormat,
  type FormatEngine,
  type FormatSupport,
  type Platform,
} from '@orbitdrop/contracts';
import { decodeBmp, encodeBmp } from './codecs/bmp';
import { decodeWithImageIO, encodeWithImageIO, imageIOHelperPath, isExecutableFile, probeImageIO } from './codecs/imageio';
import { configureSharp } from './common/io';
import { loadPdfEngine, openPdf, renderPage, type PdfEngine } from './pdf/engine';
import { extractPageText } from './pdf/text';
import { detectKoreanFont } from './tools';

/**
 * Measures — never assumes — what the bundled engines can do in this process:
 * tiny in-memory encode/decode round trips per image format, a real PDF.js
 * render and text extraction of a generated PDF, a DOCX pack, the HEIC helper
 * (if configured) and a Hangul-capable canvas font. Never throws (failures are
 * recorded in `errors`/notes). The result is cached per process.
 */

const PROBE_TEXT = 'OrbitDrop probe 123';
const SHARP_FORMATS = ['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif', 'heic'] as const;
type SharpFormat = (typeof SHARP_FORMATS)[number];
const EXPECTED_SHARP: ReadonlySet<SharpFormat> = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif']);

/** 16×16 HEIC (HEVC) written by macOS ImageIO; used to measure whether a decoder can read HEVC. */
const HEIC_SAMPLE_BASE64 =
  'AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABw21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAA' +
  'AAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVp' +
  'bmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAA5mlwcnAAAADF' +
  'aXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAAQAAAAEAAAAAlpcm90AAAAABBwaXhpAAAA' +
  'AAMICAgAAABxaHZjQwEDcAAAALAAAAAAAB7wAPz9+PgAAAsDoAABABdAAQwB//8DcAAAAwCwAAADAAADAB5wJKEAAQAjQgEBA3AA' +
  'AAMAsAAAAwAAAwAeoBQgQcCTDOIe5FlU3AgIGAKiAAEACUQBwGFyyERTZAAAABlpcG1hAAAAAAAAAAEAAQaBAgMFhoQAAAAsaWxv' +
  'YwAAAABEAAACAAEAAAABAAACQwAAAD0AAgAAAAEAAAH3AAAATAAAAAFtZGF0AAAAAAAAAJkAAAAGRXhpZgAATU0AKgAAAAgAAwEa' +
  'AAUAAAABAAAAMgEbAAUAAAABAAAAOgEoAAMAAAABAAIAAAAAAAAAAAAZAAAAAQAAABkAAAABAAAAOSgBr6L2RoF8//x016/5Gv//' +
  'T1/Vf/gsf/+0AZ/rXPdMsmf6IPnCOcgrH+yhO93MIvYV+CtwhJsiuA==';

export interface ProbeOptions {
  /** Ignore the cached result and measure again. */
  readonly refresh?: boolean;
  /** Helper binary for HEIC (default: $ORBITDROP_IMAGEIO_HELPER). */
  readonly imageIOHelper?: string | null;
}

function short(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // libvips accumulates warnings ("source: bad seek…") before the real error.
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^source: bad seek/.test(l));
  return (lines.find((l) => /not been built|unsupported|error|fail/i.test(l)) ?? lines[0] ?? text).trim().slice(0, 160);
}

function support(input: boolean, output: boolean, inputEngine: FormatEngine, outputEngine: FormatEngine, note?: string): FormatSupport {
  return {
    input,
    output,
    inputEngine: input ? inputEngine : 'none',
    outputEngine: output ? outputEngine : 'none',
    ...(note ? { note } : {}),
  };
}

// ---------------------------------------------------------------- image formats

function encoderFor(format: SharpFormat, image: Sharp): Sharp {
  switch (format) {
    case 'jpeg':
      return image.jpeg({ quality: 80 });
    case 'png':
      return image.png();
    case 'webp':
      return image.webp({ quality: 80 });
    case 'gif':
      return image.gif();
    case 'tiff':
      return image.tiff({ compression: 'lzw' });
    case 'avif':
      return image.avif({ quality: 50, effort: 0 });
    case 'heic':
      return image.heif({ compression: 'hevc', quality: 50 });
  }
}

async function decodes(data: Buffer, width: number, height: number): Promise<void> {
  const { info } = await sharp(data, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) throw new Error(`decoded ${info.width}x${info.height}, expected ${width}x${height}`);
}

interface SharpResult {
  readonly input: boolean;
  readonly output: boolean;
  readonly note?: string;
}

async function probeSharpFormat(format: SharpFormat): Promise<SharpResult> {
  const width = 8;
  const height = 6;
  const source = sharp({ create: { width, height, channels: 4, background: { r: 200, g: 40, b: 90, alpha: 0.5 } } });
  let encoded: Buffer | null = null;
  let encodeError: string | null = null;
  try {
    encoded = await encoderFor(format, source).toBuffer();
    if (encoded.length === 0) throw new Error('empty output');
  } catch (error) {
    encodeError = short(error);
  }
  if (encoded) {
    try {
      await decodes(encoded, width, height);
      return { input: true, output: true };
    } catch (error) {
      return { input: false, output: true, note: `decode failed: ${short(error)}` };
    }
  }
  if (format === 'heic') {
    try {
      await decodes(Buffer.from(HEIC_SAMPLE_BASE64, 'base64'), 16, 16);
      return { input: true, output: false, note: `encode failed: ${encodeError}` };
    } catch (error) {
      return { input: false, output: false, note: `sharp: encode failed (${encodeError}); decode failed (${short(error)})` };
    }
  }
  return { input: false, output: false, note: `encode failed: ${encodeError}` };
}

/**
 * Sequential on purpose: libvips keeps one error buffer per process, so
 * concurrent failures would mix their messages into each other's notes.
 * All seven round trips take ~20 ms.
 */
async function probeSharpFormats(): Promise<(readonly [SharpFormat, SharpResult])[]> {
  const results: (readonly [SharpFormat, SharpResult])[] = [];
  for (const format of SHARP_FORMATS) results.push([format, await probeSharpFormat(format)] as const);
  return results;
}

async function probeBmp(): Promise<SharpResult> {
  try {
    const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]);
    const withAlpha = decodeBmp(encodeBmp({ data: rgba, width: 3, height: 2 }), 1_000);
    const opaque = Buffer.from(rgba);
    for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
    const noAlpha = decodeBmp(encodeBmp({ data: opaque, width: 3, height: 2 }), 1_000);
    if (!withAlpha.data.equals(rgba) || !noAlpha.data.equals(opaque)) throw new Error('round trip mismatch');
    return { input: true, output: true };
  } catch (error) {
    return { input: false, output: false, note: `builtin BMP codec failed: ${short(error)}` };
  }
}

interface HeicHelperResult {
  readonly input: boolean;
  readonly output: boolean;
  readonly note: string;
  readonly error?: string;
}

async function probeHeicHelper(explicit: string | null | undefined): Promise<HeicHelperResult> {
  const helper = explicit === undefined ? imageIOHelperPath() : explicit;
  if (!helper) return { input: false, output: false, note: 'ImageIO helper not configured (ORBITDROP_IMAGEIO_HELPER)' };
  if (!(await isExecutableFile(helper))) return { input: false, output: false, note: 'ImageIO helper is not an executable file', error: 'heic: ImageIO helper path is not executable' };
  try {
    const caps = await probeImageIO({ helperPath: helper, timeoutMs: 3000 });
    let input = caps.decode.includes('heic');
    let output = caps.encode.includes('heic');
    const notes: string[] = [];
    if (output) {
      // Verify with a real round trip (helper encode → helper decode → sharp).
      try {
        const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#3366cc' } }).png().toBuffer();
        const heic = await encodeWithImageIO(png, 'heic', 70, { helperPath: helper, timeoutMs: 3000 });
        if (input) {
          const back = await decodeWithImageIO(heic, { helperPath: helper, timeoutMs: 3000 });
          await decodes(back, 16, 12);
        }
      } catch (error) {
        input = false;
        output = false;
        notes.push(`ImageIO round trip failed: ${short(error)}`);
      }
    } else if (input) {
      try {
        const back = await decodeWithImageIO(Buffer.from(HEIC_SAMPLE_BASE64, 'base64'), { helperPath: helper, timeoutMs: 3000 });
        await decodes(back, 16, 16);
      } catch (error) {
        input = false;
        notes.push(`ImageIO decode failed: ${short(error)}`);
      }
    }
    return { input, output, note: notes.join('; ') || `ImageIO decode=[${caps.decode.join(',')}] encode=[${caps.encode.join(',')}]` };
  } catch (error) {
    return { input: false, output: false, note: `ImageIO probe failed: ${short(error)}`, error: `heic: ImageIO helper probe failed: ${short(error)}` };
  }
}

// ---------------------------------------------------------------- documents

interface PdfResult {
  readonly output: boolean;
  readonly render: boolean;
  readonly text: boolean;
  readonly errors: string[];
  readonly version?: string;
}

async function makeProbePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([200, 60]);
  page.drawText(PROBE_TEXT, { x: 10, y: 25, size: 14, font });
  const bytes = await doc.save();
  const reloaded = await PDFDocument.load(bytes);
  if (reloaded.getPageCount() !== 1) throw new Error('pdf-lib round trip lost the page');
  return bytes;
}

async function probePdf(): Promise<PdfResult> {
  const errors: string[] = [];
  let bytes: Uint8Array;
  try {
    bytes = await makeProbePdf();
  } catch (error) {
    return { output: false, render: false, text: false, errors: [`pdf output (pdf-lib): ${short(error)}`] };
  }
  let engine: PdfEngine;
  try {
    engine = await loadPdfEngine();
  } catch (error) {
    return { output: true, render: false, text: false, errors: [`pdf engine: ${short(error)}`] };
  }
  let render = false;
  let text = false;
  try {
    const pdf = await openPdf(bytes, engine);
    try {
      const page = await pdf.doc.getPage(1);
      try {
        try {
          const rendered = await renderPage(engine, page, 2, '#FFFFFF');
          try {
            if (rendered.width !== 400 || rendered.height !== 120) throw new Error(`unexpected size ${rendered.width}x${rendered.height}`);
            let dark = 0;
            for (let i = 0; i < rendered.data.length; i += 4) if (rendered.data[i]! < 100) dark += 1;
            if (dark < 50) throw new Error('rendered page has no visible text');
            render = true;
          } finally {
            rendered.release();
          }
        } catch (error) {
          errors.push(`pdf render: ${short(error)}`);
        }
        try {
          const { lines } = await extractPageText(page);
          if (!lines.map((l) => l.text).join(' ').includes(PROBE_TEXT)) throw new Error('known text not found');
          text = true;
        } catch (error) {
          errors.push(`pdf text: ${short(error)}`);
        }
      } finally {
        page.cleanup();
      }
    } finally {
      await pdf.destroy();
    }
  } catch (error) {
    errors.push(`pdf open: ${short(error)}`);
  }
  return { output: true, render, text, errors, version: engine.version };
}

async function probeDocx(): Promise<{ ok: boolean; error?: string }> {
  try {
    const buffer = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun(PROBE_TEXT)] })] }] }));
    if (buffer.length < 100 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip package');
    if (!buffer.includes('word/document.xml')) throw new Error('word/document.xml missing');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `docx: ${short(error)}` };
  }
}

// ---------------------------------------------------------------- fonts

/**
 * Same detection the Annotate renderer uses (processors-edit, src/tools/fonts.ts:
 * first family of core's ANNOTATION_FONT_CANDIDATES that really draws '한'/'글'),
 * so EngineProbe.koreanFont and annotation output always agree.
 */
async function probeKoreanFont(): Promise<{ family: string | null; error?: string }> {
  try {
    return { family: await detectKoreanFont() };
  } catch (error) {
    return { family: null, error: `korean font: ${short(error)}` };
  }
}

// ---------------------------------------------------------------- versions

function packageVersion(name: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve(name));
    for (let i = 0; i < 6; i += 1) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (pkg.name === name && pkg.version) return pkg.version;
      } catch {
        // keep walking up
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // not resolvable
  }
  return null;
}

// ---------------------------------------------------------------- probe

function platformOf(): Platform {
  return process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
}

async function measure(options: ProbeOptions): Promise<EngineProbe> {
  const errors: string[] = [];
  const versions: Record<string, string> = {};
  configureSharp();

  const [sharpResults, bmp, pdf, docx, korean, heicHelper] = await Promise.all([
    probeSharpFormats(),
    probeBmp(),
    probePdf(),
    probeDocx(),
    probeKoreanFont(),
    probeHeicHelper(options.imageIOHelper),
  ]);

  const formats = {} as Record<FileFormat, FormatSupport>;
  for (const [format, result] of sharpResults) {
    if (format === 'heic') continue;
    formats[format] = support(result.input, result.output, 'sharp', 'sharp', result.note);
    if (EXPECTED_SHARP.has(format) && (!result.input || !result.output)) errors.push(`${format}: ${result.note ?? 'unsupported'}`);
  }

  const heicSharp = sharpResults.find(([f]) => f === 'heic')![1];
  const heicIn: [boolean, FormatEngine] = heicSharp.input ? [true, 'sharp'] : heicHelper.input ? [true, 'imageio'] : [false, 'none'];
  const heicOut: [boolean, FormatEngine] = heicSharp.output ? [true, 'sharp'] : heicHelper.output ? [true, 'imageio'] : [false, 'none'];
  formats.heic = support(heicIn[0], heicOut[0], heicIn[1], heicOut[1], [heicSharp.note, heicHelper.note].filter(Boolean).join('; '));
  if (heicHelper.error) errors.push(heicHelper.error);

  formats.bmp = support(bmp.input, bmp.output, 'builtin-bmp', 'builtin-bmp', bmp.note);
  if (bmp.note) errors.push(`bmp: ${bmp.note}`);

  formats.pdf = support(pdf.render || pdf.text, pdf.output, 'pdfjs', 'pdf-lib', pdf.render ? undefined : 'PDF.js page rendering unavailable');
  errors.push(...pdf.errors);
  formats.docx = support(false, docx.ok, 'none', 'docx', docx.ok ? 'output only' : docx.error);
  if (docx.error) errors.push(docx.error);
  formats.txt = support(false, pdf.text, 'none', 'text', pdf.text ? 'output only (PDF text extraction)' : 'PDF text extraction unavailable');
  if (korean.error) errors.push(korean.error);

  for (const format of FILE_FORMATS) {
    formats[format] ??= support(false, false, 'none', 'none', 'not probed');
  }

  versions.sharp = sharp.versions.sharp ?? packageVersion('sharp') ?? 'unknown';
  if (sharp.versions.vips) versions.libvips = sharp.versions.vips;
  if (sharp.versions.heif) versions.libheif = sharp.versions.heif;
  versions.pdfjs = pdf.version ?? packageVersion('pdfjs-dist') ?? 'unknown';
  versions.canvas = packageVersion('@napi-rs/canvas') ?? 'unknown';
  versions['pdf-lib'] = packageVersion('pdf-lib') ?? 'unknown';
  versions.docx = packageVersion('docx') ?? 'unknown';
  versions.node = process.versions.node;
  if (process.versions.electron) versions.electron = process.versions.electron;

  return {
    platform: platformOf(),
    arch: process.arch,
    versions,
    formats,
    pdfRender: pdf.render,
    pdfText: pdf.text,
    koreanFont: korean.family,
    errors,
    probedAt: Date.now(),
  };
}

function fallbackProbe(error: unknown): EngineProbe {
  const formats = {} as Record<FileFormat, FormatSupport>;
  for (const format of FILE_FORMATS) formats[format] = support(false, false, 'none', 'none', 'probe failed');
  return {
    platform: platformOf(),
    arch: process.arch,
    versions: { node: process.versions.node },
    formats,
    pdfRender: false,
    pdfText: false,
    koreanFont: null,
    errors: [`probe failed: ${short(error)}`],
    probedAt: Date.now(),
  };
}

let cached: Promise<EngineProbe> | null = null;

/** Engine capabilities of this process (cached; `refresh` measures again). Never rejects. */
export function probeEngines(options: ProbeOptions = {}): Promise<EngineProbe> {
  if (!cached || options.refresh) {
    cached = measure(options).catch((error: unknown) => fallbackProbe(error));
  }
  return cached;
}
