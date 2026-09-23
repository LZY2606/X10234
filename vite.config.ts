import { defineConfig } from 'vite';
import { tiltRoomApi } from './src/server/plugin';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5349, strictPort: true },
  plugins: [tiltRoomApi()],
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/state/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
