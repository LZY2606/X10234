import { defineConfig } from 'vite';
import { createApiMiddleware } from './src/server/app';

export default defineConfig({
  plugins: [
    {
      name: 'tilt-series-api',
      configureServer(server) {
        const dbPath = process.env.TILT_DB || '.tilt-dev.db';
        server.middlewares.use('/api', createApiMiddleware(dbPath));
      },
    },
  ],
});
