import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tiltApiPlugin } from './src/server/plugin';

export default defineConfig({
  root: 'src/ui',
  publicDir: '../../public',
  plugins: [react(), tiltApiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5349,
    strictPort: true
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/migration/**/*.test.ts'],
    globals: true
  }
});
