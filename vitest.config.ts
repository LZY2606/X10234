import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/unit/**/*.test.ts", "test/migrations/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "browser",
          environment: "happy-dom",
          include: ["test/e2e/**/*.test.ts"],
        },
      },
    ],
  },
});
