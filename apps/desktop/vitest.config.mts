import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'desktop',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    passWithNoTests: true,
  },
});
