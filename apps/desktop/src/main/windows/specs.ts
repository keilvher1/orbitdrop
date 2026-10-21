import type { WindowKind } from '@orbitdrop/contracts';

/**
 * Window kinds. All windows are small frameless panels (the renderer draws its
 * own header with a drag region and a close button — `closeWindow()`), shown
 * on ready-to-show near the pointer / drop point. Sizes are DIP.
 */
export interface WindowSpec {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly resizable: boolean;
  readonly alwaysOnTop: boolean;
  /** Take focus when shown (user-initiated windows). */
  readonly focus: boolean;
  /** At most one window of this kind. */
  readonly single: boolean;
  readonly skipTaskbar: boolean;
}

export const WINDOW_SPECS: Readonly<Record<WindowKind, WindowSpec>> = {
  picker: { width: 420, height: 460, minWidth: 320, minHeight: 320, resizable: false, alwaysOnTop: true, focus: true, single: true, skipTaskbar: true },
  // Sized by its content: the panel is laid out at a fixed 520 DIP and the height follows the renderer's
  // resizeWindow requests (short views must not leave blank space), so the user cannot resize it — a
  // wider or narrower window would only add blank space or clip the panel.
  editor: { width: 520, height: 640, minWidth: 440, minHeight: 200, resizable: false, alwaysOnTop: false, focus: true, single: false, skipTaskbar: false },
  jobs: { width: 460, height: 560, minWidth: 360, minHeight: 320, resizable: true, alwaysOnTop: false, focus: true, single: true, skipTaskbar: false },
  settings: { width: 520, height: 620, minWidth: 440, minHeight: 420, resizable: true, alwaysOnTop: false, focus: true, single: true, skipTaskbar: false },
  dropzone: { width: 220, height: 220, minWidth: 160, minHeight: 160, resizable: false, alwaysOnTop: true, focus: false, single: true, skipTaskbar: true },
  about: { width: 380, height: 340, minWidth: 320, minHeight: 280, resizable: false, alwaysOnTop: false, focus: true, single: true, skipTaskbar: false },
};

/** Editors open at most this many at once; the oldest is closed beyond it. */
export const MAX_EDITOR_WINDOWS = 8;
