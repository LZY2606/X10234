import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          pool: "forks"
        }
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.e2e.test.ts"],
          environment: "node",
          pool: "forks",
          testTimeout: 60000,
          hookTimeout: 60000,
          globalSetup: ["tests/e2e/server-setup.ts"]
        }
      }
    ]
  }
});
