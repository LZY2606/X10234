import { defineConfig } from 'vite';
import { createApiHandler } from './src/server/api';

export default defineConfig({
  plugins: [
    {
      name: 'tilt-stitching-room-api',
      configureServer(server) {
        const handler = createApiHandler(process.env.TILT_DB || 'data/app.db');
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.startsWith('/api/')) {
            void handler(req, res);
          } else {
            next();
          }
        });
      },
    },
  ],
});
