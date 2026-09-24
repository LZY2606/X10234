import { defineConfig } from "vitest/config";
import { tiltReviewApiPlugin } from "./src/server/vitePlugin";

export default defineConfig({
  plugins: [tiltReviewApiPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5349,
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
  },
});
