import { ACTIONS, type ActionId, type IconId, type WheelMode } from './actions';
import { IMAGE_FORMATS, inputKindOf, type FileFormat, type ImageFormat } from './formats';

/**
 * Sector order, clockwise starting at the top (12 o'clock).
 * Taken from the reference recording:
 *   PDF convert:  DOCX, JPG, PNG, TXT
 *   JPG convert:  PNG, WEBP, HEIC, TIFF, AVIF, BMP, PDF, DOCX
 *   Image tools:  COMPRESS, METADATA, EDIT, ANNOTATE, ADD BG, CROP, REDACT
 * For other image inputs the image list drops the input's own format, which
 * reproduces the JPG order exactly for JPG inputs.
 */
export const PDF_CONVERT_ORDER: readonly ActionId[] = ['convert.docx', 'convert.jpeg', 'convert.png', 'convert.txt'];

export const IMAGE_CONVERT_ORDER: readonly ActionId[] = [
  'convert.jpeg',
  'convert.png',
  'convert.webp',
  'convert.heic',
  'convert.tiff',
  'convert.avif',
  'convert.bmp',
  'convert.pdf',
  'convert.docx',
];

export const IMAGE_TOOLS_ORDER: readonly ActionId[] = [
  'tool.compress',
  'tool.metadata',
  'tool.edit',
  'tool.annotate',
  'tool.addBackground',
  'tool.crop',
  'tool.redact',
];

/**
 * Which menu a set of dragged files gets.
 *  - 'pdf'           one or more PDFs
 *  - 'image/<fmt>'   one or more images that all share one format
 *  - 'images'        several images with different formats
 *  - 'mixed'         PDFs and images together
 */
export type MenuKey = 'pdf' | `image/${ImageFormat}` | 'images' | 'mixed';

export const MENU_KEYS: readonly MenuKey[] = [
  'pdf',
  ...IMAGE_FORMATS.map((f) => `image/${f}` as const),
  'images',
  'mixed',
];

/**
 * Classify the formats of a selection. `undefined` entries (unknown or
 * unsupported files) make the whole selection unsupported: the wheel must not
 * offer an action that would silently skip files.
 */
export function menuKeyFor(formats: readonly (FileFormat | undefined)[]): MenuKey | null {
  if (formats.length === 0) return null;
  let pdf = 0;
  const images = new Set<ImageFormat>();
  for (const format of formats) {
    if (format === undefined) return null;
    const kind = inputKindOf(format);
    if (kind === 'pdf') pdf += 1;
    else if (kind === 'image') images.add(format as ImageFormat);
    else return null;
  }
  if (pdf > 0 && images.size > 0) return 'mixed';
  if (pdf > 0) return 'pdf';
  if (images.size === 1) return `image/${[...images][0] as ImageFormat}`;
  return 'images';
}

/** Sector order for a menu before capability filtering. */
export function baseMenuOrder(key: MenuKey, mode: WheelMode): ActionId[] {
  if (key === 'pdf') return mode === 'convert' ? [...PDF_CONVERT_ORDER] : [];
  if (key === 'mixed') {
    // Only actions that accept both PDFs and images, in PDF menu order.
    return mode === 'convert'
      ? PDF_CONVERT_ORDER.filter((id) => ACTIONS[id].inputs.includes('image') && ACTIONS[id].inputs.includes('pdf'))
      : [];
  }
  if (mode === 'tools') return [...IMAGE_TOOLS_ORDER];
  if (key === 'images') return [...IMAGE_CONVERT_ORDER];
  const own = key.slice('image/'.length) as ImageFormat;
  return IMAGE_CONVERT_ORDER.filter((id) => id !== `convert.${own}`);
}

/** One slice of the wheel as shown to the user. */
export interface WheelSector {
  readonly actionId: ActionId;
  readonly label: string;
  readonly icon: IconId | null;
  /** False when the bundled engines cannot run this action; drop is rejected. */
  readonly enabled: boolean;
  /** Why the sector is disabled (shown in the center capsule on hover). */
  readonly reason?: string;
  /** Whether the action accepts several files at once. Helpers disable non-batch sectors for multi-file drags. */
  readonly batch: boolean;
}

export interface WheelMenu {
  readonly key: MenuKey;
  readonly mode: WheelMode;
  readonly sectors: readonly WheelSector[];
}
