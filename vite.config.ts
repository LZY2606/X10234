import { defineConfig, type Plugin } from 'vite';
import { createApiMiddleware } from './src/server/api';
import { openDatabase } from './src/server/db';

function apiPlugin(): Plugin {
  return {
    name: 'tilt-frame-chamber-api',
    configureServer(server) {
      const db = openDatabase(process.env.TFC_DB ?? 'data/dev.db');
      const middleware = createApiMiddleware(db, { caseDir: 'cases' });
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/api/')) {
          void middleware(req, res, next);
        } else {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [apiPlugin()],
  server: { strictPort: true },
});
