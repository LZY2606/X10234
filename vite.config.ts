import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { apiPlugin } from './src/server/plugin';

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared'), '@core': resolve(__dirname, 'src/core'), '@server': resolve(__dirname, 'src/server') }
  },
  plugins: [apiPlugin()],
  server: { host: '127.0.0.1', port: 5349, strictPort: true },
  appType: 'spa'
});
