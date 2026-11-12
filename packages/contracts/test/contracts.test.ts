import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  actionTitle,
  ACTION_IDS,
  ACTION_OPTION_SCHEMAS,
  DEFAULT_SETTINGS,
  HelperToMainSchema,
  IMAGE_TOOLS_ORDER,
  MainToHelperSchema,
  baseMenuOrder,
  formatFromExtension,
  menuKeyFor,
  migrateSettings,
  applySettingsPatch,
  parseActionOptions,
  parseHelperLine,
  utf8ByteLength,
  wheelTokens,
  DEFAULT_WHEEL_GEOMETRY,
  ALLOWED_WEB_PAGES,
  ANTHROPIC_KEYS_URL,
  LicenseOpenRequestSchema,
  ORBITDROP_NEW_ISSUE,
  ORBITDROP_WEBSITE,
  RELEASES_URL,
  RendererErrorReportSchema,
  SettingsSchema,
  WindowOpenRequestSchema,
  defaultSettingsFor,
  isAllowedExternalUrl,
  isAllowedWebPage,
} from '../src';

describe('menus follow the reference recording', () => {
  it('PDF convert menu is DOCX, JPG, PNG, TXT clockwise from the top', () => {
    expect(baseMenuOrder('pdf', 'convert').map((id) => ACTIONS[id].wheelLabel.en)).toEqual(['DOCX', 'JPG', 'PNG', 'TXT']);
  });

  it('JPG convert menu is PNG, WEBP, HEIC, TIFF, AVIF, BMP, PDF, DOCX', () => {
    expect(baseMenuOrder('image/jpeg', 'convert').map((id) => ACTIONS[id].wheelLabel.en)).toEqual([
      'PNG', 'WEBP', 'HEIC', 'TIFF', 'AVIF', 'BMP', 'PDF', 'DOCX',
    ]);
  });

  it('image tools menu is COMPRESS, METADATA, EDIT, ANNOTATE, ADD BG, CROP, REDACT', () => {
    expect(IMAGE_TOOLS_ORDER.map((id) => ACTIONS[id].wheelLabel.en)).toEqual([
      'COMPRESS', 'METADATA', 'EDIT', 'ANNOTATE', 'ADD BG', 'CROP', 'REDACT',
    ]);
  });

  it('other image formats drop their own format and keep 8 sectors', () => {
    const png = baseMenuOrder('image/png', 'convert');
    expect(png).not.toContain('convert.png');
    expect(png).toHaveLength(8);
    expect(baseMenuOrder('images', 'convert')).toHaveLength(9);
  });

  it('classifies selections', () => {
    expect(menuKeyFor(['pdf'])).toBe('pdf');
    expect(menuKeyFor(['pdf', 'pdf'])).toBe('pdf');
    expect(menuKeyFor(['jpeg', 'jpeg'])).toBe('image/jpeg');
    expect(menuKeyFor(['jpeg', 'png'])).toBe('images');
    expect(menuKeyFor(['jpeg', 'pdf'])).toBe('mixed');
    expect(menuKeyFor(['docx'])).toBeNull();
    expect(menuKeyFor(['jpeg', undefined])).toBeNull();
    expect(menuKeyFor([])).toBeNull();
    expect(baseMenuOrder('mixed', 'convert')).toEqual(['convert.docx', 'convert.jpeg', 'convert.png']);
    expect(baseMenuOrder('pdf', 'tools')).toEqual([]);
  });

  it('maps extensions case-insensitively', () => {
    expect(formatFromExtension('.JPEG')).toBe('jpeg');
    expect(formatFromExtension('heif')).toBe('heic');
    expect(formatFromExtension('.exe')).toBeUndefined();
  });
});

describe('action titles', () => {
  it('names DOCX by what it does for the selected inputs', () => {
    expect(actionTitle('convert.docx', ['pdf']).ko).toBe('DOCX로 변환 (텍스트 중심)');
    expect(actionTitle('convert.docx', ['image']).ko).toBe('DOCX로 변환 (이미지 삽입, OCR 없음)');
    expect(actionTitle('convert.docx', ['pdf', 'image']).en).toBe('Convert to DOCX (PDF text-focused, images embedded)');
    expect(actionTitle('convert.jpeg', ['image'])).toBe(ACTIONS['convert.jpeg'].title);
  });
});

describe('option schemas', () => {
  it('every action has a schema', () => {
    for (const id of ACTION_IDS) expect(ACTION_OPTION_SCHEMAS[id]).toBeDefined();
  });

  it('fills defaults and rejects unknown keys', () => {
    expect(parseActionOptions('convert.jpeg', {}).flattenBackground).toBe('#FFFFFF');
    expect(() => parseActionOptions('convert.jpeg', { evil: 1 })).toThrow();
    expect(() => parseActionOptions('tool.crop', { rect: { x: 0, y: 0, width: 0, height: 10 } })).toThrow();
    const crop = parseActionOptions('tool.crop', { rect: { x: 1, y: 2, width: 3, height: 4 } });
    expect(crop.aspect).toBe('free');
  });
});

describe('settings', () => {
  it('defaults are valid and conservative', () => {
    expect(DEFAULT_SETTINGS.launchAtLogin).toBe(false);
    expect(DEFAULT_SETTINGS.pdf.dpi).toBe(300);
    expect(DEFAULT_SETTINGS.background.maxEdge).toBe(2400);
    expect(DEFAULT_SETTINGS.globalDrag.convertModifiers).toEqual(['shift']);
  });

  it('migrates garbage section by section', () => {
    const migrated = migrateSettings({ locale: 'en', pdf: { dpi: 999 }, output: { jpegQuality: 70 } });
    expect(migrated.locale).toBe('en');
    expect(migrated.pdf.dpi).toBe(300);
    expect(migrated.output.jpegQuality).toBe(70);
    expect(migrateSettings('nope')).toEqual(DEFAULT_SETTINGS);
  });

  it('automatic update checks are on by default and settings files without `updates` get it', () => {
    expect(DEFAULT_SETTINGS.updates).toEqual({ autoCheck: true });
    // A settings.json written before the updates section existed (same SETTINGS_VERSION).
    const older = { version: 1, locale: 'en', notifications: false, launchAtLogin: true };
    const migrated = migrateSettings(older);
    expect(migrated.updates).toEqual({ autoCheck: true });
    expect(migrated).toMatchObject({ version: 1, locale: 'en', notifications: false, launchAtLogin: true });
    // Also a pre-release file without a version field.
    expect(migrateSettings({ locale: 'en' }).updates.autoCheck).toBe(true);
  });

  it('keeps a stored `updates` section and resets only that section when it is invalid', () => {
    expect(migrateSettings({ version: 1, updates: { autoCheck: false } }).updates).toEqual({ autoCheck: false });
    for (const bad of [{ autoCheck: 'no' }, { autoCheck: false, channel: 'beta' }, 'off', null]) {
      const migrated = migrateSettings({ version: 1, locale: 'en', updates: bad });
      expect(migrated.updates, JSON.stringify(bad)).toEqual({ autoCheck: true });
      expect(migrated.locale).toBe('en');
    }
  });

  it('patches the updates section like any other', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { updates: { autoCheck: false } })?.updates.autoCheck).toBe(false);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { updates: { autoCheck: 'yes' } })).toBeNull();
    expect(applySettingsPatch(DEFAULT_SETTINGS, { updates: { url: 'https://example.com' } })).toBeNull();
  });

  it('applies patches and refuses invalid ones', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { pdf: { dpi: 150 } })?.pdf.dpi).toBe(150);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { pdf: { dpi: 72 } })).toBeNull();
    expect(applySettingsPatch(DEFAULT_SETTINGS, { version: 99 })?.version).toBe(1);
  });

  it('onboarding is an additive section after notifications (no version bump), welcome not shown yet', () => {
    const keys = Object.keys(SettingsSchema.shape);
    expect(keys.indexOf('onboarding')).toBe(keys.indexOf('notifications') + 1);
    expect(DEFAULT_SETTINGS.onboarding).toEqual({ welcomeDone: false, moveToApplicationsAsked: false });
    expect(DEFAULT_SETTINGS.version).toBe(1);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { onboarding: { welcomeDone: true } })?.onboarding).toEqual({ welcomeDone: true, moveToApplicationsAsked: false });
    expect(applySettingsPatch(DEFAULT_SETTINGS, { onboarding: { welcomeDone: 'yes' } })).toBeNull();
  });

  it('platform defaults: Windows opens the tools wheel with Ctrl+Shift, macOS keeps Option+Shift', () => {
    expect(defaultSettingsFor('win32').globalDrag.toolsModifiers).toEqual(['control', 'shift']);
    expect(defaultSettingsFor('darwin')).toBe(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.globalDrag.toolsModifiers).toEqual(['alt', 'shift']);
    expect(SettingsSchema.safeParse(defaultSettingsFor('win32')).success).toBe(true);
  });

  it('migration fills gaps and failed sections from the given defaults', () => {
    const win = defaultSettingsFor('win32');
    expect(migrateSettings({ locale: 'en' }, win)).toEqual({ ...win, locale: 'en' });
    expect(migrateSettings({ globalDrag: { wheelDiameter: 9999 } }, win).globalDrag).toEqual(win.globalDrag);
    expect(migrateSettings({ globalDrag: { toolsModifiers: ['alt', 'shift'] } }, win).globalDrag.toolsModifiers).toEqual(['alt', 'shift']);
    expect(migrateSettings('nope', win)).toBe(win);
    expect(migrateSettings({})).toEqual(DEFAULT_SETTINGS);
  });
});

describe('external URLs', () => {
  it('web pages: exactly the website (ko, en), a new issue (with a prefilled query), the releases and the API key page', () => {
    expect(ALLOWED_WEB_PAGES.map((page) => `${page.origin}${page.path}`)).toEqual([ORBITDROP_WEBSITE.ko, ORBITDROP_WEBSITE.en, ORBITDROP_NEW_ISSUE, RELEASES_URL, ANTHROPIC_KEYS_URL]);
    for (const url of [ORBITDROP_WEBSITE.ko, ORBITDROP_WEBSITE.en, ORBITDROP_NEW_ISSUE, `${ORBITDROP_NEW_ISSUE}?title=a&body=b`, RELEASES_URL, ANTHROPIC_KEYS_URL]) {
      expect(isAllowedWebPage(url), url).toBe(true);
      expect(isAllowedExternalUrl(url), url).toBe(true);
    }
    for (const url of [
      'https://github.com/',
      `${RELEASES_URL}/tag/v1.0.0`,
      `${RELEASES_URL}?q=1`,
      'https://github.com/keilvher1/orbitdrop',
      `${ORBITDROP_WEBSITE.ko}?x=1`,
      `${ORBITDROP_WEBSITE.ko}#top`,
      'https://keilvher1.github.io/orbitdrop/../evil/',
      'http://keilvher1.github.io/orbitdrop/',
      'javascript:alert(1)',
      'not a url',
      // Claude analysis: the key page only — no other page of the console, no query, no other host.
      'https://platform.claude.com/settings/keys?token=x',
      'https://platform.claude.com/settings/',
      'https://platform.claude.com/',
      'http://platform.claude.com/settings/keys',
      'https://console.anthropic.com/settings/keys',
      'https://platform.claude.com.evil.example/settings/keys',
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(false);
    }
    // Non-web targets keep the prefix rule (security.ts narrows them further).
    expect(isAllowedExternalUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')).toBe(true);
    expect(isAllowedExternalUrl('ms-settings:privacy')).toBe(true);
  });
});

describe('first run, help and diagnostics IPC', () => {
  it('renderer error reports are strict and size-capped', () => {
    const ok = { source: 'boundary', message: 'boom', name: 'TypeError', stack: 'at x', componentStack: 'at Y' };
    expect(RendererErrorReportSchema.safeParse(ok).success).toBe(true);
    expect(RendererErrorReportSchema.safeParse({ source: 'bootstrap', message: '' }).success).toBe(true);
    for (const bad of [
      { ...ok, message: 'x'.repeat(4001) },
      { ...ok, stack: 'x'.repeat(16_001) },
      { ...ok, name: 'x'.repeat(201) },
      { ...ok, source: 'main' },
      { ...ok, extra: true },
      { source: 'boundary' },
    ]) {
      expect(RendererErrorReportSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('licence files are named, never given as paths; the welcome window can be opened', () => {
    expect(LicenseOpenRequestSchema.safeParse({ which: 'thirdParty' }).success).toBe(true);
    expect(LicenseOpenRequestSchema.safeParse({ which: '/etc/passwd' }).success).toBe(false);
    expect(WindowOpenRequestSchema.safeParse({ kind: 'welcome' }).success).toBe(true);
    expect(WindowOpenRequestSchema.safeParse({ kind: 'editor' }).success).toBe(false);
  });
});

describe('helper protocol', () => {
  it('accepts a valid drop and rejects unknown actions or move effects', () => {
    const drop = { v: 1, type: 'drop', sessionId: 's-1', actionId: 'convert.jpeg', mode: 'convert', files: ['/a/b.pdf'], dropEffect: 'copy' };
    expect(parseHelperLine(JSON.stringify(drop))).not.toBeNull();
    expect(parseHelperLine(JSON.stringify({ ...drop, actionId: 'rm.everything' }))).toBeNull();
    expect(parseHelperLine(JSON.stringify({ ...drop, dropEffect: 'move' }))).toBeNull();
    expect(parseHelperLine(JSON.stringify({ ...drop, v: 2 }))).toBeNull();
    expect(parseHelperLine('{not json')).toBeNull();
    expect(HelperToMainSchema.safeParse({ ...drop, files: [] }).success).toBe(false);
  });

  it('builds a configure message the helper schema accepts', () => {
    const msg = {
      v: 1,
      type: 'configure',
      enabled: true,
      locale: 'ko',
      geometry: DEFAULT_WHEEL_GEOMETRY,
      tokens: wheelTokens('light', false),
      reduceMotion: false,
      highContrast: false,
      modifiers: { convert: ['shift'], tools: ['alt', 'shift'] },
      extensions: { '.pdf': 'pdf', '.jpg': 'image/jpeg' },
      menus: [],
      strings: { dropHint: '놓기', unsupported: '지원 안 함', multiFileUnsupported: '한 장씩', fileCount: '{n}개' },
    };
    expect(MainToHelperSchema.safeParse(msg).success).toBe(true);
    const specific = { ...msg, strings: { ...msg.strings, unsupportedFolder: '폴더', unsupportedNonFile: '파일 아님', unsupportedVirtual: '가상 파일' } };
    expect(MainToHelperSchema.safeParse(specific).success).toBe(true);
    expect(MainToHelperSchema.safeParse({ ...msg, strings: { ...msg.strings, unsupportedOther: 'x' } }).success).toBe(false);
  });

  it('measures UTF-8 lengths', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('한')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
  });
});
