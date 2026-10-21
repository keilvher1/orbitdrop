import { EventEmitter } from 'node:events';
import type { Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { hardenSession, hardenWebContents } from '../../src/main/security';

class FakeSession extends EventEmitter {
  requestHandler: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null = null;
  checkHandler: (() => boolean) | null = null;
  deviceHandler: (() => boolean) | null = null;
  setPermissionRequestHandler(handler: FakeSession['requestHandler']): void {
    this.requestHandler = handler;
  }
  setPermissionCheckHandler(handler: FakeSession['checkHandler']): void {
    this.checkHandler = handler;
  }
  setDevicePermissionHandler(handler: FakeSession['deviceHandler']): void {
    this.deviceHandler = handler;
  }
}

class FakeContents extends EventEmitter {
  openHandler: ((details: { url: string }) => { action: string }) | null = null;
  setWindowOpenHandler(handler: FakeContents['openHandler']): void {
    this.openHandler = handler;
  }
}

const event = () => ({ preventDefault: vi.fn() });
const TRUSTED = 'file:///app/out/renderer/index.html';
const isTrusted = (url: string) => url === TRUSTED;

describe('session hardening', () => {
  it('denies every permission request and check, and blocks downloads', () => {
    const session = new FakeSession();
    hardenSession(session as unknown as Session);
    for (const permission of ['media', 'notifications', 'clipboard-read', 'geolocation', 'openExternal']) {
      const callback = vi.fn();
      session.requestHandler!({}, permission, callback);
      expect(callback).toHaveBeenCalledWith(false);
    }
    expect(session.checkHandler!()).toBe(false);
    expect(session.deviceHandler!()).toBe(false);
    const download = event();
    session.emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalled();
  });
});

describe('webContents hardening', () => {
  it('denies window.open, untrusted navigation, redirects and webviews; allows our own page', () => {
    const contents = new FakeContents();
    hardenWebContents(contents as unknown as WebContents, isTrusted);
    expect(contents.openHandler!({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect(contents.openHandler!({ url: TRUSTED })).toEqual({ action: 'deny' });

    const external = event();
    contents.emit('will-navigate', external, 'https://example.com/');
    expect(external.preventDefault).toHaveBeenCalled();
    const own = event();
    contents.emit('will-navigate', own, TRUSTED);
    expect(own.preventDefault).not.toHaveBeenCalled();

    const frame = { ...event(), url: 'file:///etc/passwd' };
    contents.emit('will-frame-navigate', frame);
    expect(frame.preventDefault).toHaveBeenCalled();

    const redirect = event();
    contents.emit('will-redirect', redirect);
    expect(redirect.preventDefault).toHaveBeenCalled();
    const webview = event();
    contents.emit('will-attach-webview', webview);
    expect(webview.preventDefault).toHaveBeenCalled();
  });
});
