/**
 * File formats OrbitDrop knows about. A format being listed here does not mean
 * it is supported: the capability registry (built from a probe of the bundled
 * engines) decides what is actually enabled.
 */

export const IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif', 'heic', 'bmp'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** 'md' (added later): the Markdown report of Claude analysis — output only, like DOCX and TXT. */
export const DOCUMENT_FORMATS = ['pdf', 'docx', 'txt', 'md'] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export type FileFormat = ImageFormat | DocumentFormat;
export const FILE_FORMATS: readonly FileFormat[] = [...IMAGE_FORMATS, ...DOCUMENT_FORMATS];

/** Kind of input file a wheel menu is built for. DOCX/TXT/MD are output-only. */
export type InputKind = 'image' | 'pdf';
export const INPUT_KINDS: readonly InputKind[] = ['image', 'pdf'];

export interface FormatInfo {
  readonly format: FileFormat;
  /** Short label used on wheel sectors and buttons, e.g. "JPG". */
  readonly label: string;
  /** Canonical extension written for outputs, including the dot. */
  readonly extension: string;
  /** Lower-case extensions accepted as input, including the dot. */
  readonly extensions: readonly string[];
  readonly mime: string;
  readonly kind: 'image' | 'document';
  /** Whether the format can carry an alpha channel. */
  readonly alpha: boolean;
  /** Whether encoding is lossy (a quality setting applies). */
  readonly lossy: boolean;
}

export const FORMAT_INFO: Readonly<Record<FileFormat, FormatInfo>> = {
  jpeg: {
    format: 'jpeg',
    label: 'JPG',
    extension: '.jpg',
    extensions: ['.jpg', '.jpeg', '.jpe', '.jfif'],
    mime: 'image/jpeg',
    kind: 'image',
    alpha: false,
    lossy: true,
  },
  png: {
    format: 'png',
    label: 'PNG',
    extension: '.png',
    extensions: ['.png'],
    mime: 'image/png',
    kind: 'image',
    alpha: true,
    lossy: false,
  },
  webp: {
    format: 'webp',
    label: 'WEBP',
    extension: '.webp',
    extensions: ['.webp'],
    mime: 'image/webp',
    kind: 'image',
    alpha: true,
    lossy: true,
  },
  gif: {
    format: 'gif',
    label: 'GIF',
    extension: '.gif',
    extensions: ['.gif'],
    mime: 'image/gif',
    kind: 'image',
    alpha: true,
    lossy: false,
  },
  tiff: {
    format: 'tiff',
    label: 'TIFF',
    extension: '.tiff',
    extensions: ['.tif', '.tiff'],
    mime: 'image/tiff',
    kind: 'image',
    alpha: true,
    lossy: false,
  },
  avif: {
    format: 'avif',
    label: 'AVIF',
    extension: '.avif',
    extensions: ['.avif'],
    mime: 'image/avif',
    kind: 'image',
    alpha: true,
    lossy: true,
  },
  heic: {
    format: 'heic',
    label: 'HEIC',
    extension: '.heic',
    extensions: ['.heic', '.heif', '.hif'],
    mime: 'image/heic',
    kind: 'image',
    alpha: true,
    lossy: true,
  },
  bmp: {
    format: 'bmp',
    label: 'BMP',
    extension: '.bmp',
    extensions: ['.bmp', '.dib'],
    mime: 'image/bmp',
    kind: 'image',
    alpha: true,
    lossy: false,
  },
  pdf: {
    format: 'pdf',
    label: 'PDF',
    extension: '.pdf',
    extensions: ['.pdf'],
    mime: 'application/pdf',
    kind: 'document',
    alpha: false,
    lossy: false,
  },
  docx: {
    format: 'docx',
    label: 'DOCX',
    extension: '.docx',
    extensions: ['.docx'],
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
    alpha: false,
    lossy: false,
  },
  txt: {
    format: 'txt',
    label: 'TXT',
    extension: '.txt',
    extensions: ['.txt'],
    mime: 'text/plain',
    kind: 'document',
    alpha: false,
    lossy: false,
  },
  // Output only (no input kind, no file signature): a dropped .md file stays unsupported.
  md: {
    format: 'md',
    label: 'MD',
    extension: '.md',
    extensions: ['.md'],
    mime: 'text/markdown',
    kind: 'document',
    alpha: false,
    lossy: false,
  },
};

const EXTENSION_TO_FORMAT: ReadonlyMap<string, FileFormat> = new Map(
  FILE_FORMATS.flatMap((format) => FORMAT_INFO[format].extensions.map((ext) => [ext, format] as const)),
);

/** Extension (with or without the leading dot, any case) → format. */
export function formatFromExtension(ext: string): FileFormat | undefined {
  const normalized = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase();
  return EXTENSION_TO_FORMAT.get(normalized);
}

export function isImageFormat(format: FileFormat): format is ImageFormat {
  return (IMAGE_FORMATS as readonly string[]).includes(format);
}

/** Input kind for a format, or undefined for output-only formats (DOCX, TXT, MD). */
export function inputKindOf(format: FileFormat): InputKind | undefined {
  if (format === 'pdf') return 'pdf';
  return isImageFormat(format) ? 'image' : undefined;
}
