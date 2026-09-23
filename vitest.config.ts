import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "happy-dom",
    environmentOptions: {
      happyDom: { url: "http://127.0.0.1:5349/" },
    },
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
