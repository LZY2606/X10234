import { defineConfig, type Plugin } from 'vite';
import { openDatabase } from './src/server/db.js';
import { createApiHandler } from './src/server/api.js';

const dbPath = process.env.TILT_REVIEW_DB ?? new URL('./data/tilt-review.sqlite', import.meta.url).pathname;

function tiltApiPlugin(): Plugin {
  return {
    name: 'tilt-review-api',
    configureServer(server) {
      const db = openDatabase(dbPath);
      server.middlewares.use(createApiHandler(db));
    },
  };
}

export default defineConfig({
  root: '.',
  plugins: [tiltApiPlugin()],
  server: { host: '127.0.0.1', port: 5349, strictPort: true },
});
