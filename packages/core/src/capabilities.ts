import {
  ACTIONS,
  ACTION_IDS,
  IMAGE_FORMATS,
  MENU_KEYS,
  FORMAT_INFO,
  baseMenuOrder,
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

const REASONS = {
  noEncoder: (label: string): LocalizedText => ({
    ko: `${label} 인코더가 이 빌드에 없음`,
    en: `No ${label} encoder in this build`,
  }),
  noPdfRender: { ko: 'PDF 렌더러를 불러오지 못함', en: 'PDF renderer unavailable' },
  noPdfText: { ko: 'PDF 텍스트 추출 불가', en: 'PDF text extraction unavailable' },
  noImageDecoder: { ko: '이미지 디코더를 불러오지 못함', en: 'Image decoder unavailable' },
  noCanvas: { ko: '그리기 엔진을 불러오지 못함', en: 'Drawing engine unavailable' },
} as const;

const IMAGE_TARGETS: readonly ImageFormat[] = ['jpeg', 'png', 'webp', 'heic', 'tiff', 'avif', 'bmp'];

function decodableImages(probe: EngineProbe): ImageFormat[] {
  return IMAGE_FORMATS.filter((f) => probe.formats[f]?.input === true);
}

function capability(
  actionId: ActionId,
  enabled: boolean,
  inputKinds: InputKind[],
  imageInputs: FileFormat[],
  reason?: LocalizedText,
): ActionCapability {
  const usable = enabled && inputKinds.length > 0;
  return {
    actionId,
    enabled: usable,
    inputKinds: usable ? inputKinds : [],
    imageInputs: usable ? imageInputs : [],
    ...(usable ? {} : { reason: reason ?? REASONS.noImageDecoder }),
  };
}

export function buildCapabilitySnapshot(probe: EngineProbe): CapabilitySnapshot {
  const images = decodableImages(probe);
  const hasImages = images.length > 0;
  const canWritePng = probe.formats.png?.output === true;
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
        actions[id] = capability(id, ok, hasImages ? ['image'] : [], images, ok ? undefined : REASONS.noEncoder('PDF'));
        break;
      }
      case 'convert.docx': {
        const ok = probe.formats.docx?.output === true;
        const kinds: InputKind[] = [];
        if (probe.pdfText) kinds.push('pdf');
        if (hasImages) kinds.push('image');
        actions[id] = capability(id, ok, kinds, images, ok ? REASONS.noPdfText : REASONS.noEncoder('DOCX'));
        break;
      }
      case 'convert.txt': {
        const ok = probe.formats.txt?.output === true && probe.pdfText;
        actions[id] = capability(id, ok, ok ? ['pdf'] : [], [], REASONS.noPdfText);
        break;
      }
      case 'tool.annotate': {
        // Text and shapes are drawn with the canvas backend that also renders PDF pages.
        const ok = hasImages && canWritePng && probe.pdfRender;
        actions[id] = capability(id, ok, ['image'], images, hasImages ? REASONS.noCanvas : REASONS.noImageDecoder);
        break;
      }
      default: {
        // Crop, Add Background, Compress, Metadata, Edit, Redact: sharp only.
        const ok = hasImages && canWritePng;
        actions[id] = capability(id, ok, ['image'], images);
      }
    }
  }
  return { probe, actions };
}

/** supports(operation, input, platform) — the single gate used for menus and job submission. */
export function supports(
  snapshot: CapabilitySnapshot,
  actionId: ActionId,
  input: InputDescriptor,
  platform: Platform = snapshot.probe.platform,
): boolean {
  if (platform !== snapshot.probe.platform) return false;
  const cap = snapshot.actions[actionId];
  if (!cap?.enabled || !cap.inputKinds.includes(input.kind)) return false;
  if (input.kind === 'image' && !cap.imageInputs.includes(input.format)) return false;
  // A conversion to the input's own format is not offered (no "rename-only" conversions).
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

/** Sectors for one menu key and mode (before per-drag adjustments such as the file count). */
export function buildWheelMenu(snapshot: CapabilitySnapshot, key: MenuKey, mode: WheelMode, locale: Locale): WheelMenu {
  const kinds = kindsOfKey(key);
  const ownFormat = imageFormatOfKey(key);
  const sectors: WheelSector[] = baseMenuOrder(key, mode).map((actionId) => {
    const action = ACTIONS[actionId];
    const cap = snapshot.actions[actionId];
    let enabled = cap.enabled && kinds.every((k) => cap.inputKinds.includes(k));
    if (enabled && ownFormat !== null) enabled = cap.imageInputs.includes(ownFormat);
    const reason = enabled ? undefined : (cap.reason ?? REASONS.noImageDecoder)[locale];
    return {
      actionId,
      label: action.wheelLabel[locale],
      icon: action.icon,
      enabled,
      ...(reason === undefined ? {} : { reason }),
      batch: action.batch,
    };
  });
  return { key, mode, sectors };
}

/** Disable non-batch sectors when several files are dragged together. */
export function adjustMenuForFileCount(menu: WheelMenu, fileCount: number, multiFileReason: string): WheelMenu {
  if (fileCount <= 1) return menu;
  return {
    ...menu,
    sectors: menu.sectors.map((s) => (s.batch || !s.enabled ? s : { ...s, enabled: false, reason: multiFileReason })),
  };
}

/** All menus the native helper needs, keyed by MenuKey. */
export function buildHelperMenus(snapshot: CapabilitySnapshot, locale: Locale) {
  return MENU_KEYS.map((key) => ({
    key,
    convert: [...buildWheelMenu(snapshot, key, 'convert', locale).sectors],
    tools: [...buildWheelMenu(snapshot, key, 'tools', locale).sectors],
  }));
}

/** Extension → single-file menu key, for the formats this build can actually read. */
export function helperExtensionMap(snapshot: CapabilitySnapshot): Record<string, MenuKey> {
  const map: Record<string, MenuKey> = {};
  for (const format of decodableImages(snapshot.probe)) {
    for (const ext of FORMAT_INFO[format].extensions) map[ext] = `image/${format}`;
  }
  if (snapshot.probe.pdfRender || snapshot.probe.pdfText) {
    for (const ext of FORMAT_INFO.pdf.extensions) map[ext] = 'pdf';
  }
  return map;
}
