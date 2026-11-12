// Windows executables OrbitDrop builds itself (OrbitDrop.exe, OrbitDropHelper.exe, the NSIS installer
// and its uninstaller): what scripts/package.mjs, the electron-builder signing hook (scripts/win-sign.cjs)
// and the SignPath steps of .github/workflows/release.yml check about them. Plain Node ESM; the PE
// parsing runs anywhere (tests), only `readWindowsFileFacts` needs Windows (PowerShell).
//
//  - version information: every one of them must carry ProductName "OrbitDrop" and ProductVersion
//    = apps/desktop/package.json's version (SignPath Foundation: product name = project name, the same
//    product version in each build; the artifact configurations in apps/desktop/build/signpath/
//    enforce it again before signing);
//  - signatures: Authenticode status and signer, as Windows reports them;
//  - "the signed file is the file we sent, plus a signature": an Authenticode signature only changes
//    the PE checksum, the certificate-table entry and the appended certificate; every other byte
//    must be the same. That is how a file coming back from SignPath is matched to the file that was
//    built (and how the regenerated NSIS uninstaller is matched to the one that was signed).
import { spawnSync } from 'node:child_process';

const IMAGE_DIRECTORY_ENTRY_SECURITY = 4;

/**
 * Offsets in a PE file that Authenticode signing changes: { checksumOffset, securityEntryOffset,
 * certificateTable: { offset, size } | null }. Throws when the buffer is not a PE file.
 */
export function peLayout(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (no MZ header)');
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) throw new Error('not a PE file (no PE signature)');
  const optional = pe + 24;
  const magic = buf.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`unknown optional header magic 0x${magic.toString(16)}`);
  const checksumOffset = optional + 64;
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const count = buf.readUInt32LE(directories - 4);
  if (count <= IMAGE_DIRECTORY_ENTRY_SECURITY) return { checksumOffset, securityEntryOffset: null, certificateTable: null };
  const securityEntryOffset = directories + IMAGE_DIRECTORY_ENTRY_SECURITY * 8;
  if (securityEntryOffset + 8 > buf.length) throw new Error('truncated PE header');
  const offset = buf.readUInt32LE(securityEntryOffset);
  const size = buf.readUInt32LE(securityEntryOffset + 4);
  return { checksumOffset, securityEntryOffset, certificateTable: offset === 0 && size === 0 ? null : { offset, size } };
}

/**
 * Whether `signed` is `unsigned` with an Authenticode signature added and nothing else changed.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function signatureAddedOnly(unsigned, signed) {
  let before;
  let after;
  try {
    before = peLayout(unsigned);
    after = peLayout(signed);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (before.certificateTable) return { ok: false, reason: 'the file sent for signing was already signed' };
  if (!after.certificateTable) return { ok: false, reason: 'the returned file carries no signature' };
  if (after.securityEntryOffset !== before.securityEntryOffset || after.checksumOffset !== before.checksumOffset) return { ok: false, reason: 'the PE headers differ' };
  const { offset, size } = after.certificateTable;
  // The certificate table follows the original bytes (padded to 8 bytes) and ends the file.
  if (offset < unsigned.length || offset - unsigned.length > 7 || offset + size !== signed.length) {
    return { ok: false, reason: `the signature is not appended to the original ${unsigned.length} bytes (certificate table at ${offset}, ${size} bytes, file ${signed.length} bytes)` };
  }
  for (let i = unsigned.length; i < offset; i++) if (signed[i] !== 0) return { ok: false, reason: 'non-zero padding before the signature' };
  const skip = (i) => (i >= after.checksumOffset && i < after.checksumOffset + 4) || (i >= after.securityEntryOffset && i < after.securityEntryOffset + 8);
  for (let i = 0; i < unsigned.length; i++) {
    if (unsigned[i] !== signed[i] && !skip(i)) return { ok: false, reason: `the content differs at byte ${i}` };
  }
  return { ok: true };
}

/**
 * Version information and Authenticode status of each file (Windows only: PowerShell's
 * Get-Item VersionInfo and Get-AuthenticodeSignature). Returns one entry per path:
 * { path, productName, productVersion, fileVersion, companyName, signature, signer, timestamped }.
 */
export function readWindowsFileFacts(paths, { run = spawnSync } = {}) {
  if (paths.length === 0) return [];
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$paths = $env:ORBITDROP_FILES | ConvertFrom-Json',
    '$facts = foreach ($p in $paths) {',
    '  $vi = (Get-Item -LiteralPath $p).VersionInfo',
    '  $sig = Get-AuthenticodeSignature -LiteralPath $p',
    '  [pscustomobject]@{',
    '    path = $p; productName = $vi.ProductName; productVersion = $vi.ProductVersion; fileVersion = $vi.FileVersion; companyName = $vi.CompanyName',
    '    signature = [string]$sig.Status',
    '    signer = $(if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null })',
    '    timestamped = [bool]$sig.TimeStamperCertificate',
    '  }',
    '}',
    'ConvertTo-Json -InputObject @($facts) -Compress -Depth 3',
  ].join('\n');
  // -EncodedCommand (UTF-16LE, base64): no command-line quoting of the script; the paths travel in the environment.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    env: { ...process.env, ORBITDROP_FILES: JSON.stringify(paths) },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error(`reading version information failed: ${r.error?.message ?? `${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ')}`);
  const parsed = JSON.parse(`${r.stdout}`.replace(/^\uFEFF/, '').trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Problems (empty = fine): every file must say ProductName `productName` and ProductVersion `version`. */
export function versionInfoProblems(facts, { productName, version }) {
  const problems = [];
  for (const f of facts) {
    const name = String(f.path).split(/[\\/]/).pop();
    if (f.productName !== productName) problems.push(`${name}: ProductName is ${JSON.stringify(f.productName ?? null)}, expected "${productName}"`);
    if (f.productVersion !== version) problems.push(`${name}: ProductVersion is ${JSON.stringify(f.productVersion ?? null)}, expected "${version}" (apps/desktop/package.json)`);
  }
  return problems;
}

/**
 * Problems (empty = fine) with the signatures: `expected` 'signed' — Windows reports every file as
 * Valid (optionally by a signer matching `signer`); 'unsigned' — none of them carries a signature.
 */
export function signatureProblems(facts, { expected, signer = null }) {
  const problems = [];
  for (const f of facts) {
    const name = String(f.path).split(/[\\/]/).pop();
    if (expected === 'signed') {
      if (f.signature !== 'Valid') problems.push(`${name}: signature status ${f.signature}, expected Valid`);
      else if (signer && !signer.test(String(f.signer ?? ''))) problems.push(`${name}: signed by ${f.signer}, expected ${signer}`);
    } else if (f.signature !== 'NotSigned') problems.push(`${name}: signature status ${f.signature}, expected NotSigned (unsigned build)`);
  }
  return problems;
}
