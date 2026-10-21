import type { BackgroundPreset, GradientLayer, GradientStop } from '@orbitdrop/contracts';
import type { CSSProperties } from 'react';

/**
 * CSS rendering of a BACKGROUND_PRESETS entry — used only for the small
 * swatches. The editor's big preview always comes from the processor
 * (requestPreview), never from this CSS.
 *
 * Mapping: presets paint `base` first and then `layers` in order (later on
 * top); CSS lists background layers top-first, so the layers are reversed and
 * `base` becomes background-color. Linear angles already use the CSS
 * convention. A radial layer's radius is a fraction of max(width, height), so
 * it is converted to px for the swatch size (CSS circles need a length).
 */
function stops(list: readonly GradientStop[]): string {
  return list.map((s) => `${s.color} ${Number((s.offset * 100).toFixed(2))}%`).join(', ');
}

export function gradientLayerCss(layer: GradientLayer, width: number, height: number): string {
  if (layer.type === 'linear') return `linear-gradient(${layer.angleDeg}deg, ${stops(layer.stops)})`;
  const radius = Math.max(0.5, layer.r * Math.max(width, height));
  return `radial-gradient(circle ${Number(radius.toFixed(2))}px at ${Number((layer.cx * 100).toFixed(2))}% ${Number((layer.cy * 100).toFixed(2))}%, ${stops(layer.stops)})`;
}

export function presetBackgroundStyle(preset: BackgroundPreset, width: number, height: number): CSSProperties {
  const layers = [...preset.layers].reverse().map((layer) => gradientLayerCss(layer, width, height));
  return { backgroundColor: preset.base, backgroundImage: layers.length > 0 ? layers.join(', ') : undefined };
}
