import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'node',
      environment: 'node',
      include: ['tests/unit/**/*.test.ts', 'tests/migration/**/*.test.ts', 'tests/replay/**/*.test.ts']
    }
  },
  {
    test: {
      name: 'browser-flow',
      environment: 'happy-dom',
      include: ['tests/e2e/**/*.test.ts']
    }
  }
]);
