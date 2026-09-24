import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  optimizeDeps: { include: ['sql.js'] },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 30000
  }
});
