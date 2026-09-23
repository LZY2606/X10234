import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    globalSetup: ["test/e2e/globalSetup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
