import { defineConfig } from '@playwright/test';

/**
 * Electron E2E tests (apps/desktop/e2e). They launch the built app
 * (`electron-vite build` first — `pnpm --filter @orbitdrop/desktop test:e2e`
 * does both) with ORBITDROP_E2E=1: temp app-data folder, no tray, no native
 * helper, windows never take focus, and test hooks in main to open windows for
 * generated fixture files (no OS dialogs, no synthesized OS input).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../test-results/desktop-e2e',
});
