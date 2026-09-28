import { defineConfig } from 'vite';
import { tiltLabApiPlugin } from './src/server/plugin';

export default defineConfig({
  plugins: [tiltLabApiPlugin()],
  server: { host: '127.0.0.1' }
});
