import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: 'src/web',
  server: {
    middlewareMode: true,
  },
  test: {
    include: ['test/**/*.test.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'e2e',
          environment: 'happy-dom',
          include: ['test/e2e/**/*.test.ts'],
        },
      },
    ],
  },
});
