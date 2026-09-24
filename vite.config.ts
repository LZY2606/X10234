import { defineConfig } from 'vite';
import { createApiMiddleware } from './src/server/api';

const dbPath = process.env.TOMO_DB || '.data/review.db';

export default defineConfig({
  plugins: [
    {
      name: 'tomography-review-api',
      configureServer(server) {
        server.middlewares.use('/api', createApiMiddleware(dbPath));
      },
    },
  ],
});
