import type { MenuItemConstructorOptions } from 'electron';
import type { HelperStatus } from '@orbitdrop/contracts';
import type { MainStringKey, Translate } from '../i18n';

/**
 * Tray / menu-bar menu (pure template; the controller turns it into a Menu):
 *   파일 열기… · Drop Zone 열기/닫기 · 최근 작업 ▸ · 작업 창 ·
 *   전역 드래그 상태 (+ 권한/다시 시작 항목) · 전역 드래그 사용 ☑ · 설정… · 정보 · 종료
 */

export interface RecentItem {
  readonly jobId: string;
  readonly outputId: string;
  readonly name: string;
  readonly moreCount: number;
}

export interface TrayState {
  readonly helper: HelperStatus;
  readonly globalDragEnabled: boolean;
  readonly dropZoneOpen: boolean;
  readonly recent: readonly RecentItem[];
  readonly platform: NodeJS.Platform;
}

export interface TrayActions {
  openFile(): void;
  toggleDropZone(): void;
  revealOutput(outputId: string): void;
  openJobs(): void;
  setGlobalDrag(enabled: boolean): void;
  openPermissions(): void;
  restartHelper(): void;
  openSettings(): void;
  openAbout(): void;
  quit(): void;
}

export function helperStatusKey(status: HelperStatus): MainStringKey {
  switch (status.state) {
    case 'disabled':
      return 'tray.status.disabled';
    case 'starting':
      return 'tray.status.starting';
    case 'running':
      return status.globalDrag ? 'tray.status.running' : 'tray.status.limited';
    case 'needsPermission':
      return 'tray.status.needsPermission';
    case 'unavailable':
      return 'tray.status.unavailable';
    case 'crashed':
      return 'tray.status.crashed';
  }
}

const shorten = (text: string, max = 48): string => (text.length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`);

/** Windows menus treat '&' as a mnemonic marker. */
function label(text: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? text.replace(/&/g, '&&') : text;
}

export function buildTrayTemplate(state: TrayState, actions: TrayActions, t: Translate): MenuItemConstructorOptions[] {
  const { helper, platform } = state;
  const recent: MenuItemConstructorOptions[] =
    state.recent.length > 0
      ? state.recent.map((item) => ({
          label: label(item.moreCount > 0 ? t('tray.recentMore', { name: shorten(item.name, 40), n: item.moreCount }) : shorten(item.name), platform),
          click: () => actions.revealOutput(item.outputId),
        }))
      : [{ label: t('tray.recentEmpty'), enabled: false }];

  const status: MenuItemConstructorOptions[] = [{ label: t(helperStatusKey(helper)), enabled: false }];
  const limited = helper.state === 'unavailable' || helper.state === 'crashed' || (helper.state === 'running' && !helper.globalDrag);
  if (limited || helper.state === 'needsPermission') status.push({ label: t('tray.hint.fallback'), enabled: false });
  if (helper.state === 'needsPermission') status.push({ label: t('tray.openPermissions'), click: () => actions.openPermissions() });
  if (helper.state === 'crashed') status.push({ label: t('tray.restartHelper'), click: () => actions.restartHelper() });

  return [
    { label: t('tray.openFile'), click: () => actions.openFile() },
    { label: t(state.dropZoneOpen ? 'tray.dropZoneClose' : 'tray.dropZoneOpen'), click: () => actions.toggleDropZone() },
    { label: t('tray.recent'), submenu: recent },
    { label: t('tray.jobs'), click: () => actions.openJobs() },
    { type: 'separator' },
    ...status,
    {
      label: t('tray.globalDragToggle'),
      type: 'checkbox',
      checked: state.globalDragEnabled,
      enabled: helper.state !== 'unavailable',
      click: (item) => actions.setGlobalDrag(item.checked),
    },
    { type: 'separator' },
    { label: t('tray.settings'), click: () => actions.openSettings() },
    { label: t('tray.about'), click: () => actions.openAbout() },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => actions.quit() },
  ];
}
