import { defineConfig } from 'vitest/config'

export default defineConfig({
  server: { strictPort: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000
  }
})
