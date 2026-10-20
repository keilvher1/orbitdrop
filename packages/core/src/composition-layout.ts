import { OrbitError, type CompositionLayout, type CompositionSpec } from '@orbitdrop/contracts';

/**
 * Stub with the final signature; implemented by the processors-edit workstream.
 * Computes where the image, shadow and background go for a composition, in final
 * output pixels. Used by the processors (final + preview) and the renderer
 * (explaining padding expansion and showing the output size).
 */
export function computeCompositionLayout(
  _contentWidth: number,
  _contentHeight: number,
  _spec: Pick<CompositionSpec, 'padding' | 'cornerRadius' | 'shadow' | 'ratio' | 'maxEdge'>,
): CompositionLayout {
  throw new OrbitError('ENGINE_UNAVAILABLE', 'computeCompositionLayout not implemented yet');
}

/** Uniformly scale a layout (for previews). k ≤ 1. */
export function scaleCompositionLayout(_layout: CompositionLayout, _k: number): CompositionLayout {
  throw new OrbitError('ENGINE_UNAVAILABLE', 'scaleCompositionLayout not implemented yet');
}
