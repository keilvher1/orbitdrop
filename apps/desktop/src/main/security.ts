import type { App, Session, WebContents } from 'electron';
import { silentLogger, type Logger } from './log';

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
