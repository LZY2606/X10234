import { defineConfig } from "vite";
import { createApp } from "./server/app";

export default defineConfig({
  plugins: [
    {
      name: "tilt-review-api",
      configureServer(server) {
        const app = createApp(process.env.TILT_DB ?? "data/tilt-review.sqlite");
        server.middlewares.use("/api", app);
      },
    },
  ],
  server: { host: "127.0.0.1", port: 5349, strictPort: true },
});
