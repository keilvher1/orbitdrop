import type { WindowNotice } from '@orbitdrop/contracts';

/**
 * A window whose page crashed (render-process-gone). Frameless windows have
 * no OS close button, so a dead page must not stay on screen, and the user
 * must learn what happened instead of a silent reload or close:
 *   1st crash → reload; the view comes back with a notice ('recovered');
 *   2nd crash → reload into a crash screen only ('failed': close button, log folder);
 *   3rd crash → close the window and tell the user with a notification.
 * `unsavedLost`: the window had reported unsaved work (setCloseGuard) when it crashed.
 */
export interface WindowCrashState {
  count: number;
  unsavedLost: boolean;
}

export type CrashStep = 'reload' | 'reloadFailed' | 'close';

export function crashStep(count: number): CrashStep {
  if (count <= 1) return 'reload';
  return count === 2 ? 'reloadFailed' : 'close';
}

/** What getWindowNotice tells the reloaded page (null: it never crashed). */
export function windowNoticeFor(state: Readonly<WindowCrashState>): WindowNotice | null {
  if (state.count <= 0) return null;
  return { kind: state.count === 1 ? 'recovered' : 'failed', unsavedLost: state.unsavedLost };
}
