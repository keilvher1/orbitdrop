import { basename, dirname } from 'node:path';
import {
  FILE_FORMATS,
  inputKindOf,
  type CapabilitySnapshot,
  type EngineProbe,
  type FileFormat,
  type FormatSupport,
  type ImageInfo,
} from '@orbitdrop/contracts';
import { buildCapabilitySnapshot } from '@orbitdrop/core';
import type { ValidatedInput } from '@orbitdrop/core/node';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Wait until `check` passes (polling), failing after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 2000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A probe like the real darwin-arm64 build: everything but HEIC. */
export function probeWith(options: { readonly noOutput?: readonly FileFormat[]; readonly noInput?: readonly FileFormat[]; readonly pdfRender?: boolean; readonly pdfText?: boolean } = {}): EngineProbe {
  const formats = {} as Record<FileFormat, FormatSupport>;
  for (const format of FILE_FORMATS) {
    const readable = inputKindOf(format) !== undefined && format !== 'heic' && !(options.noInput ?? []).includes(format);
    const writable = format !== 'heic' && !(options.noOutput ?? []).includes(format);
    formats[format] = { input: readable, output: writable, inputEngine: readable ? 'sharp' : 'none', outputEngine: writable ? 'sharp' : 'none' };
  }
  return {
    platform: 'darwin',
    arch: 'arm64',
    versions: { sharp: 'test' },
    formats,
    pdfRender: options.pdfRender ?? true,
    pdfText: options.pdfText ?? true,
    koreanFont: null,
    errors: [],
    probedAt: 0,
  };
}

export function snapshotWith(...args: Parameters<typeof probeWith>): CapabilitySnapshot {
  return buildCapabilitySnapshot(probeWith(...args));
}

export function validated(path: string, format: FileFormat, bytes = 1000): ValidatedInput {
  return {
    originalPath: path,
    realPath: path,
    displayName: basename(path),
    sourceDir: dirname(path),
    format,
    kind: inputKindOf(format)!,
    bytes,
    extensionMismatch: false,
  };
}

/** A validator that knows a fixed set of fake paths (no file system). */
export function fakeValidator(files: Readonly<Record<string, FileFormat>>): (path: string) => Promise<ValidatedInput> {
  return async (path) => {
    const format = files[path];
    if (!format) {
      const { OrbitError } = await import('@orbitdrop/contracts');
      throw new OrbitError('UNSUPPORTED_FORMAT', 'Unsupported or unknown file type');
    }
    return validated(path, format);
  };
}

export function imageInfo(width: number, height: number): ImageInfo {
  return {
    format: 'jpeg',
    bytes: 1000,
    width,
    height,
    orientedWidth: width,
    orientedHeight: height,
    orientation: null,
    hasAlpha: false,
    channels: 3,
    space: 'srgb',
    density: 72,
    bitDepth: 'uchar',
    hasIccProfile: false,
    iccDescription: null,
    hasExif: false,
    hasXmp: false,
    hasIptc: false,
    exif: null,
    pages: null,
  };
}
