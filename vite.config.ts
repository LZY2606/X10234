import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: { host: "127.0.0.1", port: 5349, strictPort: true },
  build: { outDir: "dist", target: "es2022" },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
