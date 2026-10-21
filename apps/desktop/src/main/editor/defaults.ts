import {
  ACTION_OPTION_SCHEMAS,
  BACKGROUND_PRESETS,
  COMPOSITION_LIMITS,
  type ActionId,
  type ImageInfo,
  type PreviewKind,
  type Settings,
} from '@orbitdrop/contracts';

/** Preview renderer for each editor action (actions without one show only the source image). */
export const PREVIEW_KINDS: Partial<Record<ActionId, PreviewKind>> = {
  'tool.addBackground': 'tool.addBackground',
  'tool.edit': 'tool.edit',
  'tool.compress': 'tool.compress',
  'tool.redact': 'tool.redact',
  'tool.annotate': 'tool.annotate',
  'tool.crop': 'tool.crop',
};

/** Actions whose editors show per-file size estimates (requestEstimate), with the preview kind that computes them. */
export const ESTIMATE_KINDS: Partial<Record<ActionId, PreviewKind>> = {
  'tool.compress': 'tool.compress',
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)));

/**
 * Default options an editor starts with (EditorContext.defaults), filled from
 * the settings and the oriented image size. Annotate/Redact start empty (their
 * schemas require at least one shape/region, which the user adds).
 */
export function editorDefaults(actionId: ActionId, image: ImageInfo, settings: Settings, fileIds: readonly string[]): unknown {
  const width = Math.max(1, image.orientedWidth);
  const height = Math.max(1, image.orientedHeight);
  switch (actionId) {
    case 'tool.crop':
      return { rect: { x: 0, y: 0, width, height }, aspect: 'free', outputFormat: 'input', flattenBackground: '#FFFFFF' };
    case 'tool.addBackground': {
      const maxEdge = settings.background.maxEdge;
      const base = Math.min(maxEdge, Math.max(width, height));
      return {
        background: { kind: 'preset', presetId: BACKGROUND_PRESETS[0]?.id ?? 'ember' },
        padding: clamp(base * 0.08, COMPOSITION_LIMITS.padding.min, COMPOSITION_LIMITS.padding.max),
        cornerRadius: clamp(base * 0.03, COMPOSITION_LIMITS.cornerRadius.min, COMPOSITION_LIMITS.cornerRadius.max),
        shadow: clamp(base * 0.02, COMPOSITION_LIMITS.shadow.min, COMPOSITION_LIMITS.shadow.max),
        ratio: 'auto',
        maxEdge,
        format: 'png',
        quality: 92,
      };
    }
    case 'tool.annotate':
      return { shapes: [], outputFormat: 'input' };
    case 'tool.redact':
      return { regions: [], outputFormat: 'input' };
    case 'convert.pdf': {
      const parsed = ACTION_OPTION_SCHEMAS['convert.pdf'].safeParse({});
      return { ...(parsed.success ? parsed.data : {}), order: [...fileIds] };
    }
    default: {
      const parsed = (ACTION_OPTION_SCHEMAS[actionId] as { safeParse(value: unknown): { success: boolean; data?: unknown } }).safeParse({});
      return parsed.success ? parsed.data : {};
    }
  }
}
