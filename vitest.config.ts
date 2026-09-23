import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    globals: true,
    server: {
      deps: {
        external: true,
      },
    },
    deps: {
      optimizer: {
        ssr: { exclude: ['node:sqlite'] },
      },
    },
  },
});
