import { defineConfig } from "vitest/config";
import { createApiPlugin } from "./server/vite-plugin.ts";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    globals: false
  },
  plugins: [createApiPlugin()]
});
