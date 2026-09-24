import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tiltApiPlugin } from './src/server/plugin';

export default defineConfig({
  plugins: [react(), tiltApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5349,
    strictPort: true,
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
