import { describeError, silentLogger, type Logger } from './log';

/**
 * Launch at login (settings.launchAtLogin, off by default). The OS holds the
 * real state and the user can change it there as well (System Settings ›
 * General › Login Items, Task Manager › Startup apps). So at startup
 * OrbitDrop adopts the OS state instead of overwriting it — re-adding a login
 * item the user removed in System Settings would be wrong — and a change made
 * in OrbitDrop's settings is applied to the OS. Only packaged builds manage
 * it (registering the development Electron binary would be wrong); app.ts
 * decides that and passes the Electron calls in.
 */
export interface LoginItems {
  openAtLogin(): boolean;
  setOpenAtLogin(enabled: boolean): void;
}

/** Apply a settings change to the OS (no-op when it already matches). */
export function applyLoginItem(items: LoginItems, enabled: boolean, log: Logger = silentLogger): void {
  try {
    if (items.openAtLogin() !== enabled) items.setOpenAtLogin(enabled);
    const actual = items.openAtLogin();
    if (actual !== enabled) log.warn('the system did not take the login item change', { requested: enabled, actual });
  } catch (error) {
    log.warn('could not update the login item', { error: describeError(error) });
  }
}

/**
 * Startup: the value settings should hold so they match the OS, or null when
 * they already do (or the OS state cannot be read — then nothing changes).
 */
export function loginItemToAdopt(items: LoginItems, stored: boolean, log: Logger = silentLogger): boolean | null {
  let actual: boolean;
  try {
    actual = items.openAtLogin();
  } catch (error) {
    log.warn('could not read the login item', { error: describeError(error) });
    return null;
  }
  return actual === stored ? null : actual;
}
