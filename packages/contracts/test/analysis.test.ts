import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_IDS,
  ANALYSIS_KEY_LENGTH,
  ANALYSIS_LIMITS,
  ANALYSIS_MODEL,
  ANALYSIS_TOOLS_ORDER,
  AnalysisKeyRequestSchema,
  DEFAULT_SETTINGS,
  FILE_FORMATS,
  HelperConfigureSchema,
  ICON_IDS,
  IMAGE_TOOLS_ORDER,
  MENU_KEYS,
  RETRYABLE_ERROR_CODES,
  RETRY_JOB_CODES,
  SETTINGS_VERSION,
  TOOL_NAMES,
  WARNING_CODES,
  analysisKeyHint,
  applySettingsPatch,
  baseMenuOrder,
  formatFromExtension,
  inputKindOf,
  isPlausibleAnalysisKey,
  menuKeyFor,
  migrateSettings,
  needsEditor,
  normalizeAnalysisKey,
  parseActionOptions,
  type ProcessorJob,
  type MainToProcessorMessage,
} from '../src';

const KEY = `sk-ant-api03-${'a1B2_c3-'.repeat(11)}WXYZ`;

describe('tool.analyze descriptor', () => {
  it('is a batch tools action on images and PDFs that runs on drop and writes a Markdown report', () => {
    expect(TOOL_NAMES.at(-1)).toBe('analyze');
    expect(ICON_IDS.at(-1)).toBe('analyze');
    expect(ACTION_IDS).toContain('tool.analyze');
    expect(ACTIONS['tool.analyze']).toEqual({
      id: 'tool.analyze',
      mode: 'tools',
      wheelLabel: { ko: 'Claude 분석', en: 'ANALYZE' },
      title: { ko: 'Claude로 분석', en: 'Analyze with Claude' },
      icon: 'analyze',
      inputs: ['image', 'pdf'],
      output: 'md',
      interactive: 'never',
      batch: true,
      merges: false,
      cancellable: true,
      tier: 'P2',
      outputSuffix: ' Analysis',
    });
    expect(needsEditor(ACTIONS['tool.analyze'], 1)).toBe(false);
    expect(needsEditor(ACTIONS['tool.analyze'], 5)).toBe(false);
    expect(ANALYSIS_MODEL).toEqual({ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' });
  });

  it('Markdown is an output-only format: a dropped .md file stays unsupported', () => {
    expect(FILE_FORMATS).toContain('md');
    expect(formatFromExtension('.md')).toBe('md');
    expect(formatFromExtension('README.MD'.slice(-3))).toBe('md');
    expect(inputKindOf('md')).toBeUndefined();
    expect(menuKeyFor(['md'])).toBeNull();
    expect(menuKeyFor(['pdf', 'md'])).toBeNull();
  });

  it('options come from the settings: the standing request (≤ 1000 characters) and the report language', () => {
    expect(parseActionOptions('tool.analyze', {})).toEqual({ instruction: '', language: 'ko' });
    expect(parseActionOptions('tool.analyze', { instruction: '합계 확인', language: 'en' })).toEqual({ instruction: '합계 확인', language: 'en' });
    expect(() => parseActionOptions('tool.analyze', { instruction: 'x'.repeat(ANALYSIS_LIMITS.maxInstructionLength + 1) })).toThrow();
    expect(() => parseActionOptions('tool.analyze', { language: 'fr' })).toThrow();
    // The key is never an option.
    expect(() => parseActionOptions('tool.analyze', { apiKey: KEY })).toThrow();
  });

  it('new error codes: rate limits and outages may be retried, the rest not', () => {
    expect(RETRYABLE_ERROR_CODES.has('ANALYSIS_RATE_LIMITED')).toBe(true);
    expect(RETRYABLE_ERROR_CODES.has('ANALYSIS_UNAVAILABLE')).toBe(true);
    expect(RETRY_JOB_CODES.has('ANALYSIS_UNAVAILABLE')).toBe(true);
    for (const code of ['ANALYSIS_NOT_CONFIGURED', 'ANALYSIS_KEY_INVALID', 'ANALYSIS_KEY_STORAGE_UNAVAILABLE', 'ANALYSIS_AUTH_FAILED', 'ANALYSIS_INPUT_TOO_LARGE', 'ANALYSIS_REFUSED', 'ANALYSIS_FAILED'] as const) {
      expect(RETRYABLE_ERROR_CODES.has(code), code).toBe(false);
    }
    expect(WARNING_CODES).toContain('ANALYSIS_TRUNCATED');
  });
});

describe('menus with and without Claude analysis', () => {
  it('without it (the default) every menu is exactly the reference order', () => {
    for (const key of MENU_KEYS) {
      for (const mode of ['convert', 'tools'] as const) {
        expect(baseMenuOrder(key, mode, { analysis: false }), `${key} ${mode}`).toEqual(baseMenuOrder(key, mode));
        expect(baseMenuOrder(key, mode)).not.toContain('tool.analyze');
      }
    }
    expect(baseMenuOrder('pdf', 'tools')).toEqual([]);
    expect(baseMenuOrder('mixed', 'tools')).toEqual([]);
    expect(baseMenuOrder('image/png', 'tools')).toEqual([...IMAGE_TOOLS_ORDER]);
  });

  it('with it: last on the image tools wheel, and the tools wheel of PDFs and mixed selections; convert wheels unchanged', () => {
    const on = { analysis: true };
    expect(ANALYSIS_TOOLS_ORDER).toEqual(['tool.analyze']);
    expect(baseMenuOrder('image/jpeg', 'tools', on)).toEqual([...IMAGE_TOOLS_ORDER, 'tool.analyze']);
    expect(baseMenuOrder('images', 'tools', on)).toEqual([...IMAGE_TOOLS_ORDER, 'tool.analyze']);
    expect(baseMenuOrder('pdf', 'tools', on)).toEqual(['tool.analyze']);
    expect(baseMenuOrder('mixed', 'tools', on)).toEqual(['tool.analyze']);
    for (const key of MENU_KEYS) expect(baseMenuOrder(key, 'convert', on), key).toEqual(baseMenuOrder(key, 'convert'));
  });

  it('a configure message with the analysis sectors passes the helper protocol schema (8 image tools, ≤ 12)', () => {
    const sector = (actionId: (typeof IMAGE_TOOLS_ORDER)[number]) => ({ actionId, label: ACTIONS[actionId].wheelLabel.ko, icon: ACTIONS[actionId].icon, enabled: true, batch: ACTIONS[actionId].batch });
    const tools = baseMenuOrder('image/jpeg', 'tools', { analysis: true }).map(sector);
    expect(tools).toHaveLength(8);
    const parsed = HelperConfigureSchema.shape.menus.safeParse([
      { key: 'image/jpeg', convert: [], tools },
      { key: 'pdf', convert: [], tools: baseMenuOrder('pdf', 'tools', { analysis: true }).map(sector) },
    ]);
    expect(parsed.success).toBe(true);
  });
});

describe('settings: an additive `analysis` section', () => {
  it('is off with no standing request by default, without a version bump', () => {
    expect(DEFAULT_SETTINGS.analysis).toEqual({ enabled: false, instruction: '' });
    expect(SETTINGS_VERSION).toBe(1);
    expect(DEFAULT_SETTINGS.version).toBe(1);
  });

  it('a settings file written before it existed gets the defaults and keeps everything else', () => {
    const older = { version: 1, locale: 'en', notifications: false, updates: { autoCheck: false }, globalDrag: { wheelDiameter: 340 } };
    const migrated = migrateSettings(older);
    expect(migrated.analysis).toEqual({ enabled: false, instruction: '' });
    expect(migrated).toMatchObject({ version: 1, locale: 'en', notifications: false, updates: { autoCheck: false }, globalDrag: { wheelDiameter: 340 } });
  });

  it('a stored section is kept; an invalid one is reset alone; the key can never be stored in it', () => {
    expect(migrateSettings({ version: 1, analysis: { enabled: true, instruction: '표 합계 확인' } }).analysis).toEqual({ enabled: true, instruction: '표 합계 확인' });
    for (const bad of [{ enabled: 'yes' }, { enabled: true, instruction: 'x'.repeat(1001) }, { enabled: true, apiKey: KEY }, 'on', null]) {
      const migrated = migrateSettings({ version: 1, locale: 'en', analysis: bad });
      expect(migrated.analysis, JSON.stringify(bad)?.slice(0, 40)).toEqual({ enabled: false, instruction: '' });
      expect(migrated.locale).toBe('en');
    }
    expect(applySettingsPatch(DEFAULT_SETTINGS, { analysis: { enabled: true } })?.analysis).toEqual({ enabled: true, instruction: '' });
    expect(applySettingsPatch(DEFAULT_SETTINGS, { analysis: { instruction: '요약을 세 줄로' } })?.analysis.instruction).toBe('요약을 세 줄로');
    expect(applySettingsPatch(DEFAULT_SETTINGS, { analysis: { apiKey: KEY } } as never)).toBeNull();
    expect(applySettingsPatch(DEFAULT_SETTINGS, { analysis: { enabled: 1 } } as never)).toBeNull();
  });
});

describe('API key format (checked in the renderer and again in main)', () => {
  it('accepts Anthropic keys, trimmed; refuses anything else', () => {
    expect(isPlausibleAnalysisKey(KEY)).toBe(true);
    expect(isPlausibleAnalysisKey(normalizeAnalysisKey(`  ${KEY}\n`))).toBe(true);
    for (const bad of [
      '',
      'sk-ant-',
      'sk-ant-short',
      `sk-proj-${'a'.repeat(60)}`,
      `SK-ANT-${'a'.repeat(60)}`,
      `sk-ant-${'a'.repeat(30)} ${'b'.repeat(30)}`,
      `sk-ant-${'a'.repeat(60)}\n`,
      `sk-ant-${'a'.repeat(60)}"`,
      `sk-ant-${'가'.repeat(60)}`,
      `sk-ant-${'a'.repeat(ANALYSIS_KEY_LENGTH.max)}`,
    ]) {
      expect(isPlausibleAnalysisKey(bad), JSON.stringify(bad).slice(0, 30)).toBe(false);
    }
    expect(analysisKeyHint(KEY)).toBe('…WXYZ');
  });

  it('the IPC payload is a bounded string and nothing else', () => {
    expect(AnalysisKeyRequestSchema.safeParse({ key: KEY }).success).toBe(true);
    for (const bad of [{ key: '' }, { key: 'k'.repeat(1025) }, { key: KEY, extra: 1 }, { key: 1 }, KEY]) expect(AnalysisKeyRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('credentials travel next to the job in the run message, never in it', () => {
    const job = { jobId: 'job_1', actionId: 'tool.analyze', inputs: [], options: {}, outputDir: null } as unknown as ProcessorJob;
    const message: MainToProcessorMessage = { type: 'run', job, credentials: { anthropicApiKey: KEY } };
    expect(JSON.stringify(message.job)).not.toContain(KEY);
  });
});
