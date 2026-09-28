import { defineConfig } from 'vite';
import { tiltReviewApi } from './src/server/vitePlugin';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5349,
    strictPort: true,
  },
  plugins: [tiltReviewApi()],
  test: {
    include: ['src/tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
