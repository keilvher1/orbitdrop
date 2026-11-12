import {
  ACTIONS,
  ACTION_IDS,
  IMAGE_FORMATS,
  MENU_KEYS,
  FORMAT_INFO,
  baseMenuOrder,
  inputKindOf,
  type ActionCapability,
  type ActionId,
  type CapabilitySnapshot,
  type EngineProbe,
  type FileFormat,
  type ImageFormat,
  type InputDescriptor,
  type InputKind,
  type Locale,
  type LocalizedText,
  type MenuKey,
  type MenuOptions,
  type Platform,
  type WheelMenu,
  type WheelMode,
  type WheelSector,
} from '@orbitdrop/contracts';

/**
 * Capability registry: combines the static action table with what the bundled
 * engines can really do (EngineProbe). Menus for the native wheel and the
 * picker are built only from here, so a sector is enabled exactly when its
 * executor can run.
 */

export const CAPABILITY_REASONS = {
  noEncoder: (label: string): LocalizedText => ({
    ko: `${label} 인코더가 이 빌드에 없음`,
    en: `No ${label} encoder in this build`,
  }),
  noDecoder: (label: string): LocalizedText => ({
    ko: `이 빌드에서는 ${label} 파일을 읽을 수 없음`,
    en: `This build can't read ${label} files`,
  }),
  noPdfRender: { ko: 'PDF 렌더러를 불러오지 못함', en: 'PDF renderer unavailable' },
  noPdfText: { ko: 'PDF 텍스트 추출 불가', en: 'PDF text extraction unavailable' },
  noImageDecoder: { ko: '이미지 디코더를 불러오지 못함', en: 'Image decoder unavailable' },
  noCanvas: { ko: '그리기 엔진을 불러오지 못함', en: 'Drawing engine unavailable' },
} as const;

const REASONS = CAPABILITY_REASONS;

const IMAGE_TARGETS: readonly ImageFormat[] = ['jpeg', 'png', 'webp', 'heic', 'tiff', 'avif', 'bmp'];

/** Actions whose PDF input needs text extraction (the others need page rendering). */
const PDF_TEXT_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>(['convert.docx', 'convert.txt']);

function decodableImages(probe: EngineProbe): ImageFormat[] {
  return IMAGE_FORMATS.filter((f) => probe.formats[f]?.input === true);
}

/** Whether this build can open files of `format` at all (images: a decoder; PDF: PDF.js render or text). */
export function isReadableFormat(probe: EngineProbe, format: FileFormat): boolean {
  const kind = inputKindOf(format);
  if (kind === 'pdf') return probe.pdfRender || probe.pdfText;
  if (kind === 'image') return probe.formats[format]?.input === true;
  return false;
}

function capability(
  actionId: ActionId,
  enabled: boolean,
  inputKinds: InputKind[],
  imageInputs: FileFormat[],
  reason: LocalizedText,
): ActionCapability {
  const usable = enabled && inputKinds.length > 0;
  return {
    actionId,
    enabled: usable,
    inputKinds: usable ? inputKinds : [],
    imageInputs: usable && inputKinds.includes('image') ? imageInputs : [],
    ...(usable ? {} : { reason }),
  };
}

export function buildCapabilitySnapshot(probe: EngineProbe): CapabilitySnapshot {
  const images = decodableImages(probe);
  const hasImages = images.length > 0;
  const canWritePng = probe.formats.png?.output === true;
  // pdf-lib and docx embed PNG/JPEG only; pixels are re-encoded (orientation applied) before embedding.
  const canEmbedImages = hasImages && (canWritePng || probe.formats.jpeg?.output === true);
  const actions = {} as Record<ActionId, ActionCapability>;

  for (const id of ACTION_IDS) {
    const target = id.startsWith('convert.') ? (id.slice('convert.'.length) as FileFormat) : null;

    if (target !== null && (IMAGE_TARGETS as readonly string[]).includes(target)) {
      const canEncode = probe.formats[target]?.output === true;
      const kinds: InputKind[] = [];
      if (hasImages) kinds.push('image');
      if (ACTIONS[id].inputs.includes('pdf') && probe.pdfRender) kinds.push('pdf');
      actions[id] = capability(id, canEncode, kinds, images, canEncode ? REASONS.noImageDecoder : REASONS.noEncoder(FORMAT_INFO[target].label));
      continue;
    }

    switch (id) {
      case 'convert.pdf': {
        const ok = probe.formats.pdf?.output === true;
        const reason = !ok ? REASONS.noEncoder('PDF') : !hasImages ? REASONS.noImageDecoder : REASONS.noEncoder('PNG');
        actions[id] = capability(id, ok, canEmbedImages ? ['image'] : [], images, reason);
        break;
      }
      case 'convert.docx': {
        const ok = probe.formats.docx?.output === true;
        const kinds: InputKind[] = [];
        if (probe.pdfText) kinds.push('pdf');
        if (canEmbedImages) kinds.push('image');
        actions[id] = capability(id, ok, kinds, images, ok ? REASONS.noPdfText : REASONS.noEncoder('DOCX'));
        break;
      }
      case 'convert.txt': {
        const canWrite = probe.formats.txt?.output === true;
        actions[id] = capability(id, canWrite && probe.pdfText, probe.pdfText ? ['pdf'] : [], [], canWrite ? REASONS.noPdfText : REASONS.noEncoder('TXT'));
        break;
      }
      case 'tool.annotate': {
        // Text and shapes are drawn with the canvas backend that also renders PDF pages.
        const ok = hasImages && canWritePng && probe.pdfRender;
        const reason = !hasImages ? REASONS.noImageDecoder : !canWritePng ? REASONS.noEncoder('PNG') : REASONS.noCanvas;
        actions[id] = capability(id, ok, ['image'], images, reason);
        break;
      }
      case 'tool.analyze': {
        // Claude analysis: images are sent as a re-encoded JPEG/PNG copy (sharp); PDFs as they are, after
        // PDF.js has counted their pages (and refused encrypted ones). The report is Markdown text. Whether
        // the user turned analysis on and saved a key is not an engine question: menus.ts MenuOptions.
        const canWriteMd = probe.formats.md?.output === true;
        const kinds: InputKind[] = [];
        if (canEmbedImages) kinds.push('image');
        if (isReadableFormat(probe, 'pdf')) kinds.push('pdf');
        actions[id] = capability(id, canWriteMd, kinds, images, canWriteMd ? REASONS.noImageDecoder : REASONS.noEncoder('MD'));
        break;
      }
      default: {
        // Crop, Add Background, Compress, Metadata, Edit, Redact: sharp only (previews are PNG).
        const ok = hasImages && canWritePng;
        actions[id] = capability(id, ok, ['image'], images, hasImages ? REASONS.noEncoder('PNG') : REASONS.noImageDecoder);
      }
    }
  }
  return { probe, actions };
}

/**
 * supports(operation, input, platform) — the single gate used for menus and job submission.
 * False when: the snapshot was probed on another platform; the action is
 * disabled; the input kind/format is not accepted; the descriptor is
 * inconsistent (kind does not match the format); or it would be a
 * same-format conversion (no "rename-only" conversions).
 */
export function supports(
  snapshot: CapabilitySnapshot,
  actionId: ActionId,
  input: InputDescriptor,
  platform: Platform = snapshot.probe.platform,
): boolean {
  if (platform !== snapshot.probe.platform) return false;
  if (inputKindOf(input.format) !== input.kind) return false;
  const cap = snapshot.actions[actionId];
  if (!cap?.enabled || !cap.inputKinds.includes(input.kind)) return false;
  if (input.kind === 'image' && !cap.imageInputs.includes(input.format)) return false;
  if (actionId === `convert.${input.format}`) return false;
  return true;
}

function kindsOfKey(key: MenuKey): InputKind[] {
  if (key === 'pdf') return ['pdf'];
  if (key === 'mixed') return ['pdf', 'image'];
  return ['image'];
}

function imageFormatOfKey(key: MenuKey): ImageFormat | null {
  return key.startsWith('image/') ? (key.slice('image/'.length) as ImageFormat) : null;
}

/** Why a sector is disabled for this menu, or undefined when it is enabled. */
function sectorDisabledReason(
  snapshot: CapabilitySnapshot,
  cap: ActionCapability,
  kinds: readonly InputKind[],
  ownFormat: ImageFormat | null,
): LocalizedText | undefined {
  if (!cap.enabled) return cap.reason ?? REASONS.noImageDecoder;
  for (const kind of kinds) {
    if (cap.inputKinds.includes(kind)) continue;
    if (kind === 'image') return decodableImages(snapshot.probe).length > 0 ? REASONS.noEncoder('PNG') : REASONS.noImageDecoder;
    return PDF_TEXT_ACTIONS.has(cap.actionId) ? REASONS.noPdfText : REASONS.noPdfRender;
  }
  if (ownFormat !== null && !cap.imageInputs.includes(ownFormat)) return REASONS.noDecoder(FORMAT_INFO[ownFormat].label);
  return undefined;
}

/**
 * Sectors for one menu key and mode (before per-drag adjustments such as the file count). `options`
 * adds the sectors that depend on the user's setup (Claude analysis); without them every menu is the
 * reference order.
 */
export function buildWheelMenu(snapshot: CapabilitySnapshot, key: MenuKey, mode: WheelMode, locale: Locale, options: MenuOptions = {}): WheelMenu {
  const kinds = kindsOfKey(key);
  const ownFormat = imageFormatOfKey(key);
  const sectors: WheelSector[] = baseMenuOrder(key, mode, options).map((actionId) => {
    const action = ACTIONS[actionId];
    const reason = sectorDisabledReason(snapshot, snapshot.actions[actionId], kinds, ownFormat);
    return {
      actionId,
      label: action.wheelLabel[locale],
      icon: action.icon,
      enabled: reason === undefined,
      ...(reason === undefined ? {} : { reason: reason[locale] }),
      batch: action.batch,
    };
  });
  return { key, mode, sectors };
}

/**
 * Disable non-batch sectors when several files are dragged together. Sectors
 * that are already disabled keep their own reason. Native helpers apply the
 * same rule to the menus they received (golden vectors: fileCount section).
 */
export function adjustMenuForFileCount(menu: WheelMenu, fileCount: number, multiFileReason: string): WheelMenu {
  if (fileCount <= 1) return menu;
  return {
    ...menu,
    sectors: menu.sectors.map((s) => (s.batch || !s.enabled ? s : { ...s, enabled: false, reason: multiFileReason })),
  };
}

export interface HelperMenu {
  readonly key: MenuKey;
  readonly convert: WheelSector[];
  readonly tools: WheelSector[];
}

/** All menus the native helper needs, keyed by MenuKey (`options` as for buildWheelMenu). */
export function buildHelperMenus(snapshot: CapabilitySnapshot, locale: Locale, options: MenuOptions = {}): HelperMenu[] {
  return MENU_KEYS.map((key) => ({
    key,
    convert: [...buildWheelMenu(snapshot, key, 'convert', locale, options).sectors],
    tools: [...buildWheelMenu(snapshot, key, 'tools', locale, options).sectors],
  }));
}

/**
 * Extension → single-file menu key, for the formats this build can actually
 * read (undecodable formats are left out, so the helper shows them as
 * unsupported instead of offering a menu that cannot run).
 */
export function helperExtensionMap(snapshot: CapabilitySnapshot): Record<string, MenuKey> {
  const map: Record<string, MenuKey> = {};
  for (const format of decodableImages(snapshot.probe)) {
    for (const ext of FORMAT_INFO[format].extensions) map[ext] = `image/${format}`;
  }
  if (isReadableFormat(snapshot.probe, 'pdf')) {
    for (const ext of FORMAT_INFO.pdf.extensions) map[ext] = 'pdf';
  }
  return map;
}
