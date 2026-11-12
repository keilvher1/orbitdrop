/**
 * scripts/win-sign.cjs, electron-builder's Windows signing hook (win.signtoolOptions.sign), called with
 * the arguments electron-builder passes. Real PE files with version resources are made with resedit (the
 * library electron-builder edits OrbitDrop.exe with); no signtool, no Windows needed.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const hook = require('../../scripts/win-sign.cjs') as {
  sign(configuration: object, packager: object): Promise<unknown>;
};
const resedit = createRequire(require.resolve('app-builder-lib/package.json'))('resedit') as typeof import('resedit');

/** An executable with a version resource, like electron-builder leaves OrbitDrop.exe: ProductVersion "1.0.1.0". */
function exeWithVersion(file: string, productVersion: string): void {
  const exe = resedit.NtExecutable.createEmpty(false, false);
  const res = resedit.NtExecutableResource.from(exe);
  const vi = resedit.Resource.VersionInfo.createEmpty();
  vi.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: 'OrbitDrop', FileVersion: '1.0.1', ProductVersion: productVersion });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  writeFileSync(file, Buffer.from(exe.generate()));
}

function productVersionOf(file: string): string | undefined {
  const exe = resedit.NtExecutable.from(readFileSync(file));
  const [vi] = resedit.Resource.VersionInfo.fromEntries(resedit.NtExecutableResource.from(exe).entries);
  return vi?.getStringValues({ lang: 1033, codepage: 1200 }).ProductVersion;
}

/** What signtool does to a PE file (see win-files.test.ts): padding, certificate table, new checksum. */
function fakeSign(unsigned: Buffer): Buffer {
  const padding = (8 - (unsigned.length % 8)) % 8;
  const certificate = Buffer.from('WIN_CERTIFICATE');
  const signed = Buffer.concat([unsigned, Buffer.alloc(padding), certificate]);
  const pe = signed.readUInt32LE(0x3c);
  const optional = pe + 24;
  const security = optional + (signed.readUInt16LE(optional) === 0x20b ? 112 : 96) + 4 * 8;
  signed.writeUInt32LE(unsigned.length + padding, security);
  signed.writeUInt32LE(certificate.length, security + 4);
  return signed;
}

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbitdrop-win-sign-'));
  for (const key of ['ORBITDROP_SIGNED_UNINSTALLER', 'ORBITDROP_UNINSTALLER_COPY', 'ORBITDROP_SIGN_LOG']) delete process.env[key];
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

const packager = (doSign: (c: object) => void = () => undefined) => ({
  appInfo: { productFilename: 'OrbitDrop', version: '1.0.1' },
  signingManager: { value: Promise.resolve({ doSign: async (configuration: object) => doSign(configuration) }) },
});

describe('electron-builder Windows signing hook', () => {
  it('OrbitDrop.exe gets the release version as its ProductVersion string; other files are left alone', async () => {
    mkdirSync(join(dir, 'win-unpacked', 'resources', 'helper'), { recursive: true });
    const main = join(dir, 'win-unpacked', 'OrbitDrop.exe');
    const helper = join(dir, 'win-unpacked', 'resources', 'helper', 'OrbitDropHelper.exe');
    exeWithVersion(main, '1.0.1.0');
    exeWithVersion(helper, '9.9.9');
    process.env.ORBITDROP_SIGN_LOG = join(dir, 'sign.jsonl');
    await hook.sign({ path: main, isNest: false, cscInfo: null }, packager());
    await hook.sign({ path: main, isNest: true, cscInfo: null }, packager()); // the second hash: nothing again
    await hook.sign({ path: helper, isNest: false, cscInfo: null }, packager());
    expect(productVersionOf(main)).toBe('1.0.1');
    expect(productVersionOf(helper)).toBe('9.9.9');
    const logged = readFileSync(join(dir, 'sign.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { name: string; certificate: boolean });
    expect(logged.map((l) => l.name)).toEqual(['OrbitDrop.exe', 'OrbitDropHelper.exe']);
    expect(logged.every((l) => !l.certificate)).toBe(true);
  });

  it('without a certificate nothing is signed; with one, electron-builder\'s own signtool call runs for every hash', async () => {
    const setup = join(dir, 'OrbitDrop-1.0.1-win-x64-setup.exe');
    exeWithVersion(setup, '1.0.1');
    const before = readFileSync(setup);
    const calls: object[] = [];
    await hook.sign({ path: setup, isNest: false, cscInfo: null }, packager((c) => calls.push(c)));
    expect(calls).toEqual([]);
    expect(readFileSync(setup).equals(before)).toBe(true);
    const withCert = { path: setup, isNest: false, cscInfo: { file: 'cert.pfx' } };
    await hook.sign(withCert, packager((c) => calls.push(c)));
    await hook.sign({ ...withCert, isNest: true }, packager((c) => calls.push(c)));
    expect(calls).toHaveLength(2);
  });

  it('the uninstaller: copied for the checks; in the SignPath installer stage replaced by its signed copy', async () => {
    const generated = join(dir, 'OrbitDrop-1.0.1-win-x64-setup.__uninstaller.exe');
    exeWithVersion(generated, '1.0.1');
    process.env.ORBITDROP_UNINSTALLER_COPY = join(dir, 'uninstaller', 'Uninstall OrbitDrop.exe');
    await hook.sign({ path: generated, isNest: false, cscInfo: null }, packager());
    expect(readFileSync(process.env.ORBITDROP_UNINSTALLER_COPY).equals(readFileSync(generated))).toBe(true);

    // SignPath signed the copy sent with request 1; NSIS regenerates the same uninstaller in the installer stage.
    const signed = join(dir, 'signed-1', 'Uninstall OrbitDrop.exe');
    mkdirSync(join(dir, 'signed-1'));
    writeFileSync(signed, fakeSign(readFileSync(generated)));
    process.env.ORBITDROP_SIGNED_UNINSTALLER = signed;
    await hook.sign({ path: generated, isNest: false, cscInfo: null }, packager());
    expect(readFileSync(generated).equals(readFileSync(signed))).toBe(true); // what goes into the installer
    expect(readFileSync(process.env.ORBITDROP_UNINSTALLER_COPY).equals(readFileSync(signed))).toBe(true);
  });

  it('refuses to put a signed uninstaller into the installer when it is not the one NSIS generated', async () => {
    const generated = join(dir, 'OrbitDrop-1.0.1-win-x64-setup.__uninstaller.exe');
    exeWithVersion(generated, '1.0.1');
    const other = join(dir, 'other.exe');
    exeWithVersion(other, '1.0.2'); // e.g. from another commit's script
    const signed = join(dir, 'signed.exe');
    writeFileSync(signed, fakeSign(readFileSync(other)));
    process.env.ORBITDROP_SIGNED_UNINSTALLER = signed;
    const before = readFileSync(generated);
    await expect(hook.sign({ path: generated, isNest: false, cscInfo: null }, packager())).rejects.toThrow(/is not the uninstaller NSIS generated now plus a signature/);
    expect(readFileSync(generated).equals(before)).toBe(true);
  });
});
