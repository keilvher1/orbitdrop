/**
 * electron-updater (6.8.12) implements staged rollouts with a random installation id: it keeps a
 * UUID in <userData>/.updaterId and sends it to the update server as `x-user-staging-id` with
 * every request. OrbitDrop uses no staged rollouts and sends no installation identifier: the id
 * is never created (a constant nil id is used, which only matters for `stagingPercentage`, a
 * field OrbitDrop's release metadata does not use) and the header is dropped.
 *
 * Both members are internals of AppUpdater; electron-updater is pinned to an exact version and
 * apps/desktop/test/main/update-privacy.test.ts runs the real library to catch a change.
 */

export const NIL_INSTALLATION_ID = '00000000-0000-0000-0000-000000000000';
export const STAGING_ID_HEADER = 'x-user-staging-id';

/** The two AppUpdater internals this touches. */
export interface StagingInternals {
  computeFinalHeaders(headers: Record<string, string>): Record<string, string>;
  getOrCreateStagingUserId(): Promise<string>;
}

export function withoutInstallationId<T extends object>(updater: T): T {
  const internals = updater as unknown as StagingInternals;
  if (typeof internals.computeFinalHeaders !== 'function' || typeof internals.getOrCreateStagingUserId !== 'function') {
    throw new Error('electron-updater internals changed: cannot drop the installation id (see update/privacy.ts)');
  }
  const finalHeaders = internals.computeFinalHeaders.bind(updater);
  internals.computeFinalHeaders = (headers) => {
    const rest: Record<string, string> = { ...headers };
    delete rest[STAGING_ID_HEADER];
    const result = finalHeaders(rest);
    delete result[STAGING_ID_HEADER];
    return result;
  };
  internals.getOrCreateStagingUserId = () => Promise.resolve(NIL_INSTALLATION_ID);
  return updater;
}
