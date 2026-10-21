import { describe, expect, it } from 'vitest';
import { FILE_FORMATS } from '@orbitdrop/contracts';
import { buildCapabilitySnapshot, supports } from '@orbitdrop/core';
import { probeEngines } from '../src/probe';

describe('probeEngines (measured engine support)', () => {
  it('measures every format quickly, never throws and caches the result per process', async () => {
    const started = performance.now();
    const probe = await probeEngines({ imageIOHelper: null });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1500);

    expect(Object.keys(probe.formats).sort()).toEqual([...FILE_FORMATS].sort());
    expect(probe.platform).toBe(process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux');
    expect(probe.arch).toBe(process.arch);
    expect(probe.errors).toEqual([]);

    for (const format of ['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif'] as const) {
      expect(probe.formats[format], format).toMatchObject({ input: true, output: true, inputEngine: 'sharp', outputEngine: 'sharp' });
    }
    expect(probe.formats.bmp).toMatchObject({ input: true, output: true, inputEngine: 'builtin-bmp', outputEngine: 'builtin-bmp' });
    expect(probe.formats.pdf).toMatchObject({ input: true, output: true, inputEngine: 'pdfjs', outputEngine: 'pdf-lib' });
    expect(probe.formats.docx).toMatchObject({ input: false, output: true, outputEngine: 'docx' });
    expect(probe.formats.txt).toMatchObject({ input: false, output: true, outputEngine: 'text' });
    expect(probe.pdfRender).toBe(true);
    expect(probe.pdfText).toBe(true);

    // Prebuilt sharp has libheif with AV1 only: HEIC (HEVC) is unsupported unless the ImageIO helper is configured.
    expect(probe.formats.heic).toMatchObject({ input: false, output: false, inputEngine: 'none', outputEngine: 'none' });
    expect(probe.formats.heic.note).toMatch(/HEVC|Unsupported compression/);
    expect(probe.formats.heic.note).toMatch(/ImageIO helper not configured/);

    for (const key of ['sharp', 'libvips', 'pdfjs', 'canvas', 'pdf-lib', 'docx', 'node']) {
      expect(probe.versions[key], key).toMatch(/^\d+\.\d+/);
    }
    if (process.platform === 'darwin') expect(probe.koreanFont).toMatch(/Apple SD Gothic Neo|AppleGothic|Noto/);

    const again = performance.now();
    expect(await probeEngines()).toBe(probe);
    expect(performance.now() - again).toBeLessThan(5);
    expect(await probeEngines({ refresh: true, imageIOHelper: null })).not.toBe(probe);
  });

  it('feeds the capability registry: P0/P1 conversions enabled, HEIC disabled with a reason', async () => {
    const snapshot = buildCapabilitySnapshot(await probeEngines());
    expect(supports(snapshot, 'convert.jpeg', { kind: 'pdf', format: 'pdf' })).toBe(true);
    expect(supports(snapshot, 'convert.png', { kind: 'pdf', format: 'pdf' })).toBe(true);
    expect(supports(snapshot, 'convert.webp', { kind: 'image', format: 'png' })).toBe(true);
    expect(supports(snapshot, 'convert.png', { kind: 'image', format: 'bmp' })).toBe(true);
    expect(supports(snapshot, 'convert.txt', { kind: 'pdf', format: 'pdf' })).toBe(true);
    expect(supports(snapshot, 'convert.docx', { kind: 'pdf', format: 'pdf' })).toBe(true);
    expect(supports(snapshot, 'convert.pdf', { kind: 'image', format: 'jpeg' })).toBe(true);
    expect(supports(snapshot, 'convert.heic', { kind: 'image', format: 'png' })).toBe(false);
    expect(supports(snapshot, 'convert.png', { kind: 'image', format: 'heic' })).toBe(false);
    expect(snapshot.actions['convert.heic'].reason?.en).toBeTruthy();
  });
});
