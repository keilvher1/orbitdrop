import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Workspace packages (@orbitdrop/*) are devDependencies, so they are bundled;
// runtime dependencies (sharp, pdfjs-dist, @napi-rs/canvas, …) stay external
// and are shipped in node_modules by electron-builder.
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
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
