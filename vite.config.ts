import { defineConfig } from 'vite';
import { apiPlugin } from './src/core/server/plugin';

export default defineConfig({
  plugins: [apiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5349,
    strictPort: true,
  },
});
