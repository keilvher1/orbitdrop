import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * App-level lifecycle wiring used by index.ts, kept free of runtime Electron
 * imports so it can be unit-tested with fake emitters:
 *  - quit: every quit request waits for the cleanup the first one started; a
 *    force timer still guarantees the exit;
 *  - a second launch: files on its command line (Windows: dropped on
 *    OrbitDrop.exe or a shortcut, "Open with") open the picker — they are
 *    plain candidates here and FileRegistry validates every one of them like
 *    any other input; without files the Drop Zone is shown;
 *  - macOS: re-opening the running app from Finder, Spotlight or Launchpad
 *    starts no second process — the app gets 'activate' (reopen) and shows the
 *    Drop Zone the same way; files the OS hands over ('open-file': `open -a
 *    OrbitDrop <file>`, Open With › Other…, a forced drop on the app icon — no
 *    document types are declared, so Finder offers nothing more) open the picker;
 *  - sleep, screen lock and a user switch drop the drag session (the helper
 *    hides its wheel); resume and unlock check the helper again;
 *  - an app data folder that cannot be written (Chromium then cannot create
 *    the single-instance lock either) is reported instead of quitting silently.
 */

export interface EmitterLike {
  /** Listeners have event-specific parameters (Electron's App / powerMonitor emitters). */
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface QuitAppLike extends EmitterLike {
  exit(code?: number): void;
}

export interface LifecycleTarget {
  showDropZone(): void | Promise<void>;
  /** Candidate file paths from the OS; the target validates them (FileRegistry) before anything else. */
  openPaths(paths: readonly string[]): void | Promise<void>;
}

export interface PowerTarget {
  systemSuspended(reason: string): void;
  systemResumed(reason: string): void;
}

/** Every quit request waits for the first one's cleanup; `forceMs` bounds it. */
export function installQuitHandler(app: QuitAppLike, shutdown: () => Promise<void>, forceMs = 10_000): void {
  let quitting = false;
  app.on('before-quit', (event: { preventDefault(): void }) => {
    // A second ⌘Q / tray Quit must not cut the first one's cleanup short.
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    const force = setTimeout(() => app.exit(0), forceMs);
    void shutdown()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(force);
        app.exit(0);
      });
  });
}

export const MAX_COMMAND_LINE_FILES = 500;

/**
 * File paths named on a command line (a launch's argv): everything after the
 * executable — and, in development runs (`electron <app folder or entry
 * script>`, `process.defaultApp`), after the entry too: `skip` 2 — that is not
 * a switch (`--flag`, Chromium's own switches, macOS' `-psn_…`), resolved
 * against that launch's working folder, without the app's own folder,
 * duplicates dropped. They are only candidates: FileRegistry validates each.
 */
export function filePathsFromArgv(
  argv: readonly unknown[],
  cwd: string,
  options: { readonly appPath: string; readonly platform: NodeJS.Platform; readonly max?: number; readonly skip?: number },
): string[] {
  const normalize = (path: string): string => (options.platform === 'win32' ? path.toLowerCase() : path);
  const own = normalize(resolve(options.appPath));
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const arg of argv.slice(options.skip ?? 1)) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.startsWith('-')) continue;
    const path = resolve(cwd, arg);
    const key = normalize(path);
    if (key === own || seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
    if (paths.length >= (options.max ?? MAX_COMMAND_LINE_FILES)) break;
  }
  return paths;
}

/** A second launch and (macOS) re-opening the running app. */
export function installInstanceHandlers(
  app: EmitterLike,
  target: LifecycleTarget,
  options: { readonly platform: NodeJS.Platform; readonly appPath: string; readonly cwd: () => string; readonly skip?: number },
): void {
  app.on('second-instance', (_event: unknown, argv: unknown, workingDirectory: unknown) => {
    const cwd = typeof workingDirectory === 'string' && workingDirectory.length > 0 ? workingDirectory : options.cwd();
    const paths = Array.isArray(argv) ? filePathsFromArgv(argv, cwd, options) : [];
    if (paths.length > 0) void target.openPaths(paths);
    else void target.showDropZone();
  });
  // macOS reopens the running app (Finder, Spotlight, Launchpad) instead of starting a second process.
  if (options.platform === 'darwin') app.on('activate', () => void target.showDropZone());
}

/**
 * macOS 'open-file' comes once per file (several in a row for one hand-over)
 * and may come before the app is ready: paths are collected and delivered
 * together once a receiver is attached and no further path came for
 * `settleMs`.
 */
export class OpenFileQueue {
  private paths: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deliver: ((paths: string[]) => void) | null = null;

  constructor(
    private readonly settleMs = 150,
    private readonly max = MAX_COMMAND_LINE_FILES,
  ) {}

  push(path: unknown): void {
    if (typeof path !== 'string' || path.length === 0) return;
    if (this.paths.length < this.max && !this.paths.includes(path)) this.paths.push(path);
    this.schedule();
  }

  /** Start delivering (once the app can show windows); paths collected so far follow shortly. */
  attach(deliver: (paths: string[]) => void): void {
    this.deliver = deliver;
    if (this.paths.length > 0) this.schedule();
  }

  get pending(): number {
    return this.paths.length;
  }

  private schedule(): void {
    if (!this.deliver) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const batch = this.paths;
      this.paths = [];
      if (batch.length > 0) this.deliver?.(batch);
    }, this.settleMs);
    this.timer.unref?.();
  }
}

/** Must be installed before `ready` (macOS sends the files of a launch-by-file before it). */
export function installOpenFileHandler(app: EmitterLike, queue: OpenFileQueue): void {
  app.on('open-file', (event: { preventDefault(): void }, path: unknown) => {
    event.preventDefault();
    queue.push(path);
  });
}

const SUSPEND_EVENTS = ['suspend', 'lock-screen', 'user-did-resign-active'] as const;
const RESUME_EVENTS = ['resume', 'unlock-screen', 'user-did-become-active'] as const;
/** powerMonitor events that exist only on macOS (fast user switching). */
const MAC_ONLY = new Set<string>(['user-did-resign-active', 'user-did-become-active']);

/** Sleep, screen lock and user switches (Electron powerMonitor; only usable after `ready`). */
export function installPowerHandlers(power: EmitterLike, target: PowerTarget, platform: NodeJS.Platform): void {
  for (const name of SUSPEND_EVENTS) {
    if (!MAC_ONLY.has(name) || platform === 'darwin') power.on(name, () => target.systemSuspended(name));
  }
  for (const name of RESUME_EVENTS) {
    if (!MAC_ONLY.has(name) || platform === 'darwin') power.on(name, () => target.systemResumed(name));
  }
}

/**
 * Whether the app data folder can be created and written. Probed with a real
 * file: access(W_OK) does not see Windows ACLs.
 */
export function dataDirWritable(dir: string): boolean {
  const probe = join(dir, `.orbitdrop-write-test-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    mkdirSync(dir, { recursive: true });
    closeSync(openSync(probe, 'wx', 0o600));
  } catch {
    return false;
  }
  try {
    unlinkSync(probe);
  } catch {
    // written but not removable: still writable
  }
  return true;
}
