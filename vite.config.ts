import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { apiPlugin } from './src/server/plugin';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1', port: 5349, strictPort: true },
  plugins: [apiPlugin()],
  build: { target: 'es2022' },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 20000
  }
});
