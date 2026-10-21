import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Dev harness server for the renderer (mock OrbitApi, no Electron):
 *   node_modules/.bin/vite --config apps/desktop/src/renderer/dev/vite.config.mts
 *   → http://127.0.0.1:5199/dev/index.html
 * Screenshots: node apps/desktop/src/renderer/dev/screenshots.mjs
 */
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [react()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 5199, strictPort: false },
  build: {
    outDir: fileURLToPath(new URL('../../../out/renderer-harness', import.meta.url)),
    emptyOutDir: true,
    rolldownOptions: { input: fileURLToPath(new URL('./index.html', import.meta.url)) },
  },
});
