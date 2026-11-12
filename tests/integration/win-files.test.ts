/**
 * scripts/win-files.mjs: the checks package.mjs and the signing hook run on OrbitDrop's own Windows
 * executables — the version information every signed file must carry, the Authenticode status, and
 * "the file that came back from signing is the file that was built, plus a signature".
 * Synthetic PE files: nothing here needs Windows.
 */
import { describe, expect, it } from 'vitest';
import { peLayout, readWindowsFileFacts, signatureAddedOnly, signatureProblems, versionInfoProblems, type WindowsFileFacts } from '../../scripts/win-files.mjs';

/** A minimal PE32+ file: MZ stub, PE header, an optional header with 16 data directories, then `body`. */
function fakePe(body: string | Buffer = 'section data and an NSIS overlay', { magic = 0x20b } = {}): Buffer {
  const lfanew = 0x80;
  const optionalSize = magic === 0x20b ? 112 + 16 * 8 : 96 + 16 * 8;
  const header = Buffer.alloc(lfanew + 24 + optionalSize);
  header.writeUInt16LE(0x5a4d, 0);
  header.writeUInt32LE(lfanew, 0x3c);
  header.writeUInt32LE(0x00004550, lfanew);
  header.writeUInt16LE(0x8664, lfanew + 4); // machine
  header.writeUInt16LE(optionalSize, lfanew + 20);
  const optional = lfanew + 24;
  header.writeUInt16LE(magic, optional);
  header.writeUInt32LE(0x1234abcd, optional + 64); // checksum
  header.writeUInt32LE(16, optional + (magic === 0x20b ? 108 : 92)); // NumberOfRvaAndSizes
  return Buffer.concat([header, Buffer.isBuffer(body) ? body : Buffer.from(body)]);
}

/** What signtool does: pad to 8 bytes, append a WIN_CERTIFICATE, point the security directory at it, new checksum. */
function fakeSign(unsigned: Buffer, { magic = 0x20b, padWith = 0 } = {}): Buffer {
  const padding = (8 - (unsigned.length % 8)) % 8;
  const certificate = Buffer.from('WIN_CERTIFICATE + PKCS#7 SignedData');
  const signed = Buffer.concat([unsigned, Buffer.alloc(padding, padWith), certificate]);
  const optional = 0x80 + 24;
  const security = optional + (magic === 0x20b ? 112 : 96) + 4 * 8;
  signed.writeUInt32LE(unsigned.length + padding, security);
  signed.writeUInt32LE(certificate.length, security + 4);
  signed.writeUInt32LE(0x0badf00d, optional + 64);
  return signed;
}

describe('PE layout', () => {
  it('finds the checksum and the certificate table of PE32+ and PE32 files', () => {
    const plus = peLayout(fakePe());
    expect(plus).toEqual({ checksumOffset: 0x80 + 24 + 64, securityEntryOffset: 0x80 + 24 + 112 + 32, certificateTable: null });
    const pe32 = peLayout(fakePe('x', { magic: 0x10b }));
    expect(pe32.securityEntryOffset).toBe(0x80 + 24 + 96 + 32);
    const signed = peLayout(fakeSign(fakePe()));
    expect(signed.certificateTable).toEqual({ offset: expect.any(Number), size: 35 });
  });

  it('refuses what is not a PE file', () => {
    expect(() => peLayout(Buffer.from('#!/bin/sh\necho not a PE file, but long enough to have a header of 64 bytes'))).toThrow(/not a PE file/);
    const noPe = fakePe();
    noPe.writeUInt32LE(0, 0x80);
    expect(() => peLayout(noPe)).toThrow(/no PE signature/);
  });
});

describe('"the signed file is the built file plus a signature"', () => {
  it('accepts a signature that changed only the checksum, the security directory and the appended certificate', () => {
    const unsigned = fakePe('an odd number of bytes!');
    expect(signatureAddedOnly(unsigned, fakeSign(unsigned))).toEqual({ ok: true });
    const pe32 = fakePe('PE32 helper', { magic: 0x10b });
    expect(signatureAddedOnly(pe32, fakeSign(pe32, { magic: 0x10b }))).toEqual({ ok: true });
  });

  it('refuses a different file, a changed byte, a second signing, a missing or misplaced signature', () => {
    const unsigned = fakePe('the uninstaller NSIS generated');
    const signed = fakeSign(unsigned);
    expect(signatureAddedOnly(fakePe('another uninstaller from a changed script'), signed)).toMatchObject({ ok: false });
    const tampered = Buffer.from(signed);
    tampered.writeUInt8(tampered.readUInt8(unsigned.length - 5) ^ 1, unsigned.length - 5); // inside the original bytes (the NSIS data, say)
    expect(signatureAddedOnly(unsigned, tampered)).toEqual({ ok: false, reason: expect.stringMatching(/differs at byte/) });
    expect(signatureAddedOnly(signed, fakeSign(signed))).toEqual({ ok: false, reason: 'the file sent for signing was already signed' });
    expect(signatureAddedOnly(unsigned, unsigned)).toEqual({ ok: false, reason: 'the returned file carries no signature' });
    expect(signatureAddedOnly(unsigned, fakeSign(unsigned, { padWith: 7 }))).toEqual({ ok: false, reason: 'non-zero padding before the signature' });
    const trailing = Buffer.concat([signed, Buffer.from('more data after the certificate')]);
    expect(signatureAddedOnly(unsigned, trailing)).toEqual({ ok: false, reason: expect.stringMatching(/not appended/) });
    expect(signatureAddedOnly(Buffer.from('not a PE file at all, just text that is long enough for a header....'), signed)).toMatchObject({ ok: false });
  });
});

const facts = (overrides: Partial<WindowsFileFacts>[]): WindowsFileFacts[] =>
  overrides.map((o, i) => ({ path: `C:\\b\\file${i}.exe`, productName: 'OrbitDrop', productVersion: '1.0.1', signature: 'NotSigned', ...o }));

describe('version information and signatures of the four files', () => {
  it('every file must say ProductName OrbitDrop and the package version', () => {
    const expected = { productName: 'OrbitDrop', version: '1.0.1' };
    expect(versionInfoProblems(facts([{}, { path: 'C:\\b\\resources\\helper\\OrbitDropHelper.exe' }]), expected)).toEqual([]);
    expect(versionInfoProblems(facts([{ path: 'C:\\b\\OrbitDrop.exe', productVersion: '1.0.1.0' }, { productName: 'Electron' }, { productVersion: null }]), expected)).toEqual([
      'OrbitDrop.exe: ProductVersion is "1.0.1.0", expected "1.0.1" (apps/desktop/package.json)',
      'file1.exe: ProductName is "Electron", expected "OrbitDrop"',
      'file2.exe: ProductVersion is null, expected "1.0.1" (apps/desktop/package.json)',
    ]);
    // A prerelease keeps its suffix on every file.
    expect(versionInfoProblems(facts([{ productVersion: '1.1.0-beta.2' }]), { productName: 'OrbitDrop', version: '1.1.0-beta.2' })).toEqual([]);
  });

  it('a signed build must be Valid everywhere (optionally by the expected signer); an unsigned one signed nowhere', () => {
    const valid = facts([{ signature: 'Valid', signer: 'CN=SignPath Foundation, O=SignPath Foundation' }]);
    expect(signatureProblems(valid, { expected: 'signed', signer: /SignPath Foundation/ })).toEqual([]);
    expect(signatureProblems(valid, { expected: 'signed', signer: /Somebody Else/ })).toEqual([expect.stringMatching(/signed by CN=SignPath Foundation/)]);
    expect(signatureProblems(facts([{ signature: 'HashMismatch' }, { signature: 'NotSigned' }]), { expected: 'signed' })).toEqual([
      'file0.exe: signature status HashMismatch, expected Valid',
      'file1.exe: signature status NotSigned, expected Valid',
    ]);
    expect(signatureProblems(facts([{}, {}]), { expected: 'unsigned' })).toEqual([]);
    expect(signatureProblems(facts([{ signature: 'Valid' }]), { expected: 'unsigned' })).toEqual([expect.stringMatching(/expected NotSigned/)]);
  });

  it('reads all files in one PowerShell call, paths handed over in the environment (no quoting)', () => {
    const calls: { cmd: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
    const run = ((cmd: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ cmd, args, env: options.env });
      return { status: 0, stdout: JSON.stringify({ path: 'C:\\Program Files\\x\\Uninstall OrbitDrop.exe', productName: 'OrbitDrop', productVersion: '1.0.1', signature: 'Valid' }), stderr: '' };
    }) as never;
    const out = readWindowsFileFacts(['C:\\Program Files\\x\\Uninstall OrbitDrop.exe'], { run });
    expect(out).toEqual([expect.objectContaining({ signature: 'Valid' })]); // a single object becomes a list
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('powershell.exe');
    expect(JSON.parse(calls[0]!.env!.ORBITDROP_FILES!)).toEqual(['C:\\Program Files\\x\\Uninstall OrbitDrop.exe']);
    expect(readWindowsFileFacts([], { run })).toEqual([]);
    const failing = (() => ({ status: 1, stdout: '', stderr: 'Get-Item : Cannot find path' })) as never;
    expect(() => readWindowsFileFacts(['C:\\missing.exe'], { run: failing })).toThrow(/Cannot find path/);
  });
});
