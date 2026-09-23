import { defineConfig } from "vite";
import { createApiServer } from "./src/server/api";
import type { Plugin } from "vite";

export function tiltReviewApiPlugin(dbPath?: string): Plugin {
  const api = createApiServer(dbPath ?? process.env.TILT_DB ?? "data/review.sqlite");
  return {
    name: "tilt-review-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/api/")) {
          api.handle(req, res);
        } else {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [tiltReviewApiPlugin()],
});
