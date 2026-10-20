import { describe, expect, it } from 'vitest';
import { MAX_NAME_BYTES, convertedName, numberedName, pageLabel, sanitizeBaseName, splitName, toolResultName, utf8Length } from '../src';

const bytes = (s: string) => new TextEncoder().encode(s).length;
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"/\\|?*]/u;
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

function assertSafeName(name: string): void {
  expect(bytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
  expect(name).toBe(name.normalize('NFC'));
  expect(FORBIDDEN.test(name)).toBe(false);
  expect(LONE.test(name)).toBe(false);
  expect(name.startsWith('.')).toBe(false);
  expect(/[ .]$/.test(name)).toBe(false);
}

describe('product naming examples', () => {
  it('follows the spec', () => {
    expect(convertedName('Page 001.pdf', '.jpg')).toBe('Page 001.jpg');
    expect(convertedName('report.pdf', '.jpg', { index: 0, count: 3 })).toBe('report-p001.jpg');
    expect(convertedName('report.pdf', '.jpg', { index: 0, count: 1 })).toBe('report.jpg');
    expect(toolResultName('photo.jpg', ' Cropped', '.jpg')).toBe('photo Cropped.jpg');
    expect(toolResultName('photo Cropped.jpg', ' With Background', '.png')).toBe('photo Cropped With Background.png');
    expect(toolResultName('Page 001 Cropped.jpg', ' With Background', '.png')).toBe('Page 001 Cropped With Background.png');
    expect(numberedName('photo.jpg', 1)).toBe('photo.jpg');
    expect(numberedName('photo.jpg', 2)).toBe('photo (2).jpg');
    expect(numberedName('archive.tar.gz', 3)).toBe('archive.tar (3).gz');
    expect(numberedName('README', 2)).toBe('README (2)');
  });

  it('pads page numbers to the document length', () => {
    expect(pageLabel(0, 3)).toBe('p001');
    expect(pageLabel(998, 999)).toBe('p999');
    expect(pageLabel(0, 1000)).toBe('p0001');
    expect(pageLabel(999, 1000)).toBe('p1000');
    expect(pageLabel(41, 12345)).toBe('p00042');
    expect(convertedName('scan.pdf', '.png', { index: 6, count: 2000 })).toBe('scan-p0007.png');
  });
});

describe('splitName', () => {
  it('splits at the last dot unless it is the first or last character', () => {
    expect(splitName('a.b.c')).toEqual({ base: 'a.b', ext: '.c' });
    expect(splitName('.hidden')).toEqual({ base: '.hidden', ext: '' });
    expect(splitName('trailing.')).toEqual({ base: 'trailing.', ext: '' });
    expect(splitName('none')).toEqual({ base: 'none', ext: '' });
  });
});

describe('sanitizeBaseName', () => {
  it('replaces characters Windows forbids and control characters', () => {
    expect(sanitizeBaseName('a:b*c?')).toBe('a_b_c_');
    expect(sanitizeBaseName('x<y>z|"q"\\/w')).toBe('x_y_z__q___w');
    expect(sanitizeBaseName('tab\there\u0000\u007f')).toBe('tab_here__');
  });

  it('removes trailing dots/spaces and leading dots (outputs are never hidden)', () => {
    expect(sanitizeBaseName('name. . ')).toBe('name');
    expect(sanitizeBaseName('...dots')).toBe('dots');
    expect(sanitizeBaseName('.orbitdrop.job.1234abcd.x')).toBe('orbitdrop.job.1234abcd.x');
    expect(sanitizeBaseName(' . ')).toBe('Untitled');
    expect(sanitizeBaseName('')).toBe('Untitled');
    expect(sanitizeBaseName('  leading spaces')).toBe('  leading spaces');
  });

  it('escapes Windows device names, also before an extension and with superscript digits', () => {
    expect(sanitizeBaseName('CON')).toBe('CON_');
    expect(sanitizeBaseName('con')).toBe('con_');
    expect(sanitizeBaseName('Aux ')).toBe('Aux_');
    expect(sanitizeBaseName('nul.tar')).toBe('nul_.tar');
    expect(sanitizeBaseName('COM0')).toBe('COM0_');
    expect(sanitizeBaseName('LPT9')).toBe('LPT9_');
    expect(sanitizeBaseName('COM¹')).toBe('COM¹_');
    expect(sanitizeBaseName('CONIN$')).toBe('CONIN$_');
    expect(sanitizeBaseName('CONSOLE')).toBe('CONSOLE');
    expect(sanitizeBaseName('COM10')).toBe('COM10');
    expect(sanitizeBaseName('my con')).toBe('my con');
    expect(convertedName('CON.pdf', '.jpg')).toBe('CON_.jpg');
    expect(convertedName('nul.tar.gz', '.png')).toBe('nul_.tar.png');
  });

  it('normalizes to NFC (Korean names from macOS are often NFD) and repairs lone surrogates', () => {
    const nfd = '사진'; // 사진 as jamo
    expect(sanitizeBaseName(nfd)).toBe('사진');
    expect(convertedName(`${nfd}.heic`, '.jpg')).toBe('사진.jpg');
    expect(sanitizeBaseName('bad\ud800name')).toBe('bad�name');
    expect(sanitizeBaseName('\udc00x')).toBe('�x');
    expect(sanitizeBaseName('ok🍊')).toBe('ok🍊');
  });
});

describe('255-byte limit', () => {
  it('trims long ASCII names to exactly the limit', () => {
    const name = convertedName(`${'a'.repeat(300)}.pdf`, '.jpg');
    expect(bytes(name)).toBe(255);
    expect(name.endsWith('.jpg')).toBe(true);
  });

  it('never splits a Korean syllable or an emoji, and keeps the extension and suffixes', () => {
    const korean = convertedName(`${'가'.repeat(100)}.pdf`, '.jpg');
    expect(korean).toBe(`${'가'.repeat(83)}.jpg`);
    expect(bytes(korean)).toBe(253);
    const emoji = toolResultName(`${'🍊'.repeat(80)}.png`, ' Cropped With Background', '.png');
    assertSafeName(emoji);
    expect(emoji.endsWith(' Cropped With Background.png')).toBe(true);
    expect([...emoji.replace(' Cropped With Background.png', '')].every((ch) => ch === '🍊')).toBe(true);
  });

  it('cuts only between grapheme clusters (ZWJ sequences, combining marks)', () => {
    const family = '👨‍👩‍👧'; // 18 bytes, one grapheme
    const name = convertedName(`${'a'.repeat(240)}${family}${'b'.repeat(20)}.pdf`, '.jpg');
    expect(name).toBe(`${'a'.repeat(240)}.jpg`);
    const combining = convertedName(`${'a'.repeat(249)}éxyz.pdf`, '.jpg'); // é as e + U+0301 (NFC → é, 2 bytes)
    expect(bytes(combining)).toBeLessThanOrEqual(255);
    expect(combining.normalize('NFD').endsWith('́.jpg') || combining.endsWith('a.jpg')).toBe(true);
  });

  it('cuts a single oversized grapheme cluster by code point instead of emptying the name', () => {
    const zalgo = `q${'\u0301\u0316'.repeat(80)}`; // one grapheme, 321 bytes (q has no precomposed forms)
    const name = convertedName(`${zalgo}.pdf`, '.jpg');
    assertSafeName(name);
    // NFC keeps the marks but orders them canonically (U+0316 before U+0301).
    expect(name.startsWith('q\u0316')).toBe(true);
    expect(name.endsWith('.jpg')).toBe(true);
    expect(bytes(name)).toBe(255);
  });

  it('drops dots and spaces left at the cut', () => {
    const name = convertedName(`${'a'.repeat(250)} . ${'b'.repeat(10)}.pdf`, '.jpg');
    expect(name).toBe(`${'a'.repeat(250)}.jpg`);
  });

  it('keeps numbered and multi-page names within the limit', () => {
    const base = convertedName(`${'한'.repeat(90)}.pdf`, '.jpg');
    const numbered = numberedName(base, 12);
    expect(numbered.endsWith(' (12).jpg')).toBe(true);
    assertSafeName(numbered);
    const page = convertedName(`${'😀'.repeat(70)}.pdf`, '.png', { index: 1233, count: 2000 });
    expect(page.endsWith('-p1234.png')).toBe(true);
    assertSafeName(page);
  });

  it('counts UTF-8 bytes like TextEncoder (lone surrogates as U+FFFD)', () => {
    for (const s of ['abc', 'é', '가', '🍊', 'a\ud800b', '👨‍👩']) expect(utf8Length(s)).toBe(bytes(s));
  });

  it('produces safe names for arbitrary input (deterministic fuzz)', () => {
    let seed = 12345;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };
    const pools = ['abc XYZ ', '.:*?"<>|\\/', '가나다한글', '🍊😀👨‍👩‍👧', '́̈', '\u0000\u001f', '𐀀\udfff', 'CONcon nul.'];
    for (let i = 0; i < 500; i += 1) {
      const length = next() % 160;
      let input = '';
      for (let j = 0; j < length; j += 1) {
        const pool = pools[next() % pools.length]!;
        input += pool[next() % pool.length];
      }
      const ext = ['.jpg', '.png', '.pdf', ''][next() % 4]!;
      assertSafeName(convertedName(input + ext, '.jpg'));
      assertSafeName(convertedName(input + ext, '.png', { index: next() % 50, count: 50 + (next() % 3000) }));
      assertSafeName(toolResultName(input + ext, ' Cropped With Background', '.png'));
      assertSafeName(numberedName(convertedName(input + ext, '.webp'), 2 + (next() % 998)));
    }
  });
});
