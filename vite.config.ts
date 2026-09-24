import { defineConfig } from "vite";
import { tomomiddleware } from "./server/dev-server";

export default defineConfig({
  root: "public",
  publicDir: false,
  server: {
    host: "127.0.0.1",
    port: 5349,
    strictPort: true,
  },
  plugins: [
    {
      name: "tomography-review-api",
      configureServer(server) {
        tomomiddleware(server.middlewares);
      },
    },
  ],
});
