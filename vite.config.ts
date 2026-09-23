import { defineConfig } from 'vite';
import { tiltApiPlugin } from './src/server/plugin.js';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5349,
    strictPort: true
  },
  plugins: [tiltApiPlugin()],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
