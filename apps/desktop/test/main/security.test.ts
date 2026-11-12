import { EventEmitter } from 'node:events';
import type { Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { hardenSession, hardenWebContents, isRendererExternalUrl } from '../../src/main/security';

/** The panes Settings › Drag links to (renderer SettingsView PERMISSION_URLS). */
const PERMISSION_URLS = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
};

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

describe('openExternal from a renderer', () => {
  it('accepts what the UI opens: the macOS privacy panes, Windows privacy pages, the website and a new issue', () => {
    for (const url of Object.values(PERMISSION_URLS)) expect(isRendererExternalUrl(url), url).toBe(true);
    expect(isRendererExternalUrl('ms-settings:privacy')).toBe(true);
    expect(isRendererExternalUrl('ms-settings:privacy-webcam')).toBe(true);
    expect(isRendererExternalUrl('https://keilvher1.github.io/orbitdrop/')).toBe(true);
    expect(isRendererExternalUrl('https://keilvher1.github.io/orbitdrop/en/')).toBe(true);
    expect(isRendererExternalUrl('https://github.com/keilvher1/orbitdrop/issues/new')).toBe(true);
    expect(isRendererExternalUrl('https://github.com/keilvher1/orbitdrop/issues/new?title=%EB%AC%B8%EC%A0%9C&body=x')).toBe(true);
  });

  it('web pages: exactly the allowlisted origins and paths', () => {
    for (const url of [
      'https://github.com/orbitdrop/orbitdrop/issues',
      'https://github.com/keilvher1/orbitdrop',
      'https://github.com/keilvher1/orbitdrop/issues',
      'https://github.com/keilvher1/orbitdrop/issues/new/../../pulls',
      'https://github.com/keilvher1/orbitdrop/issues/new#x',
      'https://github.com/keilvher1/orbitdrop/issues/new#',
      'https://github.com:8443/keilvher1/orbitdrop/issues/new',
      'https://user@github.com/keilvher1/orbitdrop/issues/new',
      'https://keilvher1.github.io/orbitdrop/?q=1',
      'https://keilvher1.github.io/orbitdrop',
      'https://keilvher1.github.io/other/',
      'https://evil.github.io/orbitdrop/',
      'http://keilvher1.github.io/orbitdrop/',
    ]) {
      expect(isRendererExternalUrl(url), url).toBe(false);
    }
  });

  it('refuses everything else, including URLs the bare prefix list would let through', () => {
    for (const url of [
      'https://example.com/',
      'http://github.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility&x=1',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility\n',
      'ms-settings:windowsupdate-action',
      'ms-settings:privacy-webcam?x',
      'https://github.com/\tsomething',
      '',
    ]) {
      expect(isRendererExternalUrl(url), JSON.stringify(url)).toBe(false);
    }
  });
});
