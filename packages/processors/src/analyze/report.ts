import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { ANALYSIS_MODEL, OrbitError, type Locale } from '@orbitdrop/contracts';
import { singleLine } from './prompt';

/**
 * The report file, "<base> Analysis.md" next to the original:
 *
 *   # <file name>
 *
 *   _Claude 분석 · Claude Opus 5.5 · 2026-11-13 09:41_
 *
 *   <Claude's Markdown>
 *
 *   ---
 *   _토큰: 입력 1,906 · 출력 1,475_
 *
 * plus a closing note when the answer hit its length limit. UTF-8, LF line endings.
 */

/** What an answer contributes to the report (readAnswer). */
export interface AnalysisAnswer {
  readonly text: string;
  /** The answer stopped at its length limit (max_tokens, or the context window). */
  readonly truncated: boolean;
  /** Model that wrote the answer: the requested one, or the server-side fallback model. */
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const MODEL_NAMES: Readonly<Record<string, string>> = {
  [ANALYSIS_MODEL.id]: ANALYSIS_MODEL.name,
  'claude-opus-5': 'Claude Opus 5',
  'claude-opus-4-8': 'Claude Opus 4.8',
};

function modelName(id: string): string {
  return MODEL_NAMES[id] ?? id;
}

/**
 * Check the stop reason before reading the content: a refusal is ANALYSIS_REFUSED (its category may go
 * into `detail`, never any text), an answer without text is ANALYSIS_FAILED; text cut off by the length
 * limit is kept and marked truncated. Text blocks are joined in order: after a server-side fallback
 * mid-answer the fallback model continues the text where the first one stopped.
 */
export function readAnswer(message: BetaMessage): AnalysisAnswer {
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category ?? null;
    throw new OrbitError('ANALYSIS_REFUSED', 'Claude declined to analyse this file', category === null ? undefined : { detail: `category: ${category}` });
  }
  const text = message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (text === '') throw new OrbitError('ANALYSIS_FAILED', 'The answer had no text', { detail: `stop_reason: ${message.stop_reason ?? 'none'}` });
  const iterations = message.usage.iterations ?? [];
  // A fallback model served the answer when usage lists a fallback attempt (the documented signal).
  const fallback = iterations.find((entry) => entry.type === 'fallback_message');
  // Every sampling attempt of this request (a declined attempt before a fallback included); the top-level
  // counters cover only the attempt that produced the answer.
  const attempts = iterations.filter((entry) => entry.type === 'message' || entry.type === 'fallback_message');
  const sum = (pick: (entry: (typeof attempts)[number]) => number): number => attempts.reduce((total, entry) => total + pick(entry), 0);
  return {
    text,
    truncated: message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded',
    model: fallback?.type === 'fallback_message' ? String(fallback.model) : ANALYSIS_MODEL.id,
    inputTokens: attempts.length > 0 ? sum((entry) => entry.input_tokens) : message.usage.input_tokens,
    outputTokens: attempts.length > 0 ? sum((entry) => entry.output_tokens) : message.usage.output_tokens,
  };
}

const TEXT: Readonly<
  Record<
    Locale,
    {
      readonly label: string;
      readonly model: (served: string, requested: string) => string;
      readonly tokens: (input: string, output: string) => string;
      readonly truncated: string;
    }
  >
> = {
  ko: {
    label: 'Claude 분석',
    model: (served, requested) => `${served} (${requested} 대신)`,
    tokens: (input, output) => `토큰: 입력 ${input} · 출력 ${output}`,
    truncated: '답변이 최대 길이에 도달해 이 보고서의 끝부분이 잘렸을 수 있습니다.',
  },
  en: {
    label: 'Claude analysis',
    model: (served, requested) => `${served} (instead of ${requested})`,
    tokens: (input, output) => `Tokens: input ${input} · output ${output}`,
    truncated: 'The answer reached its length limit, so the end of this report may be cut off.',
  },
};

/** 1906 → "1,906" (the same in both languages; no locale data needed). */
export function groupDigits(value: number): string {
  return String(Math.max(0, Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Local date and time as "2026-11-13 09:41". */
export function localDateTime(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A file name as heading text: on one line, with the characters that would start Markdown markup
 * escaped (underscores only where they could start emphasis — inside a word they are plain text).
 */
export function markdownHeadingText(name: string): string {
  return singleLine(name)
    .replace(/[\\`*[\]<>#]/g, (ch) => `\\${ch}`)
    .replace(/_/g, (ch, offset: number, text: string) => (/[\p{L}\p{N}]/u.test(text[offset - 1] ?? '') && /[\p{L}\p{N}]/u.test(text[offset + 1] ?? '') ? ch : `\\${ch}`));
}

export function buildReport(parts: { readonly displayName: string; readonly language: Locale; readonly answer: AnalysisAnswer; readonly date: Date }): string {
  const t = TEXT[parts.language];
  const { answer } = parts;
  const served = answer.model === ANALYSIS_MODEL.id ? ANALYSIS_MODEL.name : t.model(modelName(answer.model), ANALYSIS_MODEL.name);
  const lines = [
    `# ${markdownHeadingText(parts.displayName)}`,
    '',
    `_${t.label} · ${served} · ${localDateTime(parts.date)}_`,
    '',
    answer.text,
    '',
    '---',
    `_${t.tokens(groupDigits(answer.inputTokens), groupDigits(answer.outputTokens))}_`,
  ];
  if (answer.truncated) lines.push('', `_${t.truncated}_`);
  return `${lines.join('\n')}\n`;
}
