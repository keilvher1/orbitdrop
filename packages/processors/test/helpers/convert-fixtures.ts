import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import {
  DEFAULT_PROCESSING_LIMITS,
  type ActionId,
  type JobProgress,
  type ProcessingLimits,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorRunContext,
  type ProcessorSettings,
} from '@orbitdrop/contracts';
import { detectFormatFromHeader, SNIFF_BYTES } from '@orbitdrop/core';
import { isTempFileName } from '@orbitdrop/core/node';

/** Shared helpers for packages/processors/test/convert*.test.ts. */

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const STATIC_FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'static');

export const SETTINGS: ProcessorSettings = { pdfDpi: 300, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 };

interface FixtureModule {
  generateFixtures(dir: string, options?: { only?: readonly string[] }): Promise<Record<string, string>>;
  FIXTURE_NAMES: readonly string[];
  TEXT: {
    single: readonly string[];
    reportHeading: (n: number, total: number) => string;
    reportParagraph1: readonly string[];
    reportParagraph2: readonly string[];
    rotated: string;
    koreanCmap: string;
    partial: (n: number) => string;
    many: (n: number) => string;
  };
}

let fixtureModule: Promise<FixtureModule> | null = null;
export function fixtures(): Promise<FixtureModule> {
  fixtureModule ??= import(/* @vite-ignore */ pathToFileURL(join(REPO_ROOT, 'scripts', 'gen-fixtures.mjs')).href) as Promise<FixtureModule>;
  return fixtureModule;
}

export interface FixtureDir {
  readonly dir: string;
  path(name: string): string;
  input(name: string, fileId?: string): Promise<ProcessorInput>;
  cleanup(): Promise<void>;
}

let counter = 0;

/** Build a ProcessorInput the way main does (header sniffing, real path, display name). */
export async function inputFor(path: string, fileId = `f${(counter += 1)}`): Promise<ProcessorInput> {
  const handle = await open(path, 'r');
  let header: Uint8Array;
  try {
    const buffer = new Uint8Array(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    header = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const format = detectFormatFromHeader(header);
  if (!format) throw new Error(`fixture ${basename(path)} has an unknown format`);
  return { fileId, path, displayName: basename(path), sourceDir: dirname(path), format, bytes: (await stat(path)).size };
}

/** Generate fixtures into a fresh temp folder (each test file gets its own copy). */
export async function makeFixtureDir(only?: readonly string[]): Promise<FixtureDir> {
  const dir = await mkdtemp(join(tmpdir(), 'orbitdrop-convert-test-'));
  const mod = await fixtures();
  await mod.generateFixtures(dir, only ? { only } : {});
  return {
    dir,
    path: (name) => join(dir, name),
    input: (name, fileId) => inputFor(join(dir, name), fileId),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export function staticFixture(name: string): string | null {
  const path = join(STATIC_FIXTURES, name);
  return existsSync(path) ? path : null;
}

let jobCounter = 0;
export function makeJob(
  actionId: ActionId,
  inputs: readonly ProcessorInput[],
  options: unknown = {},
  overrides: { limits?: Partial<ProcessingLimits>; settings?: Partial<ProcessorSettings>; outputDir?: string | null } = {},
): ProcessorJob {
  return {
    jobId: `convert-test-${(jobCounter += 1)}`,
    actionId,
    inputs,
    options,
    outputDir: overrides.outputDir ?? null,
    settings: { ...SETTINGS, ...overrides.settings },
    limits: { ...DEFAULT_PROCESSING_LIMITS, ...overrides.limits },
  };
}

export interface TestContext {
  readonly ctx: ProcessorRunContext;
  readonly progress: JobProgress[];
  readonly controller: AbortController;
}

export function makeCtx(onProgress?: (p: JobProgress, controller: AbortController) => void): TestContext {
  const controller = new AbortController();
  const progress: JobProgress[] = [];
  return {
    controller,
    progress,
    ctx: {
      signal: controller.signal,
      onProgress: (p) => {
        progress.push(p);
        onProgress?.(p, controller);
      },
    },
  };
}

export async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function listFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

/** Temp files of the safe writer still present in `dir`. */
export async function tempFilesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => isTempFileName(name) || name.includes('orbitdrop-'));
}

/** Minimal ZIP reader (central directory + stored/deflate) for checking DOCX packages. */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Text of all <w:t> runs per <w:p> paragraph in word/document.xml. */
export function docxParagraphs(documentXml: string): { text: string; pageBreakBefore: boolean }[] {
  const paragraphs: { text: string; pageBreakBefore: boolean }[] = [];
  for (const match of documentXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const xml = match[0];
    const text = [...xml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) => m[1]!)
      .join('')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
    paragraphs.push({ text, pageBreakBefore: /<w:pageBreakBefore(?:\/>| w:val="(?:true|1|on)")/.test(xml) });
  }
  return paragraphs;
}
