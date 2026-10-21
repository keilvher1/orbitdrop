import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Menu, Tray, nativeImage, type NativeImage } from 'electron';
import type { Translate } from '../i18n';
import { describeError, silentLogger, type Logger } from '../log';
import { encodePng } from '../util/png';
import { drawTrayGlyph } from './glyph';
import { buildTrayTemplate, type TrayActions, type TrayState } from './menu';

/**
 * Tray / menu-bar icon and menu. Icons come from resources/tray
 * (trayTemplate.png + @2x on macOS, tray.ico on Windows); when they are
 * missing (dev) a generated glyph is used instead.
 */
export function loadTrayImage(dirs: readonly string[], platform: NodeJS.Platform, log: Logger = silentLogger): NativeImage {
  const names = platform === 'darwin' ? ['trayTemplate.png'] : platform === 'win32' ? ['tray.ico', 'tray.png'] : ['tray.png'];
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      const image = nativeImage.createFromPath(path);
      if (image.isEmpty()) continue;
      if (platform === 'darwin') image.setTemplateImage(true);
      return image;
    }
  }
  log.info('tray icon not found; using a generated icon');
  const color: [number, number, number] = platform === 'darwin' ? [0, 0, 0] : [242, 85, 44];
  const image = nativeImage.createFromBuffer(encodePng(16, 16, drawTrayGlyph(16, color)), { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: encodePng(32, 32, drawTrayGlyph(32, color)) });
  if (platform === 'darwin') image.setTemplateImage(true);
  return image;
}

export interface TrayControllerDeps {
  readonly iconDirs: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly state: () => TrayState;
  readonly actions: TrayActions;
  readonly t: Translate;
  readonly log?: Logger;
}

export class TrayController {
  private tray: Tray | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log: Logger;
  /** Labels of the menu last installed (automation/diagnostics). */
  lastLabels: readonly string[] = [];

  constructor(private readonly deps: TrayControllerDeps) {
    this.log = deps.log ?? silentLogger;
  }

  create(): void {
    if (this.tray) return;
    try {
      this.tray = new Tray(loadTrayImage(this.deps.iconDirs, this.deps.platform, this.log));
    } catch (error) {
      this.log.error('could not create the tray icon', { error: describeError(error) });
      return;
    }
    if (this.deps.platform === 'win32') {
      this.tray.on('click', () => this.tray?.popUpContextMenu());
    }
    this.refreshNow();
  }

  /** Rebuild the menu soon (coalesces bursts of job/status updates). */
  refresh(): void {
    if (!this.tray || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshNow();
    }, 150);
    this.refreshTimer.unref?.();
  }

  refreshNow(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    try {
      const template = buildTrayTemplate(this.deps.state(), this.deps.actions, this.deps.t);
      this.tray.setToolTip(this.deps.t('tray.tooltip'));
      this.tray.setContextMenu(Menu.buildFromTemplate(template));
      this.lastLabels = template.filter((item) => item.type !== 'separator').map((item) => String(item.label));
    } catch (error) {
      this.log.error('tray menu update failed', { error: describeError(error) });
    }
  }

  destroy(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}
