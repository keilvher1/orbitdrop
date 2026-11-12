import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCapabilitySnapshot } from '@orbitdrop/core';
import { isAllowedExternalUrl, type EngineProbe, type FileFormat, type FormatSupport, type HelperStatus, type Locale } from '@orbitdrop/contracts';
import { bindTranslate } from '../../src/main/i18n';
import { isRendererExternalUrl } from '../../src/main/security';
import { SupportController, type SupportDeps } from '../../src/main/support/controller';
import { buildDiagnostics, capabilitySummary, helperSummary, readLogTail, readTailLines, redactLogLine, redactLogLines } from '../../src/main/support/diagnostics';
import { issueToken, issueUrl, websiteUrl } from '../../src/main/support/help';
import { licenseCandidates } from '../../src/main/support/legal';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-support-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ko = bindTranslate(() => 'ko');
const en = bindTranslate(() => 'en');

function queryOf(url: string): { title: string; body: string } {
  const parsed = new URL(url);
  return { title: parsed.searchParams.get('title') ?? '', body: parsed.searchParams.get('body') ?? '' };
}

describe('Help menu targets', () => {
  it('the website follows the UI language (Korean main site, English under /en/)', () => {
    expect(websiteUrl('ko')).toBe('https://keilvher1.github.io/orbitdrop/');
    expect(websiteUrl('en')).toBe('https://keilvher1.github.io/orbitdrop/en/');
    for (const locale of ['ko', 'en'] as const) expect(isRendererExternalUrl(websiteUrl(locale))).toBe(true);
  });

  it('a problem report opens a new GitHub issue prefilled with the version, OS and architecture only', () => {
    const url = issueUrl({ appVersion: '0.1.0', os: 'macOS 14.8.7', arch: 'x64 (Rosetta 2)' }, ko);
    expect(url.startsWith('https://github.com/keilvher1/orbitdrop/issues/new?title=')).toBe(true);
    expect(isRendererExternalUrl(url)).toBe(true);
    expect(isAllowedExternalUrl(url)).toBe(true);
    const { title, body } = queryOf(url);
    expect(title).toBe('문제: ');
    expect(body).toContain('- OrbitDrop 0.1.0');
    expect(body).toContain('- macOS 14.8.7');
    expect(body).toContain('- x64 (Rosetta 2)');
    expect(body).toContain('### 무슨 일이 있었나요?');
    // Nothing that looks like a path or a file name with a folder.
    expect(body).not.toMatch(/[\\/]Users|[A-Z]:\\|~\//);
    expect(queryOf(issueUrl({ appVersion: '0.1.0', os: 'Windows 10.0.26100', arch: 'x64' }, en)).body).toContain('### Environment');
  });

  it('values that are not short plain tokens never reach the issue form', () => {
    expect(issueToken('14.8.7')).toBe('14.8.7');
    expect(issueToken('x64 (Rosetta 2)')).toBe('x64 (Rosetta 2)');
    for (const bad of ['/Users/me/Desktop', 'C:\\Users\\me', 'a'.repeat(49), '', '  ', 'photo.jpg"', 'name: x']) expect(issueToken(bad), bad).toBe('?');
    const { body } = queryOf(issueUrl({ appVersion: '/Users/me/app', os: 'macOS ~/x', arch: 'arm64' }, ko));
    expect(body).not.toContain('/Users');
    expect(body).not.toContain('~/');
    expect(body).toContain('- OrbitDrop ?');
  });
});

describe('licence files', () => {
  const mac = { packaged: true, resourcesPath: '/Applications/OrbitDrop.app/Contents/Resources', appPath: '/Applications/OrbitDrop.app/Contents/Resources/app.asar' };
  const win = { packaged: true, resourcesPath: '/Programs/OrbitDrop/resources', appPath: '/Programs/OrbitDrop/resources/app.asar' };
  const dev = { packaged: false, resourcesPath: '/repo/node_modules/electron/dist/Electron.app/Contents/Resources', appPath: '/repo/apps/desktop' };

  it('packaged: the resources folder (macOS), then next to OrbitDrop.exe (Windows)', () => {
    expect(licenseCandidates('thirdParty', mac)).toEqual(['/Applications/OrbitDrop.app/Contents/Resources/THIRD_PARTY_LICENSES.md']);
    expect(licenseCandidates('electron', mac)[0]).toBe('/Applications/OrbitDrop.app/Contents/Resources/LICENSE.electron.txt');
    expect(licenseCandidates('chromium', mac)[0]).toBe('/Applications/OrbitDrop.app/Contents/Resources/LICENSES.chromium.html');
    expect(licenseCandidates('electron', win)).toContain('/Programs/OrbitDrop/LICENSE.electron.txt');
    expect(licenseCandidates('chromium', win)).toContain('/Programs/OrbitDrop/LICENSES.chromium.html');
    expect(licenseCandidates('thirdParty', win)).toEqual(['/Programs/OrbitDrop/resources/THIRD_PARTY_LICENSES.md']);
  });

  it("development: the repository's file and Electron's own", () => {
    expect(licenseCandidates('thirdParty', dev)).toEqual(['/repo/THIRD_PARTY_LICENSES.md']);
    expect(licenseCandidates('electron', dev)).toEqual(['/repo/node_modules/electron/dist/LICENSE']);
    expect(licenseCandidates('chromium', dev)).toEqual(['/repo/node_modules/electron/dist/LICENSES.chromium.html']);
  });
});

describe('diagnostics log tail', () => {
  it('reads the last lines, continuing into the rotated log when the current one is short', async () => {
    const log = join(dir, 'main.log');
    await writeFile(`${log}.1`, Array.from({ length: 300 }, (_, i) => `old ${i}`).join('\n') + '\n');
    await writeFile(log, 'new 0\nnew 1\n');
    const tail = await readLogTail(log, 5);
    expect(tail).toEqual(['old 297', 'old 298', 'old 299', 'new 0', 'new 1']);
    expect(await readLogTail(join(dir, 'missing.log'), 5)).toEqual([]);
  });

  it('reads only the end of a large file and drops the line the read window cut', async () => {
    const log = join(dir, 'big.log');
    await writeFile(log, Array.from({ length: 2000 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(40)}`).join('\n'));
    const lines = await readTailLines(log, 200, 4096);
    expect(lines.length).toBeLessThan(200);
    expect(lines.at(-1)).toMatch(/^line 1999 /);
    for (const line of lines) expect(line).toMatch(/^line \d{4} x{40}$/); // no partial first line
  });

  it('redacts again: paths, the home folder and control characters', () => {
    const home = '/Users/someone';
    const line = '2026-11-12T00:00:00.000Z WARN  [jobs] failed error="ENOENT: open \'/Users/someone/Desktop/private photo.png\'" at C:\\Users\\someone\\x.txt\u0007';
    const out = redactLogLine(line, home);
    expect(out).not.toContain('someone');
    expect(out).not.toContain('private');
    expect(out).not.toContain('\u0007');
    expect(out).toContain('<path>');
    expect(redactLogLine(`home is ${home} ok`, home)).toBe('home is ~ ok'); // the user name never appears
    expect(redactLogLine('x'.repeat(5000), null).length).toBeLessThanOrEqual(1001);
  });

  it('keeps the newest lines within the size cap', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `${i} ${'y'.repeat(98)}`);
    const out = redactLogLines(lines, null, 1000);
    expect(out.length).toBeLessThan(50);
    expect(out.at(-1)).toMatch(/^49 /);
    expect(out.join('\n').length).toBeLessThanOrEqual(1000);
  });
});

const SUPPORT = (input: boolean, output: boolean): FormatSupport => ({ input, output, inputEngine: input ? 'sharp' : 'none', outputEngine: output ? 'sharp' : 'none' });
const PROBE: EngineProbe = {
  platform: 'darwin',
  arch: 'arm64',
  versions: { sharp: '0.35.5', vips: '8.18.7' },
  formats: {
    jpeg: SUPPORT(true, true),
    png: SUPPORT(true, true),
    webp: SUPPORT(true, true),
    gif: SUPPORT(true, false),
    tiff: SUPPORT(true, true),
    avif: SUPPORT(true, true),
    heic: SUPPORT(false, false),
    bmp: SUPPORT(true, true),
    pdf: { input: true, output: true, inputEngine: 'pdfjs', outputEngine: 'pdf-lib' },
    docx: { input: false, output: true, inputEngine: 'none', outputEngine: 'docx' },
    txt: { input: false, output: true, inputEngine: 'none', outputEngine: 'text' },
  } satisfies Record<FileFormat, FormatSupport>,
  pdfRender: true,
  pdfText: true,
  koreanFont: 'Apple SD Gothic Neo',
  errors: ['note about <path>'],
  probedAt: 0,
};

describe('diagnostics text', () => {
  it('summarizes the helper and the engines without developer paths', () => {
    expect(helperSummary({ state: 'running', helperVersion: '1.2.0', globalDrag: true })).toBe('running 1.2.0 · globalDrag=yes');
    expect(helperSummary({ state: 'crashed', restarts: 5, reason: 'exited from /Users/me/helper' })).toBe('crashed after 5 restarts · exited from <path>');
    expect(helperSummary({ state: 'needsPermission', permissions: ['accessibility'] })).toBe('needsPermission (accessibility)');
    const engines = capabilitySummary(buildCapabilitySnapshot(PROBE), en);
    expect(engines).toContain('decode jpeg png webp gif tiff avif bmp pdf');
    expect(engines).toContain('encode jpeg png webp tiff avif bmp pdf docx txt');
    expect(engines).toContain('pdfRender=yes');
    expect(engines).toMatch(/actions \d+\/\d+/);
    expect(engines).toContain('sharp 0.35.5');
    expect(engines).toContain('probeNotes 1');
    expect(capabilitySummary(null, ko)).toBe('아직 확인하는 중');
  });

  it('lists version, build, OS, architecture, helper, engines and the log lines', () => {
    const text = buildDiagnostics({
      appVersion: '0.1.0',
      packaged: true,
      versions: { electron: '44.9.0', chrome: '152.0.0.0', node: '24.7.0' },
      os: 'macOS 14.8.7',
      arch: 'x64',
      translated: true,
      locale: 'ko',
      helper: { state: 'running', helperVersion: '1.0.0', globalDrag: false, reason: 'no event tap' },
      capabilities: buildCapabilitySnapshot(PROBE),
      logLines: ['a line', 'another'],
      t: ko,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('OrbitDrop 진단 정보');
    expect(text).toContain('버전: 0.1.0');
    expect(text).toContain('빌드: 설치본 · Electron 44.9.0 · Chromium 152.0.0.0 · Node 24.7.0');
    expect(text).toContain('운영체제: macOS 14.8.7');
    expect(text).toContain('아키텍처: x64 (Rosetta 2)');
    expect(text).toContain('드래그 도우미: running 1.0.0 · globalDrag=no · no event tap');
    expect(text).toContain('최근 로그 2줄(경로는 가림):\na line\nanother\n');
  });
});

interface FakeShell {
  readonly openExternal: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  readonly openPath: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>;
  readonly showItemInFolder: ReturnType<typeof vi.fn<(path: string) => void>>;
}

function controller({ uiLocale, helper, ...overrides }: Partial<SupportDeps> & { uiLocale?: Locale; helper?: HelperStatus } = {}) {
  const shell: FakeShell = {
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
  };
  const clipboard: string[] = [];
  const ensured: string[] = [];
  const locale = uiLocale ?? 'ko';
  const deps: SupportDeps = {
    platform: 'darwin',
    arch: 'arm64',
    translated: false,
    appVersion: '0.1.0',
    packaged: true,
    versions: { electron: '44.9.0', chrome: '152.0.0.0', node: '24.7.0' },
    osVersion: () => '14.8.7',
    homeDir: '/Users/someone',
    paths: { userData: join(dir, 'data'), logFile: join(dir, 'data', 'logs', 'main.log'), resourcesPath: join(dir, 'Resources'), appPath: join(dir, 'Resources', 'app.asar') },
    locale: () => locale,
    t: bindTranslate(() => locale),
    helperStatus: () => helper ?? { state: 'running', helperVersion: '1.0.0', globalDrag: true },
    capabilities: () => null,
    shell,
    writeClipboard: (text) => clipboard.push(text),
    exists: () => false,
    ensureDir: (path) => ensured.push(path),
    ...overrides,
  };
  return { support: new SupportController(deps), shell, clipboard, ensured };
}

describe('SupportController', () => {
  it('opens the website in the UI language and the issue form, both through the allowlist', async () => {
    const { support, shell } = controller({ uiLocale: 'en' });
    await support.openWebsite();
    await support.reportProblem();
    expect(shell.openExternal.mock.calls[0]![0]).toBe('https://keilvher1.github.io/orbitdrop/en/');
    const issue = shell.openExternal.mock.calls[1]![0];
    expect(issue.startsWith('https://github.com/keilvher1/orbitdrop/issues/new?')).toBe(true);
    expect(queryOf(issue).body).toContain('- macOS 14.8.7');
    expect(queryOf(issue).body).toContain('- arm64');
    expect(support.osDescription()).toBe('macOS 14.8.7');
  });

  it('opens the log and data folders (creating the log folder first); a folder that cannot open is an error', async () => {
    const { support, shell, ensured } = controller();
    await support.openLogFolder();
    await support.openDataFolder();
    expect(shell.openPath.mock.calls.map((call) => call[0])).toEqual([join(dir, 'data', 'logs'), join(dir, 'data')]);
    expect(ensured).toContain(join(dir, 'data', 'logs'));
    shell.openPath.mockResolvedValueOnce('Failed to open path');
    await expect(support.openLogFolder()).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('copies diagnostics with the redacted log tail to the clipboard; the caller learns only the line count', async () => {
    await mkdir(join(dir, 'data', 'logs'), { recursive: true });
    await writeFile(join(dir, 'data', 'logs', 'main.log'), 'ok line\nerror="/Users/someone/Documents/tax return.pdf"\n');
    const { support, clipboard } = controller();
    expect(await support.copyDiagnostics()).toEqual({ logLines: 2 });
    expect(clipboard).toHaveLength(1);
    expect(clipboard[0]).toContain('OrbitDrop 진단 정보');
    expect(clipboard[0]).toContain('ok line');
    expect(clipboard[0]).not.toContain('someone');
    expect(clipboard[0]).not.toContain('tax return');
  });

  it('opens a shipped licence file with the default app, shows it in its folder when no app opens it, refuses a missing one', async () => {
    const present = new Set([join(dir, 'Resources', 'LICENSES.chromium.html')]);
    const { support, shell } = controller({ exists: (path) => present.has(path) });
    await support.openLicense('chromium');
    expect(shell.openPath).toHaveBeenCalledWith(join(dir, 'Resources', 'LICENSES.chromium.html'));
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    shell.openPath.mockResolvedValueOnce('No application knows how to open it');
    await support.openLicense('chromium');
    expect(shell.showItemInFolder).toHaveBeenCalledWith(join(dir, 'Resources', 'LICENSES.chromium.html'));
    await expect(support.openLicense('thirdParty')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });
});
