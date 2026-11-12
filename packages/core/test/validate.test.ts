import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESSING_LIMITS } from '@orbitdrop/contracts';
import { defaultCloudRoots, isNetworkPath, validateInputFile } from '../src/node';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const posix = process.platform !== 'win32';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const PDF = Buffer.from('%PDF-1.7\n%\u00e2\u00e3\n1 0 obj\n<<>>\nendobj\n', 'latin1');

let dir: string;
let realDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbitdrop-validate-'));
  realDir = await realpath(dir); // macOS: /var → /private/var
});
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => undefined);
  for (const sub of ['locked', 'secret']) await chmod(join(dir, sub), 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const opts = { cloudRoots: [] as string[] };

describe('regular files', () => {
  it('detects the format from the header and reports name, folder and size', async () => {
    await writeFile(join(dir, 'Page 001.pdf'), PDF);
    const v = await validateInputFile(join(dir, 'Page 001.pdf'), opts);
    expect(v).toEqual({
      originalPath: join(dir, 'Page 001.pdf'),
      realPath: join(realDir, 'Page 001.pdf'),
      displayName: 'Page 001.pdf',
      sourceDir: dir,
      format: 'pdf',
      kind: 'pdf',
      bytes: PDF.length,
      extensionMismatch: false,
    });
  });

  it('flags an extension that names another format, but not a missing one', async () => {
    const cases: [string, Buffer, boolean][] = [
      ['fake.jpg', PNG, true],
      ['photo.dat', PNG, true],
      ['no_extension', PNG, false],
      ['photo.JPEG', JPEG, false],
      ['photo.jfif', JPEG, false],
      ['scan.PDF', PDF, false],
    ];
    for (const [name, data, mismatch] of cases) {
      await writeFile(join(dir, name), data);
      const v = await validateInputFile(join(dir, name), opts);
      expect([name, v.extensionMismatch]).toEqual([name, mismatch]);
    }
  });

  it('accepts a PDF with junk before the header', async () => {
    await writeFile(join(dir, 'mail.pdf'), Buffer.concat([Buffer.alloc(700, 0x0a), PDF]));
    expect((await validateInputFile(join(dir, 'mail.pdf'), opts)).format).toBe('pdf');
  });

  it('handles Korean (NFC and NFD), emoji, spaces and combining characters in names', async () => {
    const names = ['사진 001.png', '\u1109\u1161\u110c\u1175\u11ab.png', '🍊 orange.png', '  a  b  .png', 'Cafe\u0301.png'];
    for (const name of names) {
      await writeFile(join(dir, name), PNG);
      const v = await validateInputFile(join(dir, name), opts);
      expect(v.displayName).toBe(name);
      expect(v.format).toBe('png');
    }
  });

  it('rejects unknown content, output-only formats, aliases and shortcuts', async () => {
    await writeFile(join(dir, 'notes.txt'), 'hello');
    await writeFile(join(dir, 'report.docx'), Buffer.from('PK\u0003\u0004word/document.xml', 'latin1'));
    await writeFile(join(dir, 'Photo alias'), Buffer.concat([Buffer.from('book\0\0\0\0mark\0\0\0\0', 'latin1'), Buffer.alloc(32)]));
    await writeFile(join(dir, 'photo.lnk'), Buffer.from([0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46, 0, 0, 0, 0]));
    await expect(validateInputFile(join(dir, 'notes.txt'), opts)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    await expect(validateInputFile(join(dir, 'report.docx'), opts)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    await expect(validateInputFile(join(dir, 'Photo alias'), opts)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT', detail: 'macAlias' });
    await expect(validateInputFile(join(dir, 'photo.lnk'), opts)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT', detail: 'windowsShortcut' });
  });

  it('reports empty files by what the extension claims', async () => {
    for (const name of ['empty.pdf', 'empty.jpg', 'empty.txt', 'empty']) await writeFile(join(dir, name), '');
    await expect(validateInputFile(join(dir, 'empty.pdf'), opts)).rejects.toMatchObject({ code: 'FILE_EMPTY' });
    await expect(validateInputFile(join(dir, 'empty.jpg'), opts)).rejects.toMatchObject({ code: 'FILE_EMPTY' });
    await expect(validateInputFile(join(dir, 'empty.txt'), opts)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    await expect(validateInputFile(join(dir, 'empty'), opts)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });

  it('enforces the size limit (inclusive)', async () => {
    const limits = { ...DEFAULT_PROCESSING_LIMITS, maxInputBytes: PNG.length };
    await writeFile(join(dir, 'ok.png'), PNG);
    await writeFile(join(dir, 'big.png'), Buffer.concat([PNG, Buffer.from([0])]));
    expect((await validateInputFile(join(dir, 'ok.png'), { ...opts, limits })).bytes).toBe(PNG.length);
    await expect(validateInputFile(join(dir, 'big.png'), { ...opts, limits })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('does not mistake a sparse file (0 blocks) for a cloud placeholder when it reads fine', async () => {
    await writeFile(join(dir, 'sparse.png'), '');
    await truncate(join(dir, 'sparse.png'), 8 * 1024 * 1024);
    await expect(validateInputFile(join(dir, 'sparse.png'), opts)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });
});

describe('paths', () => {
  it('requires absolute, existing paths', async () => {
    await expect(validateInputFile('relative/photo.png', opts)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(validateInputFile(join(dir, 'missing.png'), opts)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await writeFile(join(dir, 'file.png'), PNG);
    await expect(validateInputFile(join(dir, 'file.png', 'child.png'), opts)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('rejects folders and special files', async () => {
    await mkdir(join(dir, 'folder.png'));
    await expect(validateInputFile(join(dir, 'folder.png'), opts)).rejects.toMatchObject({ code: 'NOT_A_FILE' });
    if (posix) {
      const fifo = join(dir, 'pipe.png');
      const made = spawnSync('mkfifo', [fifo]);
      if (made.status === 0) await expect(validateInputFile(fifo, opts)).rejects.toMatchObject({ code: 'NOT_A_FILE' });
    }
  });

  it('accepts long paths with long Unicode components and reports overlong ones', async () => {
    let deep = dir;
    for (let i = 0; i < 4; i += 1) {
      deep = join(deep, `${'폴더'.repeat(30)}-${i}`); // 182-byte components
      await mkdir(deep);
    }
    const file = join(deep, `${'🍊'.repeat(40)}.png`);
    await writeFile(file, PNG);
    expect(Buffer.byteLength(file)).toBeGreaterThan(800);
    expect((await validateInputFile(file, opts)).format).toBe('png');
    await expect(validateInputFile(join(dir, `${'a'.repeat(300)}.png`), opts)).rejects.toMatchObject({ code: 'PATH_TOO_LONG' });
    // Over the whole-path limit: macOS PATH_MAX is 1024 bytes; Windows (Node opens `\\?\` paths)
    // allows 32,767 UTF-16 units, so ~6,000 characters are a legal (here: missing) path there.
    const parts = process.platform === 'win32' ? 170 : 30;
    const overlong = join(dir, ...Array.from({ length: parts }, () => 'b'.repeat(200)), 'x.png');
    await expect(validateInputFile(overlong, opts)).rejects.toMatchObject({ code: 'PATH_TOO_LONG' });
  });

  it.runIf(process.platform === 'win32')('Windows: names of up to 255 UTF-16 units (765 UTF-8 bytes of Hangul) and paths over MAX_PATH work', async () => {
    const name = `${'가'.repeat(251)}.png`; // 255 units: the NTFS limit (macOS allows 255 bytes)
    const sub = join(dir, '사진'.repeat(60)); // the file's path is far over 260 characters
    await mkdir(sub);
    await writeFile(join(sub, name), PNG);
    expect(join(sub, name).length).toBeGreaterThan(260);
    const v = await validateInputFile(join(sub, name), opts);
    expect([v.displayName, v.format, v.sourceDir]).toEqual([name, 'png', sub]);
    await expect(validateInputFile(join(sub, `${'가'.repeat(252)}.png`), opts)).rejects.toMatchObject({ code: 'PATH_TOO_LONG' });
    const slashes = join(sub, name).replace(/\\/g, '/'); // forward slashes are Windows separators too
    expect((await validateInputFile(slashes, opts)).format).toBe('png');
  });
});

describe('Windows path limits', () => {
  it('flags a name over 255 or a path over 32,767 UTF-16 units, wherever the separators are', async () => {
    const { exceedsWin32PathLimits } = await import('../src/node');
    expect(exceedsWin32PathLimits(`C:\\Users\\me\\${'가'.repeat(255)}`)).toBe(false);
    expect(exceedsWin32PathLimits(`C:\\Users\\me\\${'가'.repeat(256)}`)).toBe(true);
    expect(exceedsWin32PathLimits(`C:/Users/${'🍊'.repeat(128)}/a.png`)).toBe(true); // 256 units: emoji are surrogate pairs
    expect(exceedsWin32PathLimits(`\\\\nas\\share\\${'a\\'.repeat(16_000)}x.png`)).toBe(false); // 32,017 units
    expect(exceedsWin32PathLimits(`C:\\${'abcdefgh\\'.repeat(3700)}x.png`)).toBe(true); // 33,308 units
  });

  it('applies them when validating for Windows', async () => {
    const tooLong = join(dir, `${'가'.repeat(256)}.png`);
    await expect(validateInputFile(tooLong, { ...opts, platform: 'win32' })).rejects.toMatchObject({ code: 'PATH_TOO_LONG' });
  });
});

describe.runIf(posix)('symbolic links', () => {
  beforeEach(async () => {
    await mkdir(join(dir, 'target'));
    await mkdir(join(dir, 'links'));
    await writeFile(join(dir, 'target', 'real.png'), PNG);
  });

  it('reads the target but puts outputs next to the link', async () => {
    await symlink(join(dir, 'target', 'real.png'), join(dir, 'links', 'link.jpg'));
    const v = await validateInputFile(join(dir, 'links', 'link.jpg'), opts);
    expect(v.realPath).toBe(join(realDir, 'target', 'real.png'));
    expect(v.sourceDir).toBe(join(dir, 'links'));
    expect(v.displayName).toBe('link.jpg');
    expect(v.format).toBe('png');
    expect(v.extensionMismatch).toBe(true);
  });

  it('follows relative links, chains and linked folders', async () => {
    await symlink('../target/real.png', join(dir, 'links', 'rel.png'));
    await symlink(join(dir, 'links', 'rel.png'), join(dir, 'links', 'chain.png'));
    await symlink(join(dir, 'target'), join(dir, 'linkdir'));
    expect((await validateInputFile(join(dir, 'links', 'chain.png'), opts)).realPath).toBe(join(realDir, 'target', 'real.png'));
    const viaDir = await validateInputFile(join(dir, 'linkdir', 'real.png'), opts);
    expect(viaDir.sourceDir).toBe(join(dir, 'linkdir'));
    expect(viaDir.realPath).toBe(join(realDir, 'target', 'real.png'));
  });

  it('reports loops, dangling links and links to folders', async () => {
    await symlink(join(dir, 'links', 'b.png'), join(dir, 'links', 'a.png'));
    await symlink(join(dir, 'links', 'a.png'), join(dir, 'links', 'b.png'));
    await symlink(join(dir, 'links', 'self.png'), join(dir, 'links', 'self.png'));
    await symlink(join(dir, 'nowhere.png'), join(dir, 'links', 'dangling.png'));
    await symlink(join(dir, 'target'), join(dir, 'links', 'folder.png'));
    await expect(validateInputFile(join(dir, 'links', 'a.png'), opts)).rejects.toMatchObject({ code: 'SYMLINK_LOOP' });
    await expect(validateInputFile(join(dir, 'links', 'self.png'), opts)).rejects.toMatchObject({ code: 'SYMLINK_LOOP' });
    await expect(validateInputFile(join(dir, 'links', 'dangling.png'), opts)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    await expect(validateInputFile(join(dir, 'links', 'folder.png'), opts)).rejects.toMatchObject({ code: 'NOT_A_FILE' });
  });
});

describe.runIf(posix && !isRoot)('permissions', () => {
  it('reports an unreadable file and an unreadable folder as READ_PERMISSION_DENIED', async () => {
    await writeFile(join(dir, 'locked.png'), PNG);
    await chmod(join(dir, 'locked.png'), 0o000);
    await expect(validateInputFile(join(dir, 'locked.png'), opts)).rejects.toMatchObject({ code: 'READ_PERMISSION_DENIED' });
    await chmod(join(dir, 'locked.png'), 0o644);
    await mkdir(join(dir, 'secret'));
    await writeFile(join(dir, 'secret', 'in.png'), PNG);
    await chmod(join(dir, 'secret'), 0o000);
    await expect(validateInputFile(join(dir, 'secret', 'in.png'), opts)).rejects.toMatchObject({ code: 'READ_PERMISSION_DENIED' });
  });
});

describe('cloud and network heuristics', () => {
  it('knows where cloud-synced folders live on each platform', () => {
    expect(defaultCloudRoots('darwin', '/Users/me', {})).toEqual(['/Users/me/Library/Mobile Documents', '/Users/me/Library/CloudStorage']);
    expect(defaultCloudRoots('win32', 'C:\\Users\\me', { OneDrive: 'C:\\Users\\me\\OneDrive', OneDriveCommercial: 'C:\\Users\\me\\OneDrive - Org' })).toEqual([
      'C:\\Users\\me\\OneDrive',
      'C:\\Users\\me\\OneDrive - Org',
      'C:\\Users\\me\\iCloudDrive',
    ]);
    expect(defaultCloudRoots('linux', '/home/me', {})).toEqual([]);
  });

  it('recognizes network paths', () => {
    expect(isNetworkPath('\\\\nas\\share\\a.png', 'win32')).toBe(true);
    expect(isNetworkPath('C:\\a.png', 'win32')).toBe(false);
    expect(isNetworkPath('/Volumes/NAS/a.png', 'darwin')).toBe(true);
    expect(isNetworkPath('/Users/me/a.png', 'darwin')).toBe(false);
  });
});

const require = createRequire(import.meta.url);
let sharp: ((input?: unknown) => any) | null = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

describe.runIf(sharp !== null)('real image files', () => {
  it('validates files written by the bundled encoder', async () => {
    const png = await sharp!({ create: { width: 4, height: 3, channels: 3, background: '#ff8800' } }).png().toBuffer();
    for (const format of ['jpeg', 'png', 'webp', 'tiff', 'gif', 'avif'] as const) {
      const data: Buffer = await sharp!(png)[format]().toBuffer();
      const name = `real.${format === 'jpeg' ? 'jpg' : format}`;
      await writeFile(join(dir, name), data);
      const v = await validateInputFile(join(dir, name), opts);
      expect([v.format, v.kind, v.bytes, v.extensionMismatch]).toEqual([format, 'image', data.length, false]);
    }
  });
});
