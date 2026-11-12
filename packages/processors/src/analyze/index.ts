import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  ACTIONS,
  ANALYSIS_LIMITS,
  ANALYSIS_MODEL,
  AnalyzeOptionsSchema,
  FORMAT_INFO,
  OrbitError,
  type AnalyzeOptions,
  type JobWarning,
  type ProcessorJob,
  type ProcessorResult,
  type ProcessorRunContext,
} from '@orbitdrop/contracts';
import { toolResultName } from '@orbitdrop/core';
import { outputDirFor } from '../common/io';
import { OutputLedger, reporter, throwIfCancelled, toOrbitError } from '../convert/common';
import { ANALYSIS_BETAS, analysisError, createAnalysisClient, type AnalysisClientOptions } from './client';
import { prepareAnalysisFile, type PreparedFile } from './input';
import { analysisSystemPrompt, analysisUserText } from './prompt';
import { buildReport, readAnswer } from './report';

/**
 * tool.analyze — Claude analysis of one image or PDF (opt-in, bring your own key):
 *   read + prepare the file (./input.ts) → one streamed request to the Messages API with the user's
 *   key (from ProcessorRunContext.credentials, never from the job) → the stop reason is checked
 *   before the content (./report.ts) → "<base> Analysis.md" next to the original, written like
 *   every other output (temp file, free name, rollback on a crash; OutputLedger).
 * Progress is indeterminate: reading → decoding/encoding → analyzing → writing.
 */

export { ANTHROPIC_API_BASE_URL, analysisError, createAnalysisClient, verifyAnalysisKey } from './client';
export { analysisSystemPrompt, analysisUserText } from './prompt';
export { buildReport, readAnswer } from './report';

function parseAnalyzeOptions(job: ProcessorJob): AnalyzeOptions {
  const parsed = AnalyzeOptionsSchema.safeParse(job.options ?? {});
  if (!parsed.success) throw new OrbitError('INVALID_OPTIONS', 'Invalid analysis options', { detail: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ').slice(0, 200) });
  return parsed.data;
}

/** The request itself: streamed (long answers), collected with finalMessage(). */
export async function requestAnalysis(
  apiKey: string,
  request: { readonly system: string; readonly file: PreparedFile['block']; readonly text: string },
  signal: AbortSignal,
  options: AnalysisClientOptions = {},
): Promise<BetaMessage> {
  const client = createAnalysisClient(apiKey, options);
  try {
    const stream = client.beta.messages.stream(
      {
        model: ANALYSIS_MODEL.id,
        max_tokens: ANALYSIS_LIMITS.maxOutputTokens,
        betas: [...ANALYSIS_BETAS],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: request.system,
        messages: [{ role: 'user', content: [request.file, { type: 'text', text: request.text }] }],
      },
      { signal },
    );
    return await stream.finalMessage();
  } catch (error) {
    throw analysisError(error, signal);
  }
}

export async function runAnalyze(job: ProcessorJob, ctx: ProcessorRunContext): Promise<ProcessorResult> {
  const { signal } = ctx;
  throwIfCancelled(signal);
  const input = job.inputs[0];
  if (input === undefined || job.inputs.length !== 1) throw new OrbitError('INVALID_OPTIONS', 'Claude analysis takes one file per job');
  const options = parseAnalyzeOptions(job);
  const apiKey = ctx.credentials?.anthropicApiKey;
  if (apiKey === undefined || apiKey === '') throw new OrbitError('ANALYSIS_NOT_CONFIGURED', 'No API key was handed to the worker');
  const progress = reporter(ctx);
  // runTool already checked that this folder accepts new files (before anything is read or sent).
  const dir = outputDirFor(job, input);

  const file = await prepareAnalysisFile(job, input, signal, progress);
  throwIfCancelled(signal);
  progress({ kind: 'indeterminate', stage: 'analyzing' });
  const message = await requestAnalysis(
    apiKey,
    { system: analysisSystemPrompt(options.language), file: file.block, text: analysisUserText(input.displayName, options.language, options.instruction) },
    signal,
  );
  const answer = readAnswer(message);
  throwIfCancelled(signal);

  progress({ kind: 'indeterminate', stage: 'writing' });
  const report = buildReport({ displayName: input.displayName, language: options.language, answer, date: new Date() });
  const name = toolResultName(input.displayName, ACTIONS['tool.analyze'].outputSuffix, FORMAT_INFO.md.extension);
  const ledger = new OutputLedger(ctx.onCommitted);
  let output;
  try {
    output = await ledger.commit(dir, name, job.jobId, new TextEncoder().encode(report), signal, { format: 'md' });
  } catch (error) {
    throw toOrbitError(error, signal);
  }
  const warnings: JobWarning[] = [...file.warnings];
  if (answer.truncated) warnings.push({ code: 'ANALYSIS_TRUNCATED' });
  return { outputs: [output], warnings };
}
