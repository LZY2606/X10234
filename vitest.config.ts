import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/migration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000
  }
});
