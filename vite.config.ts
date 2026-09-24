import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { apiServerPlugin } from './src/server/plugin';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  plugins: [apiServerPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5349,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5349,
    strictPort: true,
  },
});
