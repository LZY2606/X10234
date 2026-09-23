import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared'), '@core': resolve(__dirname, 'src/core'), '@server': resolve(__dirname, 'src/server') }
  },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'tests/repo/**/*.test.ts', 'tests/scenarios/**/*.test.ts'],
          environment: 'node',
          pool: 'forks'
        },
        resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@core': resolve(__dirname, 'src/core'), '@server': resolve(__dirname, 'src/server') } }
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          pool: 'forks',
          testTimeout: 60000,
          hookTimeout: 60000
        },
        resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@core': resolve(__dirname, 'src/core'), '@server': resolve(__dirname, 'src/server') } }
      }
    ]
  }
});
