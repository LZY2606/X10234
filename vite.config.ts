import { defineConfig } from 'vite';
import { createReviewApi } from './src/server/api.js';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5349,
    strictPort: true,
  },
  plugins: [
    {
      name: 'tilt-review-api',
      configureServer(server) {
        server.middlewares.use(createReviewApi());
      },
    },
  ],
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
