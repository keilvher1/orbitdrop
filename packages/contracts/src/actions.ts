import type { FileFormat, InputKind } from './formats';

/** Conversion targets, in the order they are declared (menus define display order). */
export const CONVERT_TARGETS = ['jpeg', 'png', 'webp', 'heic', 'tiff', 'avif', 'bmp', 'pdf', 'docx', 'txt'] as const;
export type ConvertTarget = (typeof CONVERT_TARGETS)[number];

export const TOOL_NAMES = ['compress', 'metadata', 'edit', 'annotate', 'addBackground', 'crop', 'redact'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ConvertActionId = `convert.${ConvertTarget}`;
export type ToolActionId = `tool.${ToolName}`;
export type ActionId = ConvertActionId | ToolActionId;

export const ACTION_IDS: readonly ActionId[] = [
  ...CONVERT_TARGETS.map((t) => `convert.${t}` as const),
  ...TOOL_NAMES.map((t) => `tool.${t}` as const),
];

const ACTION_ID_SET: ReadonlySet<string> = new Set(ACTION_IDS);

export function isActionId(value: unknown): value is ActionId {
  return typeof value === 'string' && ACTION_ID_SET.has(value);
}

/** Wheel opened by the convert modifier (default Shift) or the tools modifier (default Option/Alt+Shift). */
export type WheelMode = 'convert' | 'tools';
export const WHEEL_MODES: readonly WheelMode[] = ['convert', 'tools'];

export type Tier = 'P0' | 'P1' | 'P2';

/** Abstract icon ids. macOS maps them to SF Symbols, Windows to Segoe Fluent Icons, the renderer to SVG. */
export const ICON_IDS = ['compress', 'metadata', 'edit', 'annotate', 'background', 'crop', 'redact'] as const;
export type IconId = (typeof ICON_IDS)[number];

export interface LocalizedText {
  readonly ko: string;
  readonly en: string;
}

export type Locale = keyof LocalizedText;
export const LOCALES: readonly Locale[] = ['ko', 'en'];

/** When an action needs an editor window before it can run. */
export type InteractiveWhen = 'never' | 'always' | 'multiple';

/**
 * Static description of an action. Executors live in @orbitdrop/processors and
 * the option schemas in ./options; whether an action is enabled is decided at
 * runtime by the capability registry from the engine probe.
 */
export interface ActionDescriptor {
  readonly id: ActionId;
  readonly mode: WheelMode;
  /** Text on the wheel sector. Format labels are not translated. */
  readonly wheelLabel: LocalizedText;
  /** Title of the editor window / job row. */
  readonly title: LocalizedText;
  /** Tools show an icon above the label; conversions show the label only, as in the reference. */
  readonly icon: IconId | null;
  readonly inputs: readonly InputKind[];
  /**
   * Result format. 'input' keeps the input format (with an option to change it),
   * otherwise a fixed format.
   */
  readonly output: FileFormat | 'input';
  readonly interactive: InteractiveWhen;
  /** Several files can be submitted together (one job per file unless the action merges them). */
  readonly batch: boolean;
  /** All inputs are merged into one output (images → one PDF). */
  readonly merges: boolean;
  readonly cancellable: boolean;
  readonly tier: Tier;
  /** Appended to the base name of the result, e.g. " Cropped". Empty for conversions. */
  readonly outputSuffix: string;
}

const fmt = (label: string): LocalizedText => ({ ko: label, en: label });

function convert(
  target: ConvertTarget,
  label: string,
  inputs: readonly InputKind[],
  tier: Tier,
  extra: Partial<Pick<ActionDescriptor, 'interactive' | 'merges' | 'title'>> = {},
): ActionDescriptor {
  return {
    id: `convert.${target}`,
    mode: 'convert',
    wheelLabel: fmt(label),
    title: extra.title ?? { ko: `${label}로 변환`, en: `Convert to ${label}` },
    icon: null,
    inputs,
    output: target,
    interactive: extra.interactive ?? 'never',
    batch: true,
    merges: extra.merges ?? false,
    cancellable: true,
    tier,
    outputSuffix: '',
  };
}

function tool(
  name: ToolName,
  icon: IconId,
  wheelLabel: LocalizedText,
  title: LocalizedText,
  tier: Tier,
  outputSuffix: string,
  extra: Partial<Pick<ActionDescriptor, 'batch' | 'output'>> = {},
): ActionDescriptor {
  return {
    id: `tool.${name}`,
    mode: 'tools',
    wheelLabel,
    title,
    icon,
    inputs: ['image'],
    output: extra.output ?? 'input',
    interactive: 'always',
    batch: extra.batch ?? false,
    merges: false,
    cancellable: true,
    tier,
    outputSuffix,
  };
}

export const ACTIONS: Readonly<Record<ActionId, ActionDescriptor>> = {
  'convert.jpeg': convert('jpeg', 'JPG', ['image', 'pdf'], 'P0'),
  'convert.png': convert('png', 'PNG', ['image', 'pdf'], 'P0'),
  'convert.webp': convert('webp', 'WEBP', ['image'], 'P0'),
  'convert.heic': convert('heic', 'HEIC', ['image'], 'P2'),
  'convert.tiff': convert('tiff', 'TIFF', ['image'], 'P1'),
  'convert.avif': convert('avif', 'AVIF', ['image'], 'P1'),
  'convert.bmp': convert('bmp', 'BMP', ['image'], 'P2'),
  'convert.pdf': convert('pdf', 'PDF', ['image'], 'P1', { interactive: 'multiple', merges: true }),
  'convert.docx': convert('docx', 'DOCX', ['pdf', 'image'], 'P2', {
    title: { ko: 'DOCX로 변환 (텍스트 중심)', en: 'Convert to DOCX (text-focused)' },
  }),
  'convert.txt': convert('txt', 'TXT', ['pdf'], 'P1'),
  'tool.compress': tool(
    'compress',
    'compress',
    { ko: '압축', en: 'COMPRESS' },
    { ko: '이미지 압축', en: 'Compress Image' },
    'P1',
    ' Compressed',
    { batch: true },
  ),
  'tool.metadata': tool(
    'metadata',
    'metadata',
    { ko: '메타데이터', en: 'METADATA' },
    { ko: '메타데이터', en: 'Metadata' },
    'P1',
    ' No Metadata',
    { batch: true },
  ),
  'tool.edit': tool('edit', 'edit', { ko: '편집', en: 'EDIT' }, { ko: '이미지 편집', en: 'Edit Image' }, 'P1', ' Edited'),
  'tool.annotate': tool(
    'annotate',
    'annotate',
    { ko: '주석', en: 'ANNOTATE' },
    { ko: '주석 달기', en: 'Annotate' },
    'P1',
    ' Annotated',
  ),
  'tool.addBackground': tool(
    'addBackground',
    'background',
    { ko: '배경 추가', en: 'ADD BG' },
    { ko: '배경 추가', en: 'Add Background' },
    'P0',
    ' With Background',
    { output: 'png' },
  ),
  'tool.crop': tool('crop', 'crop', { ko: '자르기', en: 'CROP' }, { ko: '이미지 자르기', en: 'Crop Image' }, 'P0', ' Cropped'),
  'tool.redact': tool(
    'redact',
    'redact',
    { ko: '가리기', en: 'REDACT' },
    { ko: '정보 가리기', en: 'Redact' },
    'P1',
    ' Redacted',
  ),
};

const DOCX_FROM_IMAGES_TITLE: LocalizedText = { ko: 'DOCX로 변환 (이미지 삽입, OCR 없음)', en: 'Convert to DOCX (image embedded, no OCR)' };
const DOCX_MIXED_TITLE: LocalizedText = {
  ko: 'DOCX로 변환 (PDF는 텍스트 중심, 이미지는 삽입)',
  en: 'Convert to DOCX (PDF text-focused, images embedded)',
};

/**
 * Title of an action for the kinds of inputs it runs on. Only DOCX differs:
 * PDFs give a text-focused document, images are embedded as pictures without
 * OCR. Use this wherever an action is named for a concrete selection or job.
 */
export function actionTitle(actionId: ActionId, kinds: readonly InputKind[]): LocalizedText {
  if (actionId === 'convert.docx' && kinds.includes('image')) {
    return kinds.includes('pdf') ? DOCX_MIXED_TITLE : DOCX_FROM_IMAGES_TITLE;
  }
  return ACTIONS[actionId].title;
}

export function needsEditor(action: ActionDescriptor, fileCount: number): boolean {
  if (action.interactive === 'always') return true;
  if (action.interactive === 'multiple') return fileCount > 1;
  return false;
}
