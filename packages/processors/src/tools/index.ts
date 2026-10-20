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

// Placeholder: the processors-edit workstream implements tool.* executors, previews and inspect here.
export async function runTool(_job: ProcessorJob, _ctx: ProcessorRunContext): Promise<ProcessorResult> {
  throw new OrbitError('ENGINE_UNAVAILABLE', 'tool not implemented yet');
}

export async function renderToolPreview(_request: PreviewRequest, _ctx: { signal: AbortSignal }): Promise<PreviewResult> {
  throw new OrbitError('ENGINE_UNAVAILABLE', 'preview not implemented yet');
}

export async function inspectImage(_input: ProcessorInput, _limits: ProcessingLimits): Promise<ImageInfo> {
  throw new OrbitError('ENGINE_UNAVAILABLE', 'inspect not implemented yet');
}
