import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: { exclude: ["sql.js"] },
  test: {
    environment: "node",
    include: ["src/test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
