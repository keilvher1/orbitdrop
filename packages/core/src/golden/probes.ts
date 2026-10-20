import type { EngineProbe, FileFormat, FormatSupport, Platform } from '@orbitdrop/contracts';

/**
 * Realistic EngineProbe fixtures (test / golden data, not part of the public API).
 *
 * Measured on darwin-arm64 (macOS 26.6) with the bundled sharp 0.35.5
 * (libvips 8.18.7, libheif 1.23.5) by encoding a 2×2 RGBA image with every
 * encoder and decoding the result:
 *   JPEG, PNG, WebP, TIFF, GIF, AVIF  encode + decode OK
 *   HEIC (HEVC)  encode fails "heifsave: Unsupported compression"; decoding a
 *                real HEIC (made with sips) fails "Support for this compression
 *                format has not been built in: HEVC (… libde265)" — only the
 *                metadata can be read
 *   BMP          not a sharp format (OrbitDrop ships a builtin BMP codec)
 *   PDF          not a sharp format (PDF.js renders / extracts, pdf-lib writes)
 * The Windows x64 prebuilt has the same codec set. HEIC is only available on
 * macOS through the helper's ImageIO mode.
 */

const PROBED_AT = Date.UTC(2026, 9, 21, 0, 0, 0);

const VERSIONS: Readonly<Record<string, string>> = {
  sharp: '0.35.5',
  vips: '8.18.7',
  heif: '1.23.5',
  'pdfjs-dist': '6.4.299',
  '@napi-rs/canvas': '1.0.11',
  'pdf-lib': '1.17.1',
  docx: '9.12.0',
};

const sharpIo: FormatSupport = { input: true, output: true, inputEngine: 'sharp', outputEngine: 'sharp' };

const HEIC_NOTE = 'sharp prebuilt: HEVC decoder plugin (libde265) not built in; heifsave fails with "Unsupported compression"';

function formats(heic: FormatSupport): Readonly<Record<FileFormat, FormatSupport>> {
  return {
    jpeg: sharpIo,
    png: sharpIo,
    webp: sharpIo,
    gif: sharpIo,
    tiff: sharpIo,
    avif: sharpIo,
    heic,
    bmp: { input: true, output: true, inputEngine: 'builtin-bmp', outputEngine: 'builtin-bmp' },
    pdf: { input: true, output: true, inputEngine: 'pdfjs', outputEngine: 'pdf-lib' },
    docx: { input: false, output: true, inputEngine: 'none', outputEngine: 'docx', note: 'output only' },
    txt: { input: false, output: true, inputEngine: 'none', outputEngine: 'text', note: 'output only' },
  };
}

function probe(platform: Platform, arch: string, heic: FormatSupport, koreanFont: string, errors: readonly string[]): EngineProbe {
  return {
    platform,
    arch,
    versions: VERSIONS,
    formats: formats(heic),
    pdfRender: true,
    pdfText: true,
    koreanFont,
    errors,
    probedAt: PROBED_AT,
  };
}

const NO_HEIC: FormatSupport = { input: false, output: false, inputEngine: 'none', outputEngine: 'none', note: HEIC_NOTE };

/** macOS arm64 without the ImageIO helper (sharp + builtin BMP + PDF.js + pdf-lib + docx). */
export const PROBE_DARWIN_ARM64: EngineProbe = probe('darwin', 'arm64', NO_HEIC, 'Apple SD Gothic Neo', [`heic: ${HEIC_NOTE}`]);

/** macOS arm64 with `OrbitDropHelper imageio --probe` reporting HEIC decode + encode. */
export const PROBE_DARWIN_ARM64_IMAGEIO: EngineProbe = probe(
  'darwin',
  'arm64',
  { input: true, output: true, inputEngine: 'imageio', outputEngine: 'imageio' },
  'Apple SD Gothic Neo',
  [],
);

/** Windows x64: same sharp codecs, no HEIC at all. */
export const PROBE_WIN32_X64: EngineProbe = probe('win32', 'x64', NO_HEIC, 'Malgun Gothic', [`heic: ${HEIC_NOTE}`]);

/** @napi-rs/canvas failed to load: PDF pages cannot be rendered, text extraction still works. */
export const PROBE_DARWIN_NO_CANVAS: EngineProbe = {
  ...PROBE_DARWIN_ARM64,
  pdfRender: false,
  koreanFont: null,
  errors: [...PROBE_DARWIN_ARM64.errors, 'canvas: failed to load @napi-rs/canvas'],
};

/** PDF.js unavailable entirely (no render, no text). */
export const PROBE_DARWIN_NO_PDFJS: EngineProbe = {
  ...PROBE_DARWIN_ARM64,
  formats: { ...PROBE_DARWIN_ARM64.formats, pdf: { input: false, output: true, inputEngine: 'none', outputEngine: 'pdf-lib', note: 'pdfjs failed to load' } },
  pdfRender: false,
  pdfText: false,
  errors: [...PROBE_DARWIN_ARM64.errors, 'pdfjs: failed to load'],
};

/** sharp failed to load: no image codec except the builtin BMP one; PDF still works. */
export const PROBE_DARWIN_NO_SHARP: EngineProbe = {
  ...PROBE_DARWIN_ARM64,
  formats: {
    ...PROBE_DARWIN_ARM64.formats,
    jpeg: { input: false, output: false, inputEngine: 'none', outputEngine: 'none', note: 'sharp failed to load' },
    png: { input: false, output: false, inputEngine: 'none', outputEngine: 'none', note: 'sharp failed to load' },
    webp: { input: false, output: false, inputEngine: 'none', outputEngine: 'none', note: 'sharp failed to load' },
    gif: { input: false, output: false, inputEngine: 'none', outputEngine: 'none', note: 'sharp failed to load' },
    tiff: { input: false, output: false, inputEngine: 'none', outputEngine: 'none', note: 'sharp failed to load' },
    avif: { input: false, output: false, inputEngine: 'none', outputEngine: 'none', note: 'sharp failed to load' },
  },
  errors: [...PROBE_DARWIN_ARM64.errors, 'sharp: failed to load'],
};
