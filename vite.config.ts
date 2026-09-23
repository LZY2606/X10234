/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { reviewApiPlugin } from './src/server/plugin';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    host: '127.0.0.1',
    port: 5349,
    strictPort: true,
  },
  plugins: [reviewApiPlugin()],
  test: {
    environment: 'happy-dom',
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 20000,
  },
});
