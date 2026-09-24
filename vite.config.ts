import { defineConfig } from "vitest/config";
import { apiPlugin } from "./server/vite-plugin";

export default defineConfig({
  plugins: [apiPlugin()],
  server: { host: "127.0.0.1", port: 5349, strictPort: true },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
