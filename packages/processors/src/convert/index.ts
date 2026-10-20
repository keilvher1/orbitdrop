import { OrbitError, type ProcessorJob, type ProcessorResult, type ProcessorRunContext } from '@orbitdrop/contracts';

// Placeholder: the processors-convert workstream implements convert.* executors here.
export async function runConvert(_job: ProcessorJob, _ctx: ProcessorRunContext): Promise<ProcessorResult> {
  throw new OrbitError('ENGINE_UNAVAILABLE', 'convert not implemented yet');
}
