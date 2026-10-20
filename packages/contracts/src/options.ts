import { z } from 'zod';
import type { ActionId } from './actions';
import { CompositionSpecSchema } from './composition';
import { HexColor, Id, PixelRect, Quality } from './schemas';

/**
 * Option schemas per action. Main validates every request from the renderer
 * against these before a job is created; processors validate again before
 * running (defense in depth across the process boundary).
 *
 * All coordinates are integer pixels in the *oriented* source image, i.e. after
 * applying EXIF orientation, which is what the user sees in the editor.
 */

/** Result format for tools that keep the input format by default. */
export const ToolOutputFormat = z.enum(['input', 'png', 'jpeg', 'webp']);
export type ToolOutputFormat = z.infer<typeof ToolOutputFormat>;

/** Shared by every convert.* action; each executor reads the fields that apply. */
export const ConvertOptionsSchema = z.strictObject({
  /** Lossy encoders (JPEG/WebP/AVIF/HEIC). Defaults come from settings. */
  quality: Quality.optional(),
  /** Used when the target cannot store alpha (JPEG, 24-bit BMP) or for PDF pages. */
  flattenBackground: HexColor.default('#FFFFFF'),
  /** Keep EXIF/XMP/ICC in image→image conversions. Orientation is always applied to pixels. */
  keepMetadata: z.boolean().default(false),
  /** PDF → image rendering resolution. */
  dpi: z.union([z.literal(150), z.literal(300)]).optional(),
  /** Images → PDF: page size and margin (points). */
  pageSize: z.enum(['image', 'a4', 'letter']).default('image'),
  marginPt: z.number().min(0).max(144).default(0),
  /** Images → PDF: confirmed order of fileIds (all files of the selection exactly once). */
  order: z.array(Id).max(500).optional(),
  /** PDF → TXT page separation. */
  pageSeparator: z.enum(['marker', 'formfeed', 'blank']).default('marker'),
});
export type ConvertOptions = z.infer<typeof ConvertOptionsSchema>;

export const ASPECT_RATIOS = ['free', '1:1', '16:9', '9:16', '4:3', '3:4'] as const;
export type AspectRatioId = (typeof ASPECT_RATIOS)[number];

export const CropOptionsSchema = z.strictObject({
  rect: PixelRect,
  aspect: z.enum(ASPECT_RATIOS).default('free'),
  outputFormat: ToolOutputFormat.default('input'),
  quality: Quality.optional(),
  /** Fill for transparent pixels when the output is JPEG. */
  flattenBackground: HexColor.default('#FFFFFF'),
});
export type CropOptions = z.infer<typeof CropOptionsSchema>;

export const AddBackgroundOptionsSchema = CompositionSpecSchema;
export type AddBackgroundOptions = z.infer<typeof AddBackgroundOptionsSchema>;

export const CompressOptionsSchema = z.strictObject({
  format: z.enum(['input', 'jpeg', 'webp', 'png']).default('input'),
  quality: Quality.default(75),
  /** Downscale so the longest edge is at most this many pixels; null keeps the size. */
  maxEdge: z.number().int().min(16).max(30000).nullable().default(null),
  /** PNG: 'palette' quantizes to ≤256 colours (lossy), 'lossless' only recompresses. */
  pngMode: z.enum(['palette', 'lossless']).default('palette'),
  keepMetadata: z.boolean().default(false),
});
export type CompressOptions = z.infer<typeof CompressOptionsSchema>;

export const MetadataOptionsSchema = z.strictObject({
  mode: z.literal('strip'),
  /**
   * 'convertToSrgb': convert pixels to sRGB and drop the profile (default, safest for sharing).
   * 'keep': keep the embedded ICC profile, drop everything else (EXIF, XMP, IPTC, thumbnails).
   */
  iccPolicy: z.enum(['convertToSrgb', 'keep']).default('convertToSrgb'),
  outputFormat: ToolOutputFormat.default('input'),
});
export type MetadataOptions = z.infer<typeof MetadataOptionsSchema>;

export const EditOptionsSchema = z.strictObject({
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  flipH: z.boolean().default(false),
  flipV: z.boolean().default(false),
  /** -100..100, 0 = unchanged */
  brightness: z.number().min(-100).max(100).default(0),
  contrast: z.number().min(-100).max(100).default(0),
  saturation: z.number().min(-100).max(100).default(0),
  outputFormat: ToolOutputFormat.default('input'),
  quality: Quality.optional(),
});
export type EditOptions = z.infer<typeof EditOptionsSchema>;

const Coord = z.number().min(-100000).max(100000);

export const AnnotationShapeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    id: Id,
    type: z.literal('rect'),
    x: Coord,
    y: Coord,
    width: z.number().min(1).max(100000),
    height: z.number().min(1).max(100000),
    color: HexColor,
    strokeWidth: z.number().min(1).max(400),
  }),
  z.strictObject({
    id: Id,
    type: z.literal('arrow'),
    x1: Coord,
    y1: Coord,
    x2: Coord,
    y2: Coord,
    color: HexColor,
    strokeWidth: z.number().min(1).max(400),
  }),
  z.strictObject({
    id: Id,
    type: z.literal('text'),
    /** Top-left of the text box. */
    x: Coord,
    y: Coord,
    text: z.string().min(1).max(2000),
    color: HexColor,
    fontSize: z.number().min(6).max(2000),
    bold: z.boolean().default(true),
  }),
]);
export type AnnotationShape = z.infer<typeof AnnotationShapeSchema>;

export const AnnotateOptionsSchema = z.strictObject({
  shapes: z.array(AnnotationShapeSchema).min(1).max(500),
  outputFormat: ToolOutputFormat.default('input'),
  quality: Quality.optional(),
});
export type AnnotateOptions = z.infer<typeof AnnotateOptionsSchema>;

export const RedactRegionSchema = z.strictObject({
  id: Id,
  rect: PixelRect,
  /** 'solid' paints an opaque box. 'mosaic' pixelates (not a guaranteed removal of information). */
  style: z.enum(['solid', 'mosaic']),
  color: HexColor.default('#000000'),
  /** Mosaic block size in pixels. */
  blockSize: z.number().int().min(4).max(256).default(16),
});
export type RedactRegion = z.infer<typeof RedactRegionSchema>;

export const RedactOptionsSchema = z.strictObject({
  regions: z.array(RedactRegionSchema).min(1).max(200),
  outputFormat: ToolOutputFormat.default('input'),
  quality: Quality.optional(),
});
export type RedactOptions = z.infer<typeof RedactOptionsSchema>;

export const ACTION_OPTION_SCHEMAS = {
  'convert.jpeg': ConvertOptionsSchema,
  'convert.png': ConvertOptionsSchema,
  'convert.webp': ConvertOptionsSchema,
  'convert.heic': ConvertOptionsSchema,
  'convert.tiff': ConvertOptionsSchema,
  'convert.avif': ConvertOptionsSchema,
  'convert.bmp': ConvertOptionsSchema,
  'convert.pdf': ConvertOptionsSchema,
  'convert.docx': ConvertOptionsSchema,
  'convert.txt': ConvertOptionsSchema,
  'tool.compress': CompressOptionsSchema,
  'tool.metadata': MetadataOptionsSchema,
  'tool.edit': EditOptionsSchema,
  'tool.annotate': AnnotateOptionsSchema,
  'tool.addBackground': AddBackgroundOptionsSchema,
  'tool.crop': CropOptionsSchema,
  'tool.redact': RedactOptionsSchema,
} as const satisfies Record<ActionId, z.ZodType>;

export type ActionOptions<A extends ActionId> = z.infer<(typeof ACTION_OPTION_SCHEMAS)[A]>;

/** Parse options for an action; throws a ZodError on invalid input. */
export function parseActionOptions<A extends ActionId>(actionId: A, raw: unknown): ActionOptions<A> {
  return ACTION_OPTION_SCHEMAS[actionId].parse(raw ?? {}) as ActionOptions<A>;
}
