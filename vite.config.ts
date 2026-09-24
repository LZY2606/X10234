import { defineConfig } from 'vite';
import { tiltApiPlugin } from './src/server/vite-plugin';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [tiltApiPlugin()],
  server: { host: '127.0.0.1', port: 5349, strictPort: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000
  }
});
