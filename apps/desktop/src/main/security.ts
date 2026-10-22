import type { App, Session, WebContents } from 'electron';
import { isAllowedExternalUrl } from '@orbitdrop/contracts';
import { silentLogger, type Logger } from './log';

/** System Settings panes the renderer links to (Settings › Drag: permission guidance). */
const MAC_PRIVACY_PANES = new Set(['Privacy_Accessibility', 'Privacy_ListenEvent']);

/**
 * What openExternal accepts from a renderer: the contracts prefix list
 * (ALLOWED_EXTERNAL_URL_PREFIXES) narrowed to what the UI really opens — the
 * two macOS privacy panes, Windows' privacy settings pages (no action URIs
 * such as ms-settings:windowsupdate-action) and https pages on github.com.
 */
export function isRendererExternalUrl(url: string): boolean {
  if (!isAllowedExternalUrl(url) || /[\s\u0000-\u001f\u007f]/.test(url)) return false;
  const mac = /^x-apple\.systempreferences:com\.apple\.preference\.security\?([A-Za-z_]+)$/.exec(url);
  if (mac) return MAC_PRIVACY_PANES.has(mac[1]!);
  if (url.startsWith('ms-settings:')) return /^ms-settings:privacy(?:-[a-z]+)?$/.test(url);
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.port === '' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

/**
 * Process-wide hardening (spec §9):
 *  - every permission request/check is denied (camera, notifications from the
 *    page, clipboard-read, …), downloads are blocked;
 *  - in every webContents: window.open is denied, navigation is allowed only
 *    to our own renderer URL, redirects and <webview> are blocked.
 */
export function hardenSession(session: Session, log: Logger = silentLogger): void {
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    log.debug('permission request denied', { permission });
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.on('will-download', (event) => {
    log.warn('download blocked');
    event.preventDefault();
  });
}

export function hardenWebContents(contents: WebContents, isTrustedUrl: (url: string) => boolean, log: Logger = silentLogger): void {
  contents.setWindowOpenHandler(() => {
    log.warn('window.open blocked');
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) {
      log.warn('navigation blocked');
      event.preventDefault();
    }
  });
  contents.on('will-frame-navigate', (event) => {
    if (!isTrustedUrl(event.url)) {
      log.warn('frame navigation blocked');
      event.preventDefault();
    }
  });
  contents.on('will-redirect', (event) => {
    log.warn('redirect blocked');
    event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => {
    log.warn('webview blocked');
    event.preventDefault();
  });
}

export function installWebContentsHardening(app: App, isTrustedUrl: (url: string) => boolean, log: Logger = silentLogger): void {
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, isTrustedUrl, log));
}
