import { defineConfig } from 'vite';
import { createApiPlugin } from './src/server/plugin';

export default defineConfig({
  plugins: [createApiPlugin()],
  server: { host: '127.0.0.1', port: 5349, strictPort: true },
  preview: { host: '127.0.0.1', port: 5349, strictPort: true },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/migrations/**/*.test.ts', 'tests/e2e/**/*.e2e.ts'],
    testTimeout: 30000
  }
});
