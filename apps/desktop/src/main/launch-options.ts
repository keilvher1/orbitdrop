/**
 * Command-line / environment switches.
 *   --smoke-test                      packaged-build self test (docs/architecture.md)
 *   ORBITDROP_SMOKE_OPTIONAL_HELPER=1 smoke test passes without the native helper (dev checkouts)
 *   ORBITDROP_E2E=1                   automation: no tray, no helper, windows never steal focus, test hooks
 *   ORBITDROP_E2E_TRAY=1              automation run that still creates the tray (to test its menu)
 *   ORBITDROP_E2E_HELPER=1            automation run that still starts the helper (a stub via ORBITDROP_HELPER_PATH)
 *   ORBITDROP_DISABLE_HELPER=1        do not start the native helper
 *   ORBITDROP_NO_TRAY=1               no tray icon
 *   ORBITDROP_USER_DATA_DIR=<dir>     app data folder (tests use a temp folder)
 *   ORBITDROP_DEBUG=1                 debug logging
 * The ORBITDROP_E2E* switches (test hooks, focus-less windows) only work in
 * unpackaged builds; ORBITDROP_HELPER_PATH likewise (app.ts).
 */
export interface LaunchOptions {
  readonly smokeTest: boolean;
  readonly smokeOptionalHelper: boolean;
  readonly e2e: boolean;
  readonly disableHelper: boolean;
  readonly noTray: boolean;
  readonly userDataDir: string | null;
  readonly debug: boolean;
}

export function parseLaunchOptions(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, packaged = false): LaunchOptions {
  const e2e = env.ORBITDROP_E2E === '1' && !packaged;
  const smokeTest = argv.includes('--smoke-test');
  return {
    smokeTest,
    smokeOptionalHelper: env.ORBITDROP_SMOKE_OPTIONAL_HELPER === '1' || argv.includes('--smoke-optional-helper'),
    e2e,
    disableHelper: env.ORBITDROP_DISABLE_HELPER === '1' || (e2e && env.ORBITDROP_E2E_HELPER !== '1'),
    noTray: env.ORBITDROP_NO_TRAY === '1' || (e2e && env.ORBITDROP_E2E_TRAY !== '1') || smokeTest,
    userDataDir: env.ORBITDROP_USER_DATA_DIR && env.ORBITDROP_USER_DATA_DIR.length > 0 ? env.ORBITDROP_USER_DATA_DIR : null,
    debug: env.ORBITDROP_DEBUG === '1',
  };
}
