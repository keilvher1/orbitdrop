import type { PreviewRequest, PreviewResult } from '@orbitdrop/contracts';
import { encodePreview, loadImage, throwIfCancelled, toRaw, toToolError } from './common';

/**
 * 'thumbnail': a small oriented sRGB image of an input for file lists (the
 * images → PDF order editor). Decoded on its own, never through the editors'
 * source cache (source-cache.ts), so a long list of files cannot evict the
 * large decodes an open editor relies on. Never upscaled; options are ignored.
 * JPEG (quality 90), or PNG when the image has transparent pixels.
 */
export async function previewThumbnail(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult> {
  try {
    const edge = Math.max(1, Math.floor(request.maxEdge));
    const image = await loadImage(request.input, request.limits, signal);
    throwIfCancelled(signal);
    const raw = await toRaw(
      image
        .open()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .ensureAlpha(),
    );
    throwIfCancelled(signal);
    const preview = await encodePreview(raw);
    return { ...preview, sourceWidth: image.width, sourceHeight: image.height };
  } catch (error) {
    throw toToolError(error, signal);
  }
}
