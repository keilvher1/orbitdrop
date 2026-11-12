import { spawnSync } from 'node:child_process';
import { chmod } from 'node:fs/promises';

/**
 * Make a folder refuse new entries (files, sub-folders, renames into it), and undo that.
 *
 * POSIX: mode 0555. Windows ignores the read-only attribute on folders (Node's chmod only
 * toggles that attribute), so there a deny entry for Everyone on "create files / append data"
 * (WD) and "create folders" (AD) is added to the folder's ACL with icacls — what a folder the
 * user may not write to looks like on NTFS. Reading the folder and its files keeps working.
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
