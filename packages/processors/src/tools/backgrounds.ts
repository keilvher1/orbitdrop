import { BACKGROUND_PRESETS, type BackgroundPreset, type GradientLayer, type GradientStop } from '@orbitdrop/contracts';

/**
 * Background presets → SVG, rendered by sharp (librsvg) at the exact canvas size.
 *
 * Linear layers follow CSS `linear-gradient(<angle>deg, …)` on the W×H canvas:
 * the gradient line passes through the centre with direction
 * (sin θ, −cos θ) (0° = towards the top, 90° = towards the right, y down) and
 * length |W·sin θ| + |H·cos θ|, so the 0 % and 100 % stops fall exactly on the
 * corners and lines of equal colour are perpendicular to the angle in pixel
 * space, also on non-square canvases (not stretched like objectBoundingBox).
 * Radial layers: centre (cx·W, cy·H), radius r·max(W, H), circular.
 */

export interface GradientLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export function cssLinearGradientLine(angleDeg: number, width: number, height: number): GradientLine {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const cx = width / 2;
  const cy = height / 2;
  return { x1: cx - dx * half, y1: cy - dy * half, x2: cx + dx * half, y2: cy + dy * half };
}

export function findPreset(id: string): BackgroundPreset | undefined {
  return BACKGROUND_PRESETS.find((p) => p.id === id);
}

const num = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));

function stopAttrs(stop: GradientStop): string {
  const hex = stop.color.replace('#', '');
  const rgb = hex.slice(0, 6);
  const alpha = hex.length >= 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  const offset = Math.min(1, Math.max(0, stop.offset));
  return `offset="${num(offset)}" stop-color="#${rgb}" stop-opacity="${num(alpha)}"`;
}

function layerDef(layer: GradientLayer, id: string, width: number, height: number): string {
  const stops = layer.stops.map((s) => `<stop ${stopAttrs(s)}/>`).join('');
  if (layer.type === 'linear') {
    const l = cssLinearGradientLine(layer.angleDeg, width, height);
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(l.x1)}" y1="${num(l.y1)}" x2="${num(l.x2)}" y2="${num(l.y2)}">${stops}</linearGradient>`;
  }
  const r = layer.r * Math.max(width, height);
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(layer.cx * width)}" cy="${num(layer.cy * height)}" r="${num(r)}">${stops}</radialGradient>`;
}

/** SVG document for a preset at an exact pixel size. */
export function presetSvg(preset: BackgroundPreset, width: number, height: number): string {
  const defs = preset.layers.map((layer, i) => layerDef(layer, `g${i}`, width, height)).join('');
  const rects = preset.layers.map((_, i) => `<rect width="${width}" height="${height}" fill="url(#g${i})"/>`).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>${defs}</defs><rect width="${width}" height="${height}" fill="${preset.base.slice(0, 7)}"/>${rects}</svg>`
  );
}

/** White rounded rectangle on transparency, used as a dest-in mask for the content. */
export function roundedRectMaskSvg(width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${num(r)}" ry="${num(r)}" fill="#fff"/></svg>`;
}

/** White rounded rect (shadow shape) on black inside a box, for the blurred shadow mask. */
export function shadowShapeSvg(
  boxWidth: number,
  boxHeight: number,
  rect: { x: number; y: number; width: number; height: number },
  radius: number,
): string {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${boxWidth}" height="${boxHeight}">` +
    `<rect width="${boxWidth}" height="${boxHeight}" fill="#000"/>` +
    `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.width)}" height="${num(rect.height)}" rx="${num(r)}" ry="${num(r)}" fill="#fff"/></svg>`
  );
}
