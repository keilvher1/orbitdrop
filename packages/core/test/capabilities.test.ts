import { describe, expect, it } from 'vitest';
import {
  ACTION_IDS,
  DEFAULT_WHEEL_GEOMETRY,
  HELPER_PROTOCOL_VERSION,
  HelperConfigureSchema,
  HelperMenuSchema,
  MENU_KEYS,
  WHEEL_MODES,
  wheelTokens,
  type ActionId,
  type CapabilitySnapshot,
  type InputDescriptor,
  type WheelMenu,
} from '@orbitdrop/contracts';
import { adjustMenuForFileCount, buildCapabilitySnapshot, buildHelperMenus, buildWheelMenu, helperExtensionMap, isReadableFormat, supports } from '../src';
import {
  PROBE_DARWIN_ARM64,
  PROBE_DARWIN_ARM64_IMAGEIO,
  PROBE_DARWIN_NO_CANVAS,
  PROBE_DARWIN_NO_PDFJS,
  PROBE_DARWIN_NO_SHARP,
  PROBE_WIN32_X64,
} from '../src/golden/probes';

const mac = buildCapabilitySnapshot(PROBE_DARWIN_ARM64);

function sectors(snapshot: CapabilitySnapshot, key: Parameters<typeof buildWheelMenu>[1], mode: 'convert' | 'tools', locale: 'en' | 'ko' = 'en') {
  return buildWheelMenu(snapshot, key, mode, locale).sectors.map((s) => [s.label, s.enabled, s.reason ?? null] as const);
}

describe('capability snapshot from the measured darwin-arm64 probe', () => {
  it('enables what sharp + builtin BMP + PDF.js + pdf-lib + docx can do, and nothing else', () => {
    const enabled = ACTION_IDS.filter((id) => mac.actions[id].enabled);
    expect(enabled).toEqual(ACTION_IDS.filter((id) => id !== 'convert.heic'));
    expect(mac.actions['convert.heic']).toMatchObject({ enabled: false, inputKinds: [], reason: { en: 'No HEIC encoder in this build' } });
    expect(mac.actions['convert.jpeg'].inputKinds).toEqual(['image', 'pdf']);
    expect(mac.actions['convert.jpeg'].imageInputs).toEqual(['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif', 'bmp']);
    expect(mac.actions['convert.webp'].inputKinds).toEqual(['image']);
    expect(mac.actions['convert.txt']).toMatchObject({ inputKinds: ['pdf'], imageInputs: [] });
    expect(mac.actions['convert.docx'].inputKinds).toEqual(['pdf', 'image']);
    expect(mac.actions['tool.crop'].inputKinds).toEqual(['image']);
    expect(mac.actions['tool.crop'].imageInputs).not.toContain('heic');
  });

  it('JPG convert menu: reference order, HEIC greyed with a reason', () => {
    expect(sectors(mac, 'image/jpeg', 'convert')).toEqual([
      ['PNG', true, null],
      ['WEBP', true, null],
      ['HEIC', false, 'No HEIC encoder in this build'],
      ['TIFF', true, null],
      ['AVIF', true, null],
      ['BMP', true, null],
      ['PDF', true, null],
      ['DOCX', true, null],
    ]);
    expect(sectors(mac, 'image/jpeg', 'convert', 'ko')[2]).toEqual(['HEIC', false, 'HEIC 인코더가 이 빌드에 없음']);
  });

  it('PDF menu, tools menu and mixed menu', () => {
    expect(sectors(mac, 'pdf', 'convert')).toEqual([
      ['DOCX', true, null],
      ['JPG', true, null],
      ['PNG', true, null],
      ['TXT', true, null],
    ]);
    expect(buildWheelMenu(mac, 'pdf', 'tools', 'en').sectors).toEqual([]);
    expect(sectors(mac, 'image/png', 'tools').map(([label, enabled]) => [label, enabled])).toEqual([
      ['COMPRESS', true],
      ['METADATA', true],
      ['EDIT', true],
      ['ANNOTATE', true],
      ['ADD BG', true],
      ['CROP', true],
      ['REDACT', true],
    ]);
    expect(sectors(mac, 'mixed', 'convert').map(([label]) => label)).toEqual(['DOCX', 'JPG', 'PNG']);
    expect(buildWheelMenu(mac, 'mixed', 'tools', 'en').sectors).toEqual([]);
    expect(sectors(mac, 'images', 'convert')).toHaveLength(9);
  });

  it('an undecodable format gets a fully disabled menu that says why', () => {
    const heic = sectors(mac, 'image/heic', 'convert');
    expect(heic.map(([label]) => label)).toEqual(['JPG', 'PNG', 'WEBP', 'TIFF', 'AVIF', 'BMP', 'PDF', 'DOCX']);
    expect(heic.every(([, enabled, reason]) => !enabled && reason === "This build can't read HEIC files")).toBe(true);
    expect(sectors(mac, 'image/heic', 'tools').every(([, enabled]) => !enabled)).toBe(true);
  });

  it('with the ImageIO helper HEIC is readable and writable', () => {
    const io = buildCapabilitySnapshot(PROBE_DARWIN_ARM64_IMAGEIO);
    expect(io.actions['convert.heic'].enabled).toBe(true);
    expect(sectors(io, 'image/heic', 'convert').every(([, enabled]) => enabled)).toBe(true);
    expect(sectors(io, 'image/jpeg', 'convert')[2]).toEqual(['HEIC', true, null]);
  });

  it('Windows has the same codecs but no HEIC', () => {
    const win = buildCapabilitySnapshot(PROBE_WIN32_X64);
    expect(win.actions['convert.heic'].enabled).toBe(false);
    expect(helperExtensionMap(win)).not.toHaveProperty(['.heic']);
  });
});

describe('degraded engines', () => {
  it('no canvas: PDF pages cannot be rendered, text tools still work', () => {
    const s = buildCapabilitySnapshot(PROBE_DARWIN_NO_CANVAS);
    expect(sectors(s, 'pdf', 'convert')).toEqual([
      ['DOCX', true, null],
      ['JPG', false, 'PDF renderer unavailable'],
      ['PNG', false, 'PDF renderer unavailable'],
      ['TXT', true, null],
    ]);
    expect(s.actions['tool.annotate']).toMatchObject({ enabled: false, reason: { en: 'Drawing engine unavailable' } });
    expect(sectors(s, 'mixed', 'convert').map(([label, enabled]) => [label, enabled])).toEqual([
      ['DOCX', true],
      ['JPG', false],
      ['PNG', false],
    ]);
    expect(helperExtensionMap(s)).toHaveProperty(['.pdf'], 'pdf');
  });

  it('no PDF.js: PDFs are not offered at all', () => {
    const s = buildCapabilitySnapshot(PROBE_DARWIN_NO_PDFJS);
    expect(helperExtensionMap(s)).not.toHaveProperty(['.pdf']);
    expect(sectors(s, 'pdf', 'convert')).toEqual([
      ['DOCX', false, 'PDF text extraction unavailable'],
      ['JPG', false, 'PDF renderer unavailable'],
      ['PNG', false, 'PDF renderer unavailable'],
      ['TXT', false, 'PDF text extraction unavailable'],
    ]);
    expect(isReadableFormat(s.probe, 'pdf')).toBe(false);
  });

  it('no sharp: only BMP decodes; nothing that needs PNG/JPEG encoding is enabled', () => {
    const s = buildCapabilitySnapshot(PROBE_DARWIN_NO_SHARP);
    expect(Object.keys(helperExtensionMap(s))).toEqual(['.bmp', '.dib', '.pdf']);
    expect(s.actions['convert.pdf']).toMatchObject({ enabled: false, reason: { en: 'No PNG encoder in this build' } });
    expect(s.actions['tool.crop']).toMatchObject({ enabled: false, reason: { en: 'No PNG encoder in this build' } });
    expect(s.actions['convert.docx'].inputKinds).toEqual(['pdf']);
    const bmpMenu = sectors(s, 'image/bmp', 'convert');
    expect(bmpMenu.find(([label]) => label === 'DOCX')).toEqual(['DOCX', false, 'No PNG encoder in this build']);
    expect(bmpMenu.find(([label]) => label === 'JPG')).toEqual(['JPG', false, 'No JPG encoder in this build']);
    expect(sectors(s, 'pdf', 'convert').map(([label, enabled]) => [label, enabled])).toEqual([
      ['DOCX', true],
      ['JPG', false],
      ['PNG', false],
      ['TXT', true],
    ]);
  });
});

describe('supports()', () => {
  const img = (format: InputDescriptor['format']): InputDescriptor => ({ kind: 'image', format });
  const pdf: InputDescriptor = { kind: 'pdf', format: 'pdf' };

  it('never offers a conversion to the input format', () => {
    expect(supports(mac, 'convert.jpeg', img('jpeg'))).toBe(false);
    expect(supports(mac, 'convert.png', img('jpeg'))).toBe(true);
    expect(supports(mac, 'convert.bmp', img('bmp'))).toBe(false);
    expect(supports(mac, 'convert.pdf', pdf)).toBe(false);
  });

  it('accepts PDF input only where it is allowed', () => {
    const pdfOk = ACTION_IDS.filter((id) => supports(mac, id, pdf));
    expect(pdfOk).toEqual(['convert.jpeg', 'convert.png', 'convert.docx', 'convert.txt']);
    expect(supports(mac, 'convert.txt', img('png'))).toBe(false);
  });

  it('rejects undecodable inputs, inconsistent descriptors and other platforms', () => {
    expect(supports(mac, 'convert.png', img('heic'))).toBe(false);
    expect(supports(mac, 'tool.crop', img('heic'))).toBe(false);
    expect(supports(mac, 'convert.png', { kind: 'pdf', format: 'jpeg' })).toBe(false);
    expect(supports(mac, 'convert.png', { kind: 'image', format: 'pdf' })).toBe(false);
    expect(supports(mac, 'convert.png', { kind: 'image', format: 'docx' })).toBe(false);
    expect(supports(mac, 'convert.png', img('jpeg'), 'win32')).toBe(false);
    expect(supports(mac, 'convert.heic', img('jpeg'))).toBe(false);
  });

  it('agrees with the wheel: an enabled single-format sector is supported for that format', () => {
    for (const key of MENU_KEYS) {
      if (!key.startsWith('image/')) continue;
      const format = key.slice('image/'.length) as InputDescriptor['format'];
      for (const mode of WHEEL_MODES) {
        for (const s of buildWheelMenu(mac, key, mode, 'en').sectors) {
          expect(supports(mac, s.actionId, img(format))).toBe(s.enabled);
        }
      }
    }
  });
});

describe('file count adjustment', () => {
  const tools = buildWheelMenu(mac, 'image/jpeg', 'tools', 'en');

  it('keeps single-file menus unchanged', () => {
    expect(adjustMenuForFileCount(tools, 1, 'x')).toBe(tools);
    expect(adjustMenuForFileCount(tools, 0, 'x')).toBe(tools);
  });

  it('disables non-batch tools for several files, keeping batch tools and existing reasons', () => {
    const adjusted = adjustMenuForFileCount(tools, 3, 'Single file only');
    expect(adjusted.sectors.map((s) => [s.label, s.enabled, s.reason ?? null])).toEqual([
      ['COMPRESS', true, null],
      ['METADATA', true, null],
      ['EDIT', false, 'Single file only'],
      ['ANNOTATE', false, 'Single file only'],
      ['ADD BG', false, 'Single file only'],
      ['CROP', false, 'Single file only'],
      ['REDACT', false, 'Single file only'],
    ]);
    const convert = buildWheelMenu(mac, 'image/jpeg', 'convert', 'en');
    const multi = adjustMenuForFileCount(convert, 5, 'Single file only');
    expect(multi.sectors.find((s) => s.label === 'HEIC')?.reason).toBe('No HEIC encoder in this build');
    expect(multi.sectors.filter((s) => s.enabled)).toHaveLength(7);
    const custom: WheelMenu = { key: 'images', mode: 'tools', sectors: [{ actionId: 'tool.edit', label: 'EDIT', icon: 'edit', enabled: false, reason: 'busy', batch: false }] };
    expect(adjustMenuForFileCount(custom, 2, 'x').sectors[0]!.reason).toBe('busy');
  });
});

describe('helper configuration', () => {
  it('menus and extension map pass the helper protocol schema for both locales', () => {
    for (const locale of ['ko', 'en'] as const) {
      const menus = buildHelperMenus(mac, locale);
      expect(menus.map((m) => m.key)).toEqual([...MENU_KEYS]);
      for (const menu of menus) expect(HelperMenuSchema.safeParse(menu).success).toBe(true);
      const message = {
        v: HELPER_PROTOCOL_VERSION,
        type: 'configure',
        enabled: true,
        locale,
        geometry: DEFAULT_WHEEL_GEOMETRY,
        tokens: wheelTokens('light', false),
        reduceMotion: false,
        highContrast: false,
        modifiers: { convert: ['shift'], tools: ['alt', 'shift'] },
        extensions: helperExtensionMap(mac),
        menus,
        strings: { dropHint: 'Drop here', unsupported: 'Unsupported', multiFileUnsupported: 'Single file only', fileCount: '{n} files' },
      };
      const parsed = HelperConfigureSchema.safeParse(message);
      expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    }
  });

  it('extension map covers every readable extension and nothing undecodable', () => {
    expect(helperExtensionMap(mac)).toEqual({
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.jpe': 'image/jpeg',
      '.jfif': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.tif': 'image/tiff',
      '.tiff': 'image/tiff',
      '.avif': 'image/avif',
      '.bmp': 'image/bmp',
      '.dib': 'image/bmp',
      '.pdf': 'pdf',
    });
  });

  it('every enabled action has an input kind and every disabled one a localized reason', () => {
    for (const snapshot of [mac, buildCapabilitySnapshot(PROBE_DARWIN_NO_SHARP), buildCapabilitySnapshot(PROBE_DARWIN_NO_PDFJS)]) {
      for (const id of ACTION_IDS as readonly ActionId[]) {
        const cap = snapshot.actions[id];
        if (cap.enabled) expect(cap.inputKinds.length).toBeGreaterThan(0);
        else expect(cap.reason?.ko && cap.reason.en).toBeTruthy();
      }
    }
  });
});
