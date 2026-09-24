import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { apiPlugin } from './src/server/plugin';

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: { host: '127.0.0.1', port: 5349, strictPort: true },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    globals: false,
    testTimeout: 20000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
