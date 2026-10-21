import { OrbitError, type PreviewRequest, type PreviewResult } from '@orbitdrop/contracts';
import { previewAddBackground } from './add-background';
import { previewAnnotate } from './annotate';
import { encodePreview, requireImageInput, throwIfCancelled, toToolError } from './common';
import { previewCompress } from './compress';
import { previewCrop } from './crop';
import { previewEdit } from './edit';
import { previewRedact } from './redact';
import { getScaledSource } from './source-cache';

/**
 * Editor previews. Every tool preview is rendered by the same code as the final
 * export (same option parsing, same drawing/composition functions), only from
 * a downscaled decode of the source (cached per file + size, see
 * source-cache.ts). Cancellation is checked between steps.
 *
 * 'source': the oriented image fitted into maxEdge (never upscaled), sRGB,
 * JPEG (quality 90) or PNG when it has transparent pixels; sourceWidth/Height
 * are the oriented full-size dimensions for mapping editor coordinates.
 */
export async function previewSource(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult> {
  try {
    const maxEdge = Math.max(16, Math.floor(request.maxEdge));
    const source = await getScaledSource(request.input, request.limits, () => maxEdge, signal);
    throwIfCancelled(signal);
    const preview = await encodePreview(source);
    return {
      ...preview,
      sourceWidth: source.sourceWidth,
      sourceHeight: source.sourceHeight,
      outputWidth: source.sourceWidth,
      outputHeight: source.sourceHeight,
    };
  } catch (error) {
    throw toToolError(error, signal);
  }
}

export async function renderToolPreview(request: PreviewRequest, ctx: { readonly signal: AbortSignal }): Promise<PreviewResult> {
  const { signal } = ctx;
  throwIfCancelled(signal);
  requireImageInput(request.input);
  if (!Number.isFinite(request.maxEdge) || request.maxEdge < 1) throw new OrbitError('INVALID_OPTIONS', 'Preview size must be positive');
  switch (request.kind) {
    case 'source':
      return previewSource(request, signal);
    case 'tool.addBackground':
      return previewAddBackground(request, signal);
    case 'tool.crop':
      return previewCrop(request, signal);
    case 'tool.edit':
      return previewEdit(request, signal);
    case 'tool.compress':
      return previewCompress(request, signal);
    case 'tool.annotate':
      return previewAnnotate(request, signal);
    case 'tool.redact':
      return previewRedact(request, signal);
    default: {
      const kind: never = request.kind;
      throw new OrbitError('INVALID_OPTIONS', `Unknown preview kind ${String(kind)}`);
    }
  }
}
