import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { apiServerPlugin } from './src/server/vite-plugin';

export default defineConfig({
  plugins: [react(), apiServerPlugin()],
  server: { host: '127.0.0.1', port: 5349, strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['test/unit/**/*.test.ts', 'test/migration/**/*.test.ts'],
    testTimeout: 20000,
    pool: 'forks'
  }
});
