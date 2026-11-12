import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Make a folder refuse new entries (files, sub-folders, renames into it), and undo that.
 *
 * POSIX: mode 0555. Windows ignores the read-only attribute on folders (Node's chmod only
 * toggles that attribute), so there a deny entry for Everyone on "create files / append data"
 * (WD) and "create folders" (AD) is added to the folder's ACL with icacls — what a folder the
 * user may not write to looks like on NTFS. Check `denyAclsApply()` first on Windows.
 */
export async function denyWrites(dir: string): Promise<void> {
  if (process.platform === 'win32') icacls(dir, '/deny', '*S-1-1-0:(WD,AD)');
  else await chmod(dir, 0o555);
}

export async function allowWrites(dir: string): Promise<void> {
  if (process.platform === 'win32') icacls(dir, '/remove:d', '*S-1-1-0');
  else await chmod(dir, 0o755);
}

function icacls(...args: string[]): void {
  const result = spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`icacls ${args.join(' ')} failed (${result.status}): ${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`);
}

let aclsApply: boolean | undefined;

/**
 * Windows: whether a deny ACL stops this process from creating a file. It does not on the
 * GitHub-hosted runner (measured there: PowerShell is refused, Node is not): Node opens files
 * with backup semantics (libuv's FILE_FLAG_BACKUP_SEMANTICS) and the job's elevated token has
 * the backup/restore privileges enabled, which bypass the ACL. A normal user's session — and an
 * elevated one with those privileges disabled, the default — honours it. Always true on POSIX.
 */
export function denyAclsApply(): boolean {
  if (process.platform !== 'win32') return true;
  if (aclsApply !== undefined) return aclsApply;
  const dir = mkdtempSync(join(tmpdir(), 'orbitdrop-acl-probe-'));
  try {
    icacls(dir, '/deny', '*S-1-1-0:(WD,AD)');
    try {
      closeSync(openSync(join(dir, 'probe'), 'wx'));
      aclsApply = false;
    } catch {
      aclsApply = true;
    } finally {
      icacls(dir, '/remove:d', '*S-1-1-0');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return aclsApply;
}

/**
 * Windows: keep `file` open in another process with FileShare.Read only (no delete sharing) —
 * what a sync client, a virus scanner or an editor holding the file does. It can still be read,
 * but not renamed, replaced or deleted (EBUSY / EPERM), whatever the caller's privileges.
 * Resolves once the file is held; call the returned function to let it go.
 */
export async function holdOpenWithoutDeleteSharing(file: string): Promise<() => Promise<void>> {
  const script = `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); 'held'; [Console]::In.ReadLine() | Out-Null; $f.Dispose()`;
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`powershell exited (${code}) before holding ${file}: ${stderr}`)));
  });
  return async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end('\n');
    await exited;
  };
}
