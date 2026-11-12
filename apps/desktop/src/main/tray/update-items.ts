import type { MenuItemConstructorOptions } from 'electron';
import type { Translate } from '../i18n';
import type { TrayUpdate } from '../update/service';

/** The tray menu's update actions (TrayActions has them as optional members). */
export interface TrayUpdateActions {
  /** Opens About (which shows the result) and checks now. */
  checkForUpdates?(): void;
  restartToUpdate?(): void;
  cancelRestartToUpdate?(): void;
}

/**
 * Update entries of the tray / menu-bar menu:
 *   업데이트 확인…                                   (no update downloaded)
 *   재시작하여 업데이트                               (downloaded: installs now — or once work is done)
 *   작업이 끝나면 다시 시작합니다 · 다시 시작 취소       (a restart waits for running work)
 */
export function updateMenuItems(update: TrayUpdate | undefined, actions: TrayUpdateActions, t: Translate): MenuItemConstructorOptions[] {
  if (!update) return [];
  if (!update.ready) return actions.checkForUpdates ? [{ label: t('update.tray.check'), click: () => actions.checkForUpdates?.() }] : [];
  if (update.restartPending) {
    return [
      { label: t('update.tray.pending'), enabled: false },
      { label: t('update.tray.cancelRestart'), click: () => actions.cancelRestartToUpdate?.() },
    ];
  }
  return [{ label: t('update.tray.restart'), click: () => actions.restartToUpdate?.() }];
}
