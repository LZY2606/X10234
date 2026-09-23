import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./src/core", import.meta.url)),
      "@server": fileURLToPath(new URL("./src/server", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
