import {
  OrbitError,
  type ImageInfo,
  type PreviewRequest,
  type PreviewResult,
  type ProcessingLimits,
  type ProcessorInput,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorRunContext,
} from '@orbitdrop/contracts';
import { runAddBackground } from './add-background';
import { runAnnotate } from './annotate';
import { throwIfCancelled } from './common';
import { runCompress } from './compress';
import { runCrop } from './crop';
import { runEdit } from './edit';
import { inspectImage as inspect, runMetadata } from './metadata';
import { renderToolPreview as preview } from './preview';
import { runRedact } from './redact';

/**
 * tool.* executors, editor previews and image inspection (processors-edit
 * workstream). Entry points used by the dispatcher in ../index.ts.
 */
export async function runTool(job: ProcessorJob, ctx: ProcessorRunContext): Promise<ProcessorResult> {
  throwIfCancelled(ctx.signal);
  switch (job.actionId) {
    case 'tool.crop':
      return runCrop(job, ctx);
    case 'tool.addBackground':
      return runAddBackground(job, ctx);
    case 'tool.compress':
      return runCompress(job, ctx);
    case 'tool.metadata':
      return runMetadata(job, ctx);
    case 'tool.edit':
      return runEdit(job, ctx);
    case 'tool.annotate':
      return runAnnotate(job, ctx);
    case 'tool.redact':
      return runRedact(job, ctx);
    default:
      throw new OrbitError('INVALID_OPTIONS', `Not a tool action: ${job.actionId}`);
  }
}

export async function renderToolPreview(request: PreviewRequest, ctx: { signal: AbortSignal }): Promise<PreviewResult> {
  return preview(request, ctx);
}

export async function inspectImage(input: ProcessorInput, limits: ProcessingLimits): Promise<ImageInfo> {
  return inspect(input, limits);
}

export { renderComposition } from './add-background';
export { resolveAnnotationFont, detectKoreanFont, type AnnotationFont } from './fonts';
export { clearPreviewCaches } from './source-cache';
export { clearCompressCaches } from './compress';
