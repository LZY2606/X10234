import { defineConfig } from 'vite';
import { reviewApiPlugin } from './src/server/vite-plugin.ts';

export default defineConfig({
  plugins: [reviewApiPlugin()],
  server: { host: '127.0.0.1', port: 5349, strictPort: true },
  test: {
    projects: [
      { test: { name: 'unit', environment: 'node', include: ['tests/unit/**/*.test.ts'], globals: false } },
      { test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'], testTimeout: 60000 } },
    ],
  },
});
