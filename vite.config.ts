import { defineConfig } from 'vite';
import { tiltApiPlugin } from './src/server/plugin';

export default defineConfig({
  root: '.',
  plugins: [tiltApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5349,
    strictPort: true,
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
  },
});
