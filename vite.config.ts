import { defineConfig } from 'vite';
import { apiPlugin } from './src/server/plugin.ts';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: { host: '127.0.0.1', port: 5349, strictPort: true },
  plugins: [apiPlugin()],
});
