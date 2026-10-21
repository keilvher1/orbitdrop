import { ERROR_CODES, WARNING_CODES } from '@orbitdrop/contracts';
import { describe, expect, it } from 'vitest';
import enErrors from '../../src/shared/locales/en/errors.json';
import enUi from '../../src/shared/locales/en/ui.json';
import koErrors from '../../src/shared/locales/ko/errors.json';
import koUi from '../../src/shared/locales/ko/ui.json';
import { createTranslator, interpolate } from '../../src/renderer/src/i18n/catalog';
import { formatBytes, percentChange } from '../../src/renderer/src/i18n/format';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('locale catalogs', () => {
  it('ko and en ui.json have identical key sets', () => {
    expect(Object.keys(enUi).sort()).toEqual(Object.keys(koUi).sort());
  });

  it('ko and en errors.json have identical key sets', () => {
    expect(Object.keys(enErrors).sort()).toEqual(Object.keys(koErrors).sort());
  });

  it.each(['ko', 'en'] as const)('every ErrorCode and WarningCode has a %s message', (locale) => {
    const errors: Record<string, string> = locale === 'ko' ? koErrors : enErrors;
    for (const code of ERROR_CODES) expect(errors[`error.${code}`], `error.${code}`).toMatch(/\S/);
    for (const code of WARNING_CODES) expect(errors[`warning.${code}`], `warning.${code}`).toMatch(/\S/);
  });

  it('errors.json contains nothing but error.* and warning.* for known codes', () => {
    const known = new Set([...ERROR_CODES.map((c) => `error.${c}`), ...WARNING_CODES.map((c) => `warning.${c}`)]);
    for (const key of Object.keys(koErrors)) expect(known.has(key), key).toBe(true);
  });

  it('no message is empty and both languages use the same placeholders', () => {
    const ko: Record<string, string> = { ...koUi, ...koErrors };
    const en: Record<string, string> = { ...enUi, ...enErrors };
    for (const key of Object.keys(ko)) {
      expect(ko[key], key).toMatch(/\S/);
      expect(en[key], key).toMatch(/\S/);
      expect(placeholders(en[key] ?? ''), key).toEqual(placeholders(ko[key] ?? ''));
    }
  });

  it('plural keys come in .one/.other pairs', () => {
    for (const key of Object.keys(koUi)) {
      if (key.endsWith('.one')) expect(Object.keys(koUi)).toContain(key.replace(/\.one$/, '.other'));
      if (key.endsWith('.other')) expect(Object.keys(koUi)).toContain(key.replace(/\.other$/, '.one'));
    }
  });
});

describe('translator', () => {
  it('defaults to Korean strings and interpolates params', () => {
    const t = createTranslator('ko');
    expect(t('mode.convert')).toBe('변환');
    expect(t('common.dimensions', { width: 10, height: 20 })).toBe('10 × 20 px');
    expect(createTranslator('en')('mode.tools')).toBe('Tools');
  });

  it('picks plural forms by count', () => {
    const en = createTranslator('en');
    expect(en.plural('common.files', 1)).toBe('1 file');
    expect(en.plural('common.files', 3)).toBe('3 files');
    expect(createTranslator('ko').plural('common.files', 3)).toBe('파일 3개');
  });

  it('maps error codes and falls back to INTERNAL for unknown ones', () => {
    const t = createTranslator('ko');
    expect(t.error({ code: 'PDF_ENCRYPTED' })).toContain('암호');
    expect(t.error('NOT_A_CODE' as never)).toBe(t('error.INTERNAL'));
    expect(createTranslator('en').warning('OUTPUT_LARGER_THAN_INPUT')).toMatch(/isn't smaller/);
  });

  it('leaves unknown placeholders visible', () => {
    expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
  });
});

describe('formatting', () => {
  it('formats sizes like the OS file manager', () => {
    expect(formatBytes(1_234_567, 'en', 'darwin')).toBe('1.2 MB');
    expect(formatBytes(1_234_567, 'en', 'win32')).toBe('1.2 MB');
    expect(formatBytes(999, 'ko')).toBe('999 B');
    expect(formatBytes(15_300_000, 'en')).toBe('15 MB');
  });

  it('computes percentage change', () => {
    expect(percentChange(200, 100)).toBe(-50);
    expect(percentChange(100, 105)).toBe(5);
    expect(percentChange(0, 10)).toBe(0);
  });
});
