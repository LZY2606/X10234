/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import { createApp } from './server/app';

function tiltReviewApi(): Plugin {
  return {
    name: 'tilt-review-api',
    configureServer(server) {
      const app = createApp({
        dbPath: process.env.TILT_REVIEW_DB ?? '.data/review.db',
        casepackDir: process.env.TILT_REVIEW_CASEPACK ?? 'casepack',
      });
      server.middlewares.use('/api', app);
    },
  };
}

export default defineConfig({
  plugins: [tiltReviewApi()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
