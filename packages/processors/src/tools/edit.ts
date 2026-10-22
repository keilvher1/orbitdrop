import type { Sharp } from 'sharp';
import type { EditOptions, PreviewRequest, PreviewResult, ProcessorJob, ProcessorResult, ProcessorRunContext } from '@orbitdrop/contracts';
import {
  encodePreview,
  encodeToolImage,
  framesWarnings,
  loadImage,
  parseToolOptions,
  regionHasTransparency,
  requireImageInput,
  sharpFromRaw,
  singleInput,
  stage,
  throwIfCancelled,
  toRaw,
  toToolError,
  toolOutputFormat,
  writeToolOutput,
} from './common';
import { getScaledSource } from './source-cache';

/**
 * Edit (P1): rotate 0/90/180/270 (clockwise), flips, brightness/contrast/saturation.
 *
 * Geometry: the rotation is applied to the oriented image first; flipH/flipV
 * then mirror what the user sees after the rotation (screen space).
 *
 * Tone mapping (CSS filter semantics on 8-bit sRGB-encoded values, so the
 * renderer may approximate it instantly with
 * `filter: brightness(kb) contrast(kc) saturate(ks)`; 0 = identity):
 *   kb = 1 + brightness/100   (−100 → black, +100 → ×2)      out = in·kb
 *   kc = 1 + contrast/100     (−100 → flat grey, +100 → ×2)  out = (in − ½)·kc + ½
 *   ks = 1 + saturation/100   (−100 → greyscale, +100 → ×2)  CSS saturate() matrix
 *                                                            (luma 0.213/0.715/0.072)
 * Brightness and contrast are folded into one linear op a·x + b with
 * a = kb·kc, b = 127.5·(1 − kc). Pipelines from `loadImage` are always 8-bit
 * (16-bit inputs are normalized at load), which matters: sharp runs recomb
 * before linear and recomb casts to 8-bit sRGB, so a 16-bit offset would land
 * on 8-bit data. The saturation matrix rows sum to 1, so it commutes with the
 * linear op (results only differ where values clip). Alpha is untouched.
 */

/** CSS `saturate(s)` colour matrix (Filter Effects Level 1). */
export function saturationMatrix(s: number): [[number, number, number], [number, number, number], [number, number, number]] {
  return [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ];
}

export function editedSize(width: number, height: number, rotate: EditOptions['rotate']): { width: number; height: number } {
  return rotate === 90 || rotate === 270 ? { width: height, height: width } : { width, height };
}

/**
 * Apply an edit to an oriented pipeline. sharp 0.35 applies flip()/flop()
 * before an explicit rotate() whatever the call order (pinned by the
 * tools-edit tests), so the screen-space flips are mapped to pre-rotation
 * mirrors: for 90°/270° a horizontal mirror after the rotation is a vertical
 * mirror before it (R⁻¹·H·R = V); for 0°/180° they are unchanged.
 */
export function applyEdit(pipeline: Sharp, options: EditOptions, info: { grey: boolean }): Sharp {
  let p = pipeline;
  const swap = options.rotate === 90 || options.rotate === 270;
  const mirrorLeftRight = swap ? options.flipV : options.flipH;
  const mirrorTopBottom = swap ? options.flipH : options.flipV;
  if (options.rotate !== 0) p = p.rotate(options.rotate);
  if (mirrorLeftRight) p = p.flop();
  if (mirrorTopBottom) p = p.flip();
  const kb = 1 + options.brightness / 100;
  const kc = 1 + options.contrast / 100;
  const ks = 1 + options.saturation / 100;
  const a = kb * kc;
  const b = 127.5 * (1 - kc);
  if (a !== 1 || b !== 0) p = p.linear(a, b);
  if (ks !== 1 && !info.grey) p = p.recomb(saturationMatrix(ks));
  return p;
}

export async function runEdit(job: ProcessorJob, ctx: ProcessorRunContext): Promise<ProcessorResult> {
  const { signal } = ctx;
  const input = singleInput(job);
  const options = parseToolOptions('tool.edit', job.options);
  try {
    stage(ctx.onProgress, 'reading');
    const image = await loadImage(input, job.limits, signal);
    const format = await toolOutputFormat(options.outputFormat, input.format);
    const info = { grey: image.grey };
    throwIfCancelled(signal);
    stage(ctx.onProgress, 'rendering');
    const encoded = await encodeToolImage(() => applyEdit(image.open(), options, info), {
      format,
      settings: job.settings,
      quality: options.quality,
      hasAlpha: image.hasAlpha,
      flattenBackground: '#FFFFFF',
      keepIcc: image.keepIcc,
    });
    const warnings = framesWarnings(image);
    if (encoded.flattened && (await regionHasTransparency(image))) warnings.push({ code: 'ALPHA_FLATTENED', params: { background: '#FFFFFF' } });
    stage(ctx.onProgress, 'writing');
    const output = await writeToolOutput(job, input, encoded, signal, ctx.onCommitted);
    return { outputs: [output], warnings };
  } catch (error) {
    throw toToolError(error, signal);
  }
}

export async function previewEdit(request: PreviewRequest, signal: AbortSignal): Promise<PreviewResult> {
  const options = parseToolOptions('tool.edit', request.options);
  try {
    const maxEdge = Math.max(16, Math.floor(request.maxEdge));
    const source = await getScaledSource(request.input, request.limits, () => maxEdge, signal);
    throwIfCancelled(signal);
    const raw = await toRaw(applyEdit(sharpFromRaw(source), options, { grey: false }));
    const preview = await encodePreview(raw);
    const out = editedSize(source.sourceWidth, source.sourceHeight, options.rotate);
    return {
      ...preview,
      sourceWidth: source.sourceWidth,
      sourceHeight: source.sourceHeight,
      outputWidth: out.width,
      outputHeight: out.height,
      outputFormat: await toolOutputFormat(options.outputFormat, requireImageInput(request.input).format),
    };
  } catch (error) {
    throw toToolError(error, signal);
  }
}
