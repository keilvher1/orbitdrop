import { z } from 'zod';
import type { LocalizedText } from './actions';
import { HexColor, Id, Quality } from './schemas';
import type { Rect, Size } from './geometry';

/**
 * Add Background composition. The same spec drives the low-resolution preview
 * and the final export (both are rendered by @orbitdrop/processors from
 * `computeCompositionLayout` in @orbitdrop/core); the preview is never a
 * screenshot of the editor.
 */

export interface GradientStop {
  /** 0..1 */
  readonly offset: number;
  /** #RRGGBB or #RRGGBBAA */
  readonly color: string;
}

export type GradientLayer =
  | {
      readonly type: 'linear';
      /** CSS convention: 0 = towards the top, 90 = towards the right. */
      readonly angleDeg: number;
      readonly stops: readonly GradientStop[];
    }
  | {
      readonly type: 'radial';
      /** Center as a fraction of canvas width / height. */
      readonly cx: number;
      readonly cy: number;
      /** Radius as a fraction of max(canvas width, canvas height). */
      readonly r: number;
      readonly stops: readonly GradientStop[];
    };

export interface BackgroundPreset {
  readonly id: string;
  readonly label: LocalizedText;
  /** Solid base painted under the layers. */
  readonly base: string;
  /** Painted in order, later layers on top. */
  readonly layers: readonly GradientLayer[];
}

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  {
    id: 'ember',
    label: { ko: '노을', en: 'Ember' },
    base: '#F4503A',
    layers: [
      { type: 'radial', cx: 0.05, cy: 0.1, r: 0.75, stops: [{ offset: 0, color: '#FF3D7FFF' }, { offset: 1, color: '#FF3D7F00' }] },
      { type: 'radial', cx: 0.95, cy: 0.15, r: 0.7, stops: [{ offset: 0, color: '#FFD23FFF' }, { offset: 1, color: '#FFD23F00' }] },
      { type: 'radial', cx: 0.85, cy: 0.95, r: 0.7, stops: [{ offset: 0, color: '#A44CFFE6' }, { offset: 1, color: '#A44CFF00' }] },
    ],
  },
  {
    id: 'peach',
    label: { ko: '복숭아', en: 'Peach' },
    base: '#FFE9DC',
    layers: [{ type: 'linear', angleDeg: 160, stops: [{ offset: 0, color: '#FFFFFF' }, { offset: 1, color: '#FFC9A8' }] }],
  },
  {
    id: 'aurora',
    label: { ko: '오로라', en: 'Aurora' },
    base: '#FFE45C',
    layers: [
      { type: 'radial', cx: 0.0, cy: 0.0, r: 0.8, stops: [{ offset: 0, color: '#FF5FA2FF' }, { offset: 1, color: '#FF5FA200' }] },
      { type: 'radial', cx: 1.0, cy: 0.2, r: 0.7, stops: [{ offset: 0, color: '#4CD9A0FF' }, { offset: 1, color: '#4CD9A000' }] },
      { type: 'radial', cx: 0.5, cy: 1.1, r: 0.8, stops: [{ offset: 0, color: '#4C7DFFFF' }, { offset: 1, color: '#4C7DFF00' }] },
    ],
  },
  {
    id: 'cloud',
    label: { ko: '구름', en: 'Cloud' },
    base: '#EEF2F7',
    layers: [{ type: 'linear', angleDeg: 180, stops: [{ offset: 0, color: '#FFFFFF' }, { offset: 1, color: '#DCE4EE' }] }],
  },
  {
    id: 'lilac',
    label: { ko: '라일락', en: 'Lilac' },
    base: '#F3D9F2',
    layers: [{ type: 'linear', angleDeg: 135, stops: [{ offset: 0, color: '#FFC6E0' }, { offset: 1, color: '#C9B8FF' }] }],
  },
  {
    id: 'nebula',
    label: { ko: '성운', en: 'Nebula' },
    base: '#1D1B3A',
    layers: [
      { type: 'radial', cx: 0.15, cy: 0.2, r: 0.6, stops: [{ offset: 0, color: '#FF6A3DD9' }, { offset: 1, color: '#FF6A3D00' }] },
      { type: 'radial', cx: 0.85, cy: 0.3, r: 0.6, stops: [{ offset: 0, color: '#3DA9FFD9' }, { offset: 1, color: '#3DA9FF00' }] },
      { type: 'radial', cx: 0.5, cy: 1.0, r: 0.7, stops: [{ offset: 0, color: '#B44DFFD9' }, { offset: 1, color: '#B44DFF00' }] },
    ],
  },
  {
    id: 'ocean',
    label: { ko: '바다', en: 'Ocean' },
    base: '#2F7CF6',
    layers: [{ type: 'linear', angleDeg: 135, stops: [{ offset: 0, color: '#2F5BF6' }, { offset: 1, color: '#36D1DC' }] }],
  },
  {
    id: 'mint',
    label: { ko: '민트', en: 'Mint' },
    base: '#5FD3B5',
    layers: [{ type: 'linear', angleDeg: 135, stops: [{ offset: 0, color: '#1FA2A0' }, { offset: 1, color: '#B5F0A8' }] }],
  },
  {
    id: 'dusk',
    label: { ko: '황혼', en: 'Dusk' },
    base: '#E9D7F5',
    layers: [{ type: 'linear', angleDeg: 200, stops: [{ offset: 0, color: '#D6C8FF' }, { offset: 1, color: '#FFD9E8' }] }],
  },
];

export const SOLID_BACKGROUNDS: readonly string[] = [
  '#FFFFFF',
  '#F9D65C',
  '#A6D96A',
  '#2E9D5B',
  '#1E9E8A',
  '#38C1D6',
  '#3D6FE0',
  '#2B2F3A',
  '#7B4FD8',
];

export const OUTPUT_RATIOS = ['auto', '1:1', '16:9', '4:5'] as const;
export type OutputRatio = (typeof OUTPUT_RATIOS)[number];

export const BackgroundSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('solid'), color: HexColor }),
  z.strictObject({ kind: z.literal('preset'), presetId: z.string().min(1).max(32) }),
  /** A user-picked background image, registered by main (fileId), filled with "cover". */
  z.strictObject({ kind: z.literal('image'), fileId: Id }),
]);
export type Background = z.infer<typeof BackgroundSchema>;

export const COMPOSITION_LIMITS = {
  padding: { min: 0, max: 4000 },
  cornerRadius: { min: 0, max: 4000 },
  shadow: { min: 0, max: 400 },
  maxEdge: { min: 256, max: 8000, default: 2400 },
} as const;

export const CompositionSpecSchema = z.strictObject({
  background: BackgroundSchema,
  /** Minimum margin around the image, in final output pixels. */
  padding: z.number().int().min(COMPOSITION_LIMITS.padding.min).max(COMPOSITION_LIMITS.padding.max),
  /** Corner radius of the image, in final output pixels (clamped to half the short side). */
  cornerRadius: z.number().int().min(COMPOSITION_LIMITS.cornerRadius.min).max(COMPOSITION_LIMITS.cornerRadius.max),
  /** Shadow size in final output pixels; 0 disables the shadow. */
  shadow: z.number().int().min(COMPOSITION_LIMITS.shadow.min).max(COMPOSITION_LIMITS.shadow.max),
  ratio: z.enum(OUTPUT_RATIOS),
  /** Longest edge of the output canvas. The image is never upscaled. */
  maxEdge: z.number().int().min(COMPOSITION_LIMITS.maxEdge.min).max(COMPOSITION_LIMITS.maxEdge.max),
  format: z.enum(['png', 'jpeg']),
  quality: Quality,
});
export type CompositionSpec = z.infer<typeof CompositionSpecSchema>;

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ShadowLayout {
  /** Gaussian sigma in output pixels. */
  readonly blurSigma: number;
  readonly offsetY: number;
  /** 0..1 */
  readonly opacity: number;
  /** How far the visible shadow reaches outside the content rect on each side. */
  readonly extent: Insets;
}

/**
 * Result of `computeCompositionLayout` (in @orbitdrop/core). All values are in
 * output pixels of the rendering being produced (final or preview).
 */
export interface CompositionLayout {
  readonly canvas: Size;
  /** Where the (scaled) image is drawn. */
  readonly content: Rect;
  /** Scale applied to the oriented source image. Never above 1. */
  readonly contentScale: number;
  /** Clamped corner radius. */
  readonly cornerRadius: number;
  readonly shadow: ShadowLayout | null;
  /** Actual margins between the content rect and the canvas edges. */
  readonly margins: Insets;
  /** True when a fixed ratio made one direction's margin larger than `padding`. */
  readonly paddingExpandedByRatio: boolean;
  /** True when the shadow needed more room than `padding`. */
  readonly paddingExpandedByShadow: boolean;
}
