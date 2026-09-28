import { defineConfig } from "vite";
import { createApiHandler } from "./src/server/index.ts";

export default defineConfig({
  root: "web",
  publicDir: false,
  server: {
    host: "127.0.0.1",
    port: 5349,
    strictPort: true,
    middlewareMode: false,
  },
  plugins: [
    {
      name: "tilt-api",
      configureServer(server) {
        server.middlewares.use(createApiHandler());
      },
    },
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    pool: "forks",
  },
});
