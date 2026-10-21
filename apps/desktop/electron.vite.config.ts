import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Workspace packages (@orbitdrop/*) are devDependencies, so they are bundled;
// runtime dependencies (sharp, pdfjs-dist, @napi-rs/canvas, …) stay external
// and are shipped in node_modules by electron-builder.
//
// main: two entries — the main process (index) and the processor worker
// (processor-host, forked as an Electron utilityProcess). The worker loads
// @orbitdrop/processors with a dynamic import (its own chunk) so a broken
// native engine is reported instead of killing the worker. External dynamic
// imports stay native `import()` in the CJS output (rolldown dynamicImportInCjs
// default), which is what ESM-only packages such as pdfjs-dist need.
//
// preload: runs sandboxed, where only `electron` (and a few Node built-ins)
// can be required. Everything it imports is bundled (externalizeDeps: false);
// modules are treated as side-effect free and zod schema construction (`z.*`)
// as pure, so only IPC_CHANNELS from the contracts ends up in the bundle.
export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'processor-host': resolve(__dirname, 'src/main/processing/host.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron'],
        treeshake: { moduleSideEffects: false, manualPureFunctions: ['z'] },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      minify: true,
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
