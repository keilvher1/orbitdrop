import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, WARNING_CODES } from '@orbitdrop/contracts';
import en from '../../src/shared/locales/en/main.json';
import ko from '../../src/shared/locales/ko/main.json';
import { errorText, t, warningSentence } from '../../src/main/i18n';
import { parseLaunchOptions } from '../../src/main/launch-options';
import { INFORMATIONAL_WARNINGS, WARNING_TEXT } from '../../src/main/notifications';
import { redactPaths, scrubPaths } from '../../src/main/log';
import { workerEnv } from '../../src/main/processing/electron-worker';
import { errorFromInfo } from '../../src/main/processing/pool';
import { failedProbe, probeHasEngines } from '../../src/main/processing/probe-fallback';
import { publicErrorInfo } from '../../src/main/util/errors';
import { drawTrayGlyph } from '../../src/main/tray/glyph';
import { newId, newToken, ID_PATTERN } from '../../src/main/util/ids';
import { readJpegSize } from '../../src/main/util/jpeg';
import { encodePng, testPattern } from '../../src/main/util/png';
import { MAIN_UV_THREADPOOL_SIZE, ORIGINAL_UV_THREADPOOL_SIZE, threadpoolSize } from '../../src/main/uv-threadpool';
import { probeWith } from './helpers';

describe('PNG encoder', () => {
  it('produces a PNG that decodes to the same pixels', async () => {
    const pixels = testPattern(13, 7, 200);
    const png = encodePng(13, 7, pixels);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([13, 7, 4]);
    expect(Buffer.from(data).equals(Buffer.from(pixels))).toBe(true);
  });

  it('the generated tray glyph is a real transparent icon', async () => {
    const png = encodePng(32, 32, drawTrayGlyph(32));
    const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const alpha = [...data].filter((_, i) => i % 4 === 3);
    expect(alpha.some((a) => a === 0)).toBe(true);
    expect(alpha.some((a) => a === 255)).toBe(true);
  });
});

describe('readJpegSize', () => {
  it('reads the size of real JPEGs (baseline and progressive) and rejects other data', async () => {
    const raw = { raw: { width: 37, height: 21, channels: 3 as const } };
    const pixels = Buffer.alloc(37 * 21 * 3, 128);
    expect(readJpegSize(await sharp(pixels, raw).jpeg().toBuffer())).toEqual({ width: 37, height: 21 });
    expect(readJpegSize(await sharp(pixels, raw).jpeg({ progressive: true }).withMetadata().toBuffer())).toEqual({ width: 37, height: 21 });
    expect(readJpegSize(encodePng(2, 2, testPattern(2, 2)))).toBeNull();
    expect(readJpegSize(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe('redactPaths', () => {
  it('removes POSIX, Windows, UNC, home and file:// paths but keeps ordinary text', () => {
    expect(redactPaths('open /Users/kim/Desktop/a.png failed')).toBe('open <path> failed');
    expect(redactPaths('ENOENT: no such file, open "C:\\Users\\kim\\a.png"')).toBe('ENOENT: no such file, open "<path>"');
    expect(redactPaths('share \\\\server\\photos\\x.jpg')).toBe('share <path>');
    expect(redactPaths('at ~/secret/file.txt')).toBe('at <path>');
    expect(redactPaths('url file:///Users/kim/x.pdf')).toBe('url <path>');
    expect(redactPaths('progress 1/2 done, ratio 16:9')).toBe('progress 1/2 done, ratio 16:9');
  });
});

describe('path scrubbing for renderer-facing errors', () => {
  it('removes quoted paths with spaces and leftover path fragments', () => {
    expect(redactPaths('"/Users/kim/My Photos/a.png" is not a known file format')).toBe('"<path>" is not a known file format');
    expect(scrubPaths('Input file is missing: /Users/kim/My Photos/a.png')).toBe('Input file is missing: <path>');
    expect(scrubPaths('read failed: relative/inner/part.png and more')).toBe('read failed: <path> and more');
    expect(scrubPaths("ENOENT: no such file or directory, open 'C:\\Users\\kim\\New folder\\x.png'")).toBe("ENOENT: no such file or directory, open '<path>'");
    expect(scrubPaths('Image could not be decoded')).toBe('Image could not be decoded');
  });

  it('publicErrorInfo keeps the code and drops paths from message and detail', () => {
    const info = publicErrorInfo({ code: 'IMAGE_CORRUPT', message: 'Image could not be decoded', detail: 'VipsJpeg: Premature end of input file /Volumes/Photos/IMG 1.jpg', retryable: false });
    expect(info).toEqual({ code: 'IMAGE_CORRUPT', message: 'Image could not be decoded', detail: 'VipsJpeg: Premature end of input file <path>', retryable: false });
    expect(errorFromInfo({ code: 'FILE_NOT_FOUND', message: "missing '/Users/kim/a b.png'", retryable: false }).message).toBe("missing '<path>'");
  });
});

describe('locales', () => {
  it('Korean and English main strings have the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
  });

  it('interpolates variables and has a message for every error code', () => {
    expect(t('ko', 'helper.fileCount', { n: 3 })).toBe('3개 파일');
    expect(t('en', 'tray.recentMore', { name: 'a.jpg', n: 2 })).toBe('a.jpg and 2 more');
    const internal = t('ko', 'error.INTERNAL');
    for (const code of ERROR_CODES) {
      expect(Object.hasOwn(ko, `error.${code}`), code).toBe(true);
      expect(errorText('ko', code).length).toBeGreaterThan(0);
      if (code !== 'INTERNAL') expect(errorText('ko', code), code).not.toBe(internal);
    }
  });

  it('every warning worth a look gives drag notifications a reason in both languages', () => {
    for (const code of WARNING_CODES) {
      if (INFORMATIONAL_WARNINGS.has(code)) continue;
      const key = WARNING_TEXT[code];
      for (const locale of ['ko', 'en'] as const) {
        const text = key !== undefined ? t(locale, key) : warningSentence(locale, code);
        expect(text, `${locale} ${code}`).toMatch(/\S/);
        expect(text, `${locale} ${code}`).not.toBe(key);
      }
    }
    expect(warningSentence('en', 'FIRST_FRAME_ONLY')).toMatch(/first frame/);
  });

  it('helper wheel strings fit the protocol limits', () => {
    for (const table of [ko, en]) {
      for (const key of ['helper.dropHint', 'helper.unsupported', 'helper.multiFileUnsupported', 'helper.fileCount'] as const) {
        expect(table[key].length).toBeLessThanOrEqual(60);
      }
    }
  });
});

describe('ids', () => {
  it('match the contracts id pattern and are unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId('job')));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(ID_PATTERN.test(id)).toBe(true);
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});

describe('probe fallback', () => {
  it('disables everything when the engines could not be probed', () => {
    const probe = failedProbe(['worker failed'], 'darwin', 'arm64');
    expect(probeHasEngines(probe)).toBe(false);
    expect(probe.errors).toEqual(['worker failed']);
    expect(probeHasEngines(probeWith())).toBe(true);
  });
});

describe('libuv thread pool size', () => {
  it('main raises the pool unless the user chose a size; parsing falls back to the libuv default', () => {
    expect(Number(process.env.UV_THREADPOOL_SIZE)).toBeGreaterThanOrEqual(ORIGINAL_UV_THREADPOOL_SIZE ? 1 : MAIN_UV_THREADPOOL_SIZE);
    expect(threadpoolSize({ UV_THREADPOOL_SIZE: '16' })).toBe(16);
    expect(threadpoolSize({ UV_THREADPOOL_SIZE: 'abc' })).toBe(4);
    expect(threadpoolSize({})).toBe(4);
    expect(threadpoolSize({ UV_THREADPOOL_SIZE: '5000' })).toBe(1024);
  });
});

describe('worker environment', () => {
  const inherited = { PATH: '/usr/bin', UV_THREADPOOL_SIZE: '16', ORBITDROP_PDFJS_DIR: '/tmp/planted', ORBITDROP_IMAGEIO_HELPER: '/tmp/planted-helper', ORBITDROP_PARENT_PID: '1', ORBITDROP_FUTURE_OVERRIDE: 'x' };

  it('main-owned variables always come from main, never from the inherited environment', () => {
    const env = workerEnv({ ORBITDROP_PARENT_PID: '4242', ORBITDROP_IMAGEIO_HELPER: undefined }, false, inherited);
    expect(env.ORBITDROP_PARENT_PID).toBe('4242');
    expect(env.ORBITDROP_IMAGEIO_HELPER).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.ORBITDROP_PDFJS_DIR).toBe('/tmp/planted'); // development override still works in dev builds
  });

  it('packaged builds pass no inherited ORBITDROP_* override (e.g. the folder PDF.js is imported from)', () => {
    const env = workerEnv({ ORBITDROP_PARENT_PID: '4242', ORBITDROP_IMAGEIO_HELPER: '/app/helper' }, true, inherited);
    expect(Object.keys(env).filter((key) => key.startsWith('ORBITDROP_')).sort()).toEqual(['ORBITDROP_IMAGEIO_HELPER', 'ORBITDROP_PARENT_PID']);
    expect(env.ORBITDROP_IMAGEIO_HELPER).toBe('/app/helper');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('compares names case-insensitively (Windows environment names are: orbitdrop_pdfjs_dir is ORBITDROP_PDFJS_DIR)', () => {
    const planted = { Path: 'C:\\Windows', orbitdrop_pdfjs_dir: 'C:\\evil', Orbitdrop_Imageio_Helper: 'C:\\evil\\helper.exe', orbitdrop_parent_pid: '1' };
    const packaged = workerEnv({ ORBITDROP_PARENT_PID: '4242' }, true, planted);
    expect(Object.keys(packaged).filter((key) => key.toUpperCase().startsWith('ORBITDROP_'))).toEqual(['ORBITDROP_PARENT_PID']);
    expect(packaged.Path).toBe('C:\\Windows');
    // Development builds keep dev overrides but never an inherited main-owned variable, whatever its spelling.
    const dev = workerEnv({ ORBITDROP_PARENT_PID: '4242' }, false, planted);
    expect(dev.orbitdrop_pdfjs_dir).toBe('C:\\evil');
    expect(Object.keys(dev).filter((key) => ['ORBITDROP_IMAGEIO_HELPER', 'ORBITDROP_PARENT_PID'].includes(key.toUpperCase()))).toEqual(['ORBITDROP_PARENT_PID']);
  });
});

describe('launch options', () => {
  it('parses the smoke test flag and automation switches', () => {
    expect(parseLaunchOptions(['electron', '.', '--smoke-test'], {})).toMatchObject({ smokeTest: true, noTray: true, disableHelper: false });
    expect(parseLaunchOptions(['electron', '.'], { ORBITDROP_E2E: '1', ORBITDROP_USER_DATA_DIR: '/tmp/x' })).toMatchObject({
      e2e: true,
      noTray: true,
      disableHelper: true,
      userDataDir: '/tmp/x',
      smokeTest: false,
    });
    expect(parseLaunchOptions([], { ORBITDROP_SMOKE_OPTIONAL_HELPER: '1' }).smokeOptionalHelper).toBe(true);
    expect(parseLaunchOptions([], { ORBITDROP_E2E: '1', ORBITDROP_E2E_TRAY: '1', ORBITDROP_E2E_HELPER: '1' })).toMatchObject({ noTray: false, disableHelper: false });
    expect(parseLaunchOptions([], {})).toMatchObject({ e2e: false, noTray: false, disableHelper: false, userDataDir: null });
    // packaged builds ignore the automation switches
    expect(parseLaunchOptions([], { ORBITDROP_E2E: '1' }, true)).toMatchObject({ e2e: false, noTray: false, disableHelper: false });
  });

  it('packaged builds ignore every development switch except the smoke test and debug logging', () => {
    const planted = {
      ORBITDROP_E2E: '1',
      ORBITDROP_E2E_TRAY: '1',
      ORBITDROP_E2E_HELPER: '1',
      ORBITDROP_USER_DATA_DIR: '/tmp/planted',
      ORBITDROP_NO_TRAY: '1',
      ORBITDROP_DISABLE_HELPER: '1',
      ORBITDROP_DEBUG: '1',
    };
    expect(parseLaunchOptions(['OrbitDrop'], planted, true)).toEqual({
      smokeTest: false,
      smokeOptionalHelper: false,
      e2e: false,
      disableHelper: false,
      noTray: false,
      userDataDir: null,
      debug: true,
    });
    // The same switches work in development builds.
    expect(parseLaunchOptions(['electron', '.'], { ORBITDROP_USER_DATA_DIR: '/tmp/dev', ORBITDROP_NO_TRAY: '1', ORBITDROP_DISABLE_HELPER: '1' })).toMatchObject({
      userDataDir: '/tmp/dev',
      noTray: true,
      disableHelper: true,
    });
    // scripts/package.mjs runs every package with --smoke-test (and --smoke-optional-helper when the helper is missing).
    expect(parseLaunchOptions(['OrbitDrop', '--smoke-test', '--smoke-optional-helper'], {}, true)).toMatchObject({ smokeTest: true, smokeOptionalHelper: true, noTray: true, userDataDir: null });
  });
});
