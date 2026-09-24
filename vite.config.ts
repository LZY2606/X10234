import { defineConfig } from "vite";
import { createApiPlugin } from "./server/vite-plugin.ts";

export default defineConfig({
  server: { host: "127.0.0.1", port: 5349, strictPort: true },
  plugins: [createApiPlugin()],
  build: { target: "es2022" }
});
