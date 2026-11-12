import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_WHEEL_GEOMETRY, HELPER_PROTOCOL_VERSION, HelperConfigureSchema, MENU_KEYS, OrbitError, wheelTokens } from '@orbitdrop/contracts';
import { adjustMenuForFileCount, buildCapabilitySnapshot, buildHelperMenus, buildWheelMenu, detectFormatFromHeader, helperExtensionMap, resolveSubmission, supports } from '../src';
import { PROBE_DARWIN_ARM64, PROBE_DARWIN_NO_PDFJS, PROBE_DARWIN_NO_SHARP, PROBE_WIN32_X64 } from '../src/golden/probes';
import { validateInputFile } from '../src/node';

const mac = buildCapabilitySnapshot(PROBE_DARWIN_ARM64);
const labels = (key: Parameters<typeof buildWheelMenu>[1], mode: 'convert' | 'tools', analysis: boolean, locale: 'en' | 'ko' = 'en') =>
  buildWheelMenu(mac, key, mode, locale, { analysis }).sectors.map((s) => [s.label, s.enabled, s.icon] as const);

describe('Claude analysis capability', () => {
  it('runs on every decodable image and on PDFs whenever the engines are there (being offered is the user’s choice)', () => {
    expect(mac.actions['tool.analyze']).toMatchObject({ enabled: true, inputKinds: ['image', 'pdf'] });
    expect(mac.actions['tool.analyze'].imageInputs).toEqual(mac.actions['tool.crop'].imageInputs);
    expect(supports(mac, 'tool.analyze', { kind: 'pdf', format: 'pdf' })).toBe(true);
    expect(supports(mac, 'tool.analyze', { kind: 'image', format: 'jpeg' })).toBe(true);
    expect(supports(mac, 'tool.analyze', { kind: 'image', format: 'heic' })).toBe(false); // not decodable without ImageIO
    expect(buildCapabilitySnapshot(PROBE_WIN32_X64).actions['tool.analyze'].enabled).toBe(true);
  });

  it('degrades with the engines: no sharp → PDFs only; no PDF.js → images only', () => {
    expect(buildCapabilitySnapshot(PROBE_DARWIN_NO_SHARP).actions['tool.analyze']).toMatchObject({ enabled: true, inputKinds: ['pdf'], imageInputs: [] });
    expect(buildCapabilitySnapshot(PROBE_DARWIN_NO_PDFJS).actions['tool.analyze']).toMatchObject({ enabled: true, inputKinds: ['image'] });
    const noMd = buildCapabilitySnapshot({ ...PROBE_DARWIN_ARM64, formats: { ...PROBE_DARWIN_ARM64.formats, md: { input: false, output: false, inputEngine: 'none', outputEngine: 'none' } } });
    expect(noMd.actions['tool.analyze']).toMatchObject({ enabled: false, reason: { en: 'No MD encoder in this build' } });
  });

  it('a mixed selection submits one job per file (batch, no editor) when analysis is offered', () => {
    const selection = {
      selectionId: 'sel_1',
      source: 'test' as const,
      files: [
        { fileId: 'f1', name: 'a.pdf', ext: '.pdf', format: 'pdf' as const, kind: 'pdf' as const, bytes: 10 },
        { fileId: 'f2', name: 'b.jpg', ext: '.jpg', format: 'jpeg' as const, kind: 'image' as const, bytes: 10 },
      ],
      menuKey: 'mixed' as const,
    };
    expect(resolveSubmission(selection, 'tool.analyze', mac)).toMatchObject({ kind: 'plan', needsEditor: false, merges: false, jobs: [['f1'], ['f2']] });
  });
});

describe('wheel menus with and without Claude analysis', () => {
  it('without it every menu and the helper configuration are exactly what they were', () => {
    for (const key of MENU_KEYS) {
      for (const mode of ['convert', 'tools'] as const) {
        expect(buildWheelMenu(mac, key, mode, 'en', { analysis: false }), `${key} ${mode}`).toEqual(buildWheelMenu(mac, key, mode, 'en'));
      }
    }
    expect(buildHelperMenus(mac, 'ko', { analysis: false })).toEqual(buildHelperMenus(mac, 'ko'));
    for (const menu of buildHelperMenus(mac, 'ko')) {
      expect([...menu.convert, ...menu.tools].some((s) => s.actionId === 'tool.analyze'), menu.key).toBe(false);
    }
    expect(buildWheelMenu(mac, 'pdf', 'tools', 'en').sectors).toEqual([]);
    expect(buildWheelMenu(mac, 'mixed', 'tools', 'en').sectors).toEqual([]);
  });

  it('with it: ANALYZE (sparkles) ends the image tools wheel and is the PDF / mixed tools wheel', () => {
    expect(labels('image/png', 'tools', true)).toEqual([
      ['COMPRESS', true, 'compress'],
      ['METADATA', true, 'metadata'],
      ['EDIT', true, 'edit'],
      ['ANNOTATE', true, 'annotate'],
      ['ADD BG', true, 'background'],
      ['CROP', true, 'crop'],
      ['REDACT', true, 'redact'],
      ['ANALYZE', true, 'analyze'],
    ]);
    expect(labels('pdf', 'tools', true, 'ko')).toEqual([['Claude 분석', true, 'analyze']]);
    expect(labels('mixed', 'tools', true)).toEqual([['ANALYZE', true, 'analyze']]);
    expect(labels('pdf', 'convert', true)).toEqual(labels('pdf', 'convert', false));
    // An undecodable format: the whole tools wheel, analysis included, says why.
    expect(buildWheelMenu(mac, 'image/heic', 'tools', 'en', { analysis: true }).sectors.every((s) => !s.enabled && s.reason === "This build can't read HEIC files")).toBe(true);
    // Several files: analysis is a batch action and stays enabled.
    const several = adjustMenuForFileCount(buildWheelMenu(mac, 'images', 'tools', 'en', { analysis: true }), 3, 'Single file only');
    expect(several.sectors.at(-1)).toMatchObject({ actionId: 'tool.analyze', enabled: true });
  });

  it('a configure message with analysis passes the helper protocol schema in both languages', () => {
    for (const locale of ['ko', 'en'] as const) {
      const menus = buildHelperMenus(mac, locale, { analysis: true });
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
      expect(menus.find((m) => m.key === 'pdf')?.tools.map((s) => s.actionId)).toEqual(['tool.analyze']);
    }
    // The extension map does not change: .md is never a menu.
    expect(helperExtensionMap(mac)).not.toHaveProperty(['.md']);
  });
});

describe('Markdown stays an output-only format', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitdrop-md-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a dropped .md file is UNSUPPORTED_FORMAT (no signature, output only) — header sniffing is unchanged', async () => {
    const md = join(dir, 'notes.md');
    await writeFile(md, '# Notes\n\nSome *markdown*.\n');
    expect(detectFormatFromHeader(new TextEncoder().encode('# Notes\n'))).toBeNull();
    const failure = await validateInputFile(md).then(
      () => null,
      (error: unknown) => error as OrbitError,
    );
    expect(failure?.code).toBe('UNSUPPORTED_FORMAT');
    // A PNG named .md is processed as the PNG it is (and flagged).
    const png = join(dir, 'picture.md');
    await writeFile(png, Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'));
    expect(await validateInputFile(png)).toMatchObject({ format: 'png', kind: 'image', extensionMismatch: true });
  });
});
