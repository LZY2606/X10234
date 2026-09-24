import { defineConfig, type Plugin } from "vite";
import { createApiServer } from "./src/server/api.ts";
import type { ViteDevServer } from "vite";

function tiltApiPlugin(): Plugin {
  return {
    name: "tilt-series-api",
    configureServer(server: ViteDevServer) {
      const dbPath = process.env.TILT_DB_PATH ?? "data/tilt-series.sqlite";
      const api = createApiServer(dbPath);
      server.middlewares.use(api);
    },
  };
}

export default defineConfig({
  root: "src/web",
  plugins: [tiltApiPlugin()],
  server: { host: "127.0.0.1", port: 5349, strictPort: true },
  build: { outDir: "../../dist" },
});
