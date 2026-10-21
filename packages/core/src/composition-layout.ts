import {
  COMPOSITION_LIMITS,
  OrbitError,
  type CompositionLayout,
  type CompositionSpec,
  type Insets,
  type OutputRatio,
  type ShadowLayout,
} from '@orbitdrop/contracts';

/**
 * Add Background layout (spec §7). Pure and browser-safe: used by the
 * processors for the final export and the preview, and by the renderer to show
 * the output size and explain why margins grew.
 *
 * Units: every input value (padding, cornerRadius, shadow, maxEdge) and every
 * output value is in FINAL OUTPUT PIXELS. The content size passed in is the
 * oriented size of the source image (after EXIF orientation).
 *
 * ── Shadow model ─────────────────────────────────────────────────────────────
 * The shadow slider value S (0..400 px) is "how far the shadow reaches below the
 * image". It is a blurred copy of the (rounded) content rect, filled black:
 *     blurSigma σ = S / 4,   offsetY = S / 4 (downwards),   opacity = 0.35
 * A Gaussian is treated as reaching 3σ (beyond that it contributes < 0.05 % of
 * its peak, invisible in 8-bit output), so the visible shadow extends outside
 * the content rect by
 *     top    = ceil(3σ − offsetY) = ceil(S / 2)
 *     left   = right = ceil(3σ)   = ceil(3S / 4)
 *     bottom = ceil(3σ + offsetY) = S
 * S = 0 disables the shadow (shadow = null).
 *
 * ── Margins ─────────────────────────────────────────────────────────────────
 * Padding P is the MINIMUM margin. To keep the content centred and the shadow
 * unclipped, the minimum horizontal margin is mx = max(P, extent.left,
 * extent.right) and the minimum vertical margin my = max(P, extent.top,
 * extent.bottom) (same value on both sides of an axis). If the shadow needs more
 * than P, `paddingExpandedByShadow` is true.
 *
 * ── Canvas limit (maxEdge M) ────────────────────────────────────────────────
 * The canvas's longest edge never exceeds M. Per axis the canvas may be at most
 *     auto:          Lw = M,        Lh = M
 *     ratio a:b ≥ 1: Lw = M,        Lh = M·b/a   (width is the long edge)
 *     ratio a:b < 1: Lw = M·a/b,    Lh = M       (height is the long edge)
 * Padding/corners/shadow keep their pixel values; only the content shrinks:
 *     scale = min(1, (Lw − 2·mx) / W0, (Lh − 2·my) / H0)       (never > 1: no upscaling)
 *
 * ── Padding larger than the canvas allows ───────────────────────────────────
 * If honouring the margins would shrink the content below
 *     minScale = min(1, f·Lw / W0, f·Lh / H0),   f = MIN_CONTENT_FRACTION = 0.2
 * (i.e. below its natural size or 20 % of the canvas limit, whichever is
 * smaller) — which includes every case where 2·P alone exceeds M — padding and
 * shadow are reduced by one common factor t so that the content keeps minScale:
 *     t = min((Lw − W0·minScale) / (2·mx), (Lh − H0·minScale) / (2·my))
 *     P' = floor(P·t), S' = floor(S·t)        (then margins are recomputed)
 * `computeCompositionLayoutDetails` reports this (`paddingReducedByMaxEdge`,
 * `effectivePadding`, `effectiveShadow`); the plain layout shows it as
 * margins smaller than the requested padding.
 *
 * ── Integer rounding (all canvas/content values are integers) ───────────────
 *  1. Content: cw = floor(W0·scale), ch = floor(H0·scale), each clamped to
 *     [1, W0] / [1, H0]. With scale = 1 the content is exactly the source size
 *     (no resampling). Flooring guarantees canvas ≤ M after rounding.
 *  2. Canvas: auto → (cw + 2·mx, ch + 2·my). Fixed ratio → start from that
 *     minimum (CWmin, CHmin); if CWmin/CHmin ≥ a/b the width is kept and
 *     CH = round(CW·b/a), otherwise CH is kept and CW = round(CH·a/b). The
 *     rounded side is never below its minimum, so content + padding is
 *     contained (never cropped); the ratio is exact to within 0.5 px.
 *  3. Position: x = floor((CW − cw) / 2), y = floor((CH − ch) / 2); an odd
 *     remainder goes to the right/bottom margin.
 *  4. `paddingExpandedByRatio` is true when a fixed ratio grew one axis by at
 *     least 2 px beyond its minimum (≥ 1 px per side); a 1 px difference is
 *     only rounding.
 *  5. Corner radius: min(cornerRadius, floor(min(cw, ch) / 2)).
 *  6. contentScale = cw / W0 when W0 ≥ H0, else ch / H0 (the long side, which
 *     carries the smallest relative rounding error).
 *
 * `scaleCompositionLayout(layout, k)` produces the same composition at k ≤ 1
 * (previews): canvas = round(size·k); the content rect is rounded by its edges
 * (x0 = round(x·k), x1 = round((x + w)·k)) so margins + content add up to the
 * canvas exactly; radius, σ and offset are scaled without rounding; shadow
 * extents are ceil(extent·k); flags are unchanged.
 */

export type CompositionLayoutSpec = Pick<CompositionSpec, 'padding' | 'cornerRadius' | 'shadow' | 'ratio' | 'maxEdge'>;

/** σ = S × SHADOW_SIGMA_PER_PX. */
export const SHADOW_SIGMA_PER_PX = 0.25;
/** offsetY = S × SHADOW_OFFSET_PER_PX (downwards). */
export const SHADOW_OFFSET_PER_PX = 0.25;
export const SHADOW_OPACITY = 0.35;
/** The shadow is considered to reach this many sigmas beyond its shape. */
export const SHADOW_EXTENT_SIGMAS = 3;
/** Smallest share of the canvas limit the content keeps when padding is too large (unless it is naturally smaller). */
export const MIN_CONTENT_FRACTION = 0.2;

const EPS = 1e-9;

export interface CompositionLayoutDetails {
  readonly layout: CompositionLayout;
  /** Padding used (smaller than requested only when maxEdge forced a reduction). */
  readonly effectivePadding: number;
  /** Shadow slider value used (smaller than requested only when maxEdge forced a reduction). */
  readonly effectiveShadow: number;
  /** True when padding/shadow were reduced because they did not fit within maxEdge. */
  readonly paddingReducedByMaxEdge: boolean;
}

function ceilPx(value: number): number {
  return Math.max(0, Math.ceil(value - EPS));
}

function clampInt(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value)) throw new OrbitError('INVALID_OPTIONS', `Composition ${name} must be a finite number`);
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Shadow parameters for a slider value, in final output pixels; null when disabled. */
export function shadowFromSlider(size: number): ShadowLayout | null {
  const s = Math.max(0, size);
  if (!(s > 0)) return null;
  const blurSigma = s * SHADOW_SIGMA_PER_PX;
  const offsetY = s * SHADOW_OFFSET_PER_PX;
  const reach = SHADOW_EXTENT_SIGMAS * blurSigma;
  return {
    blurSigma,
    offsetY,
    opacity: SHADOW_OPACITY,
    extent: {
      top: ceilPx(reach - offsetY),
      right: ceilPx(reach),
      bottom: ceilPx(reach + offsetY),
      left: ceilPx(reach),
    },
  };
}

/** Width:height of a fixed output ratio as integers, or null for 'auto'. */
export function ratioParts(ratio: OutputRatio): readonly [number, number] | null {
  switch (ratio) {
    case 'auto':
      return null;
    case '1:1':
      return [1, 1];
    case '16:9':
      return [16, 9];
    case '4:5':
      return [4, 5];
    default: {
      const exhaustive: never = ratio;
      throw new OrbitError('INVALID_OPTIONS', `Unknown output ratio ${String(exhaustive)}`);
    }
  }
}

interface MarginNeeds {
  readonly mx: number;
  readonly my: number;
  readonly shadow: ShadowLayout | null;
}

function marginNeeds(padding: number, shadowSize: number): MarginNeeds {
  const shadow = shadowFromSlider(shadowSize);
  const mx = Math.max(padding, shadow?.extent.left ?? 0, shadow?.extent.right ?? 0);
  const my = Math.max(padding, shadow?.extent.top ?? 0, shadow?.extent.bottom ?? 0);
  return { mx, my, shadow };
}

/**
 * Full layout computation with the information the editor needs to explain the
 * result (see the file comment for the math).
 */
export function computeCompositionLayoutDetails(
  contentWidth: number,
  contentHeight: number,
  spec: CompositionLayoutSpec,
): CompositionLayoutDetails {
  if (!Number.isFinite(contentWidth) || !Number.isFinite(contentHeight) || contentWidth < 1 || contentHeight < 1) {
    throw new OrbitError('INVALID_OPTIONS', 'Content size must be at least 1×1 pixel');
  }
  const w0 = Math.floor(contentWidth);
  const h0 = Math.floor(contentHeight);
  const padding = clampInt(spec.padding, COMPOSITION_LIMITS.padding.min, COMPOSITION_LIMITS.padding.max, 'padding');
  const radius = clampInt(spec.cornerRadius, COMPOSITION_LIMITS.cornerRadius.min, COMPOSITION_LIMITS.cornerRadius.max, 'cornerRadius');
  const shadowSize = clampInt(spec.shadow, COMPOSITION_LIMITS.shadow.min, COMPOSITION_LIMITS.shadow.max, 'shadow');
  const maxEdge = clampInt(spec.maxEdge, COMPOSITION_LIMITS.maxEdge.min, COMPOSITION_LIMITS.maxEdge.max, 'maxEdge');
  const parts = ratioParts(spec.ratio);

  // Per-axis canvas limits (exact for integer maxEdge where possible).
  let limitW = maxEdge;
  let limitH = maxEdge;
  if (parts) {
    const [a, b] = parts;
    if (a >= b) limitH = (maxEdge * b) / a;
    else limitW = (maxEdge * a) / b;
  }

  const fitScale = (needs: MarginNeeds): number => Math.min(1, (limitW - 2 * needs.mx) / w0, (limitH - 2 * needs.my) / h0);

  // Smallest acceptable content: natural size, or MIN_CONTENT_FRACTION of the limit along the limiting axis.
  const minScale = Math.min(1, (MIN_CONTENT_FRACTION * limitW) / w0, (MIN_CONTENT_FRACTION * limitH) / h0);
  const minCw = Math.max(1, w0 * minScale);
  const minCh = Math.max(1, h0 * minScale);
  const fits = (needs: MarginNeeds): boolean => limitW - 2 * needs.mx >= minCw - EPS && limitH - 2 * needs.my >= minCh - EPS;

  let effPadding = padding;
  let effShadow = shadowSize;
  let needs = marginNeeds(effPadding, effShadow);
  let reduced = false;
  if (!fits(needs)) {
    reduced = true;
    const tx = needs.mx > 0 ? (limitW - minCw) / (2 * needs.mx) : Number.POSITIVE_INFINITY;
    const ty = needs.my > 0 ? (limitH - minCh) / (2 * needs.my) : Number.POSITIVE_INFINITY;
    const t = Math.max(0, Math.min(1, tx, ty));
    effPadding = Math.floor(padding * t + EPS);
    effShadow = Math.floor(shadowSize * t + EPS);
    needs = marginNeeds(effPadding, effShadow);
    // Extents are rounded up, so the scaled values may still miss by a pixel or two.
    while (!fits(needs) && (effPadding > 0 || effShadow > 0)) {
      effPadding = Math.max(0, effPadding - 1);
      effShadow = Math.max(0, effShadow - 1);
      needs = marginNeeds(effPadding, effShadow);
    }
  }

  const scale = Math.max(0, fitScale(needs));
  const cw = Math.min(w0, Math.max(1, Math.floor(w0 * scale + EPS)));
  const ch = Math.min(h0, Math.max(1, Math.floor(h0 * scale + EPS)));

  let { mx, my } = needs;
  let canvasW = 0;
  let canvasH = 0;
  let minW = 0;
  let minH = 0;
  // Normally a single pass; the loop only guards degenerate inputs (e.g. 1 px tall
  // panoramas with huge padding) where rounding could still overflow maxEdge.
  for (;;) {
    minW = cw + 2 * mx;
    minH = ch + 2 * my;
    if (!parts) {
      canvasW = minW;
      canvasH = minH;
    } else {
      const [a, b] = parts;
      if (minW * b >= minH * a) {
        canvasW = minW;
        canvasH = Math.max(minH, Math.round((minW * b) / a));
      } else {
        canvasH = minH;
        canvasW = Math.max(minW, Math.round((minH * a) / b));
      }
    }
    if (Math.max(canvasW, canvasH) <= maxEdge || (mx === 0 && my === 0)) break;
    reduced = true;
    mx = Math.max(0, mx - 1);
    my = Math.max(0, my - 1);
  }

  const x = Math.floor((canvasW - cw) / 2);
  const y = Math.floor((canvasH - ch) / 2);
  const margins: Insets = { top: y, right: canvasW - cw - x, bottom: canvasH - ch - y, left: x };
  const shadow = needs.shadow;

  const layout: CompositionLayout = {
    canvas: { width: canvasW, height: canvasH },
    content: { x, y, width: cw, height: ch },
    contentScale: w0 >= h0 ? cw / w0 : ch / h0,
    cornerRadius: Math.min(radius, Math.floor(Math.min(cw, ch) / 2)),
    shadow,
    margins,
    paddingExpandedByRatio: parts !== null && (canvasW - minW >= 2 || canvasH - minH >= 2),
    paddingExpandedByShadow: shadow !== null && (needs.mx > effPadding || needs.my > effPadding),
  };
  return { layout, effectivePadding: effPadding, effectiveShadow: effShadow, paddingReducedByMaxEdge: reduced };
}

/**
 * Computes where the image, shadow and background go for a composition, in final
 * output pixels. Used by the processors (final + preview) and the renderer
 * (explaining padding expansion and showing the output size).
 */
export function computeCompositionLayout(
  contentWidth: number,
  contentHeight: number,
  spec: Pick<CompositionSpec, 'padding' | 'cornerRadius' | 'shadow' | 'ratio' | 'maxEdge'>,
): CompositionLayout {
  return computeCompositionLayoutDetails(contentWidth, contentHeight, spec).layout;
}

/** Uniformly scale a layout (for previews). k ≤ 1. */
export function scaleCompositionLayout(layout: CompositionLayout, k: number): CompositionLayout {
  if (!Number.isFinite(k) || k <= 0) throw new OrbitError('INVALID_OPTIONS', 'Layout scale must be a positive number');
  if (k >= 1) return layout;
  const canvasW = Math.max(1, Math.round(layout.canvas.width * k));
  const canvasH = Math.max(1, Math.round(layout.canvas.height * k));
  const c = layout.content;
  const w = Math.min(canvasW, Math.max(1, Math.round((c.x + c.width) * k) - Math.round(c.x * k)));
  const h = Math.min(canvasH, Math.max(1, Math.round((c.y + c.height) * k) - Math.round(c.y * k)));
  const x = Math.max(0, Math.min(canvasW - w, Math.round(c.x * k)));
  const y = Math.max(0, Math.min(canvasH - h, Math.round(c.y * k)));
  const shadow: ShadowLayout | null = layout.shadow
    ? {
        blurSigma: layout.shadow.blurSigma * k,
        offsetY: layout.shadow.offsetY * k,
        opacity: layout.shadow.opacity,
        extent: {
          top: ceilPx(layout.shadow.extent.top * k),
          right: ceilPx(layout.shadow.extent.right * k),
          bottom: ceilPx(layout.shadow.extent.bottom * k),
          left: ceilPx(layout.shadow.extent.left * k),
        },
      }
    : null;
  return {
    canvas: { width: canvasW, height: canvasH },
    content: { x, y, width: w, height: h },
    contentScale: layout.contentScale * k,
    cornerRadius: Math.min(layout.cornerRadius * k, Math.min(w, h) / 2),
    shadow,
    margins: { top: y, right: canvasW - w - x, bottom: canvasH - h - y, left: x },
    paddingExpandedByRatio: layout.paddingExpandedByRatio,
    paddingExpandedByShadow: layout.paddingExpandedByShadow,
  };
}

/** Scale that fits a layout's canvas into a preview of at most `maxEdge` pixels (never above 1). */
export function previewScaleFor(layout: CompositionLayout, maxEdge: number): number {
  const longest = Math.max(layout.canvas.width, layout.canvas.height);
  return Math.min(1, Math.max(1, maxEdge) / longest);
}
