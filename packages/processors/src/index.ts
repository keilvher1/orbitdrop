import type { ProcessorApi } from '@orbitdrop/contracts';
import { runConvert } from './convert';
import { probeEngines as probe } from './probe';
import { inspectImage as inspect, renderToolPreview, runTool } from './tools';
import { clearPreviewCaches as clearCaches } from './tools/source-cache';

/**
 * Public API (contracts ProcessorApi). Dispatches convert.* to ./convert and
 * tool.* plus all previews/inspection to ./tools.
 */
export const probeEngines: ProcessorApi['probeEngines'] = () => probe();

export const runJob: ProcessorApi['runJob'] = (job, ctx) =>
  job.actionId.startsWith('convert.') ? runConvert(job, ctx) : runTool(job, ctx);

export const renderPreview: ProcessorApi['renderPreview'] = (request, ctx) => renderToolPreview(request, ctx);

export const inspectImage: ProcessorApi['inspectImage'] = (input, limits) => inspect(input, limits);

export const clearPreviewCaches: ProcessorApi['clearPreviewCaches'] = () => clearCaches();

export * from './common/io';
