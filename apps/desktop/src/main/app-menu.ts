import type { MenuItemConstructorOptions } from 'electron';

/**
 * Application menu template (pure, so it can be tested). macOS: OrbitDrop is
 * an accessory app (no menu bar is shown) but key equivalents only work
 * through a menu — the app menu (⌘Q, ⌘H), File › Close Window (⌘W; it closes
 * the key window, and an editor with unsaved work asks first — see
 * WindowManager), Edit (⌘C/⌘V/⌘Z… in text fields) and Window (⌘M). Other
 * platforms: no menu (frameless panels; Alt+F4 closes a window, with the same
 * question for unsaved work).
 */
export function appMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null;
  return [{ role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
}
