import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_LIMITS, OrbitError } from '@orbitdrop/contracts';
import { readInputBytes } from '../src/common/io';
import { openPdf } from '../src/pdf/engine';
import { makeFixtureDir, type FixtureDir } from './helpers/convert-fixtures';

/**
 * A PDF job holds the file once: readInputBytes reads straight into an exactly
 * sized ArrayBuffer (a plain Uint8Array, not a pooled Node Buffer) and openPdf
 * hands it to PDF.js without copying — PDF.js transfers the buffer to its
 * in-process worker, so the caller's array is detached afterwards.
 */
describe('PDF input bytes are read once and handed to PDF.js without a copy', () => {
  let fx: FixtureDir;

  beforeAll(async () => {
    fx = await makeFixtureDir(['report.pdf']);
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('readInputBytes returns a plain Uint8Array that owns exactly the file', async () => {
    const input = await fx.input('report.pdf');
    const bytes = await readInputBytes(input, DEFAULT_PROCESSING_LIMITS);
    expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
    expect(Buffer.isBuffer(bytes)).toBe(false);
    expect([bytes.byteOffset, bytes.byteLength, bytes.buffer.byteLength]).toEqual([0, input.bytes, input.bytes]);
    expect(Buffer.from(bytes).equals(await readFile(input.path))).toBe(true);
  });

  it('openPdf takes ownership of exact bytes (transferred, no copy) and copies anything else', async () => {
    const input = await fx.input('report.pdf');
    const owned = await readInputBytes(input, DEFAULT_PROCESSING_LIMITS);
    const pdf = await openPdf(owned);
    try {
      expect(pdf.numPages).toBe(3);
      expect(owned.byteLength).toBe(0); // detached: PDF.js moved the buffer instead of copying it
    } finally {
      await pdf.destroy();
    }

    // A Node Buffer (possibly a view into Node's shared pool) is copied and left intact.
    const buffer = await readFile(input.path);
    const copied = await openPdf(buffer);
    try {
      expect(copied.numPages).toBe(3);
      expect(buffer.byteLength).toBe(input.bytes);
    } finally {
      await copied.destroy();
    }
    const view = new Uint8Array(new ArrayBuffer(input.bytes + 16), 16, input.bytes);
    view.set(buffer);
    const fromView = await openPdf(view);
    try {
      expect(fromView.numPages).toBe(3);
      expect(view.byteLength).toBe(input.bytes);
    } finally {
      await fromView.destroy();
    }
  });

  it('enforces the byte limit on the real file size and maps read errors', async () => {
    const input = await fx.input('report.pdf');
    const code = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => (e instanceof OrbitError ? e.code : String(e)),
      );
    // main reported a small size, but the file grew past the limit before the worker read it.
    const grown = fx.path('grown.pdf');
    await writeFile(grown, Buffer.alloc(4096, 0x20));
    expect(await code(readInputBytes({ ...input, path: grown, bytes: 10 }, { ...DEFAULT_PROCESSING_LIMITS, maxInputBytes: 1000 }))).toBe('FILE_TOO_LARGE');
    expect(await code(readInputBytes({ ...input, bytes: 10_000_000 }, { ...DEFAULT_PROCESSING_LIMITS, maxInputBytes: 1000 }))).toBe('FILE_TOO_LARGE');
    expect(await code(readInputBytes({ ...input, path: fx.path('missing.pdf') }, DEFAULT_PROCESSING_LIMITS))).toBe('FILE_NOT_FOUND');
    const controller = new AbortController();
    controller.abort();
    expect(await code(readInputBytes(input, DEFAULT_PROCESSING_LIMITS, controller.signal))).toBe('CANCELLED');
  });
});
