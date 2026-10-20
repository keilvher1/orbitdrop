import { defineConfig } from 'vitest/config';

// Each project has its own vitest.config.ts. UI tests that need a real
// window (Playwright + Electron) live in apps/desktop/e2e and run separately.
export default defineConfig({
  test: {
    projects: ['packages/contracts', 'packages/core', 'packages/processors', 'apps/desktop/vitest.config.mts', 'tests/integration'],
  },
});
