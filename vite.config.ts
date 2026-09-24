import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  server: {
    host: '127.0.0.1',
    port: 5349,
    strictPort: true
  },
  build: { outDir: '../dist' }
});
