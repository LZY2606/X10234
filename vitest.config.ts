import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    reporters: ["default"],
  },
});
