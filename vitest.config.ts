import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/migrations/**/*.test.ts', 'test/e2e/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
