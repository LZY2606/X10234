import { defineConfig } from "vite";
import { tiltApiPlugin } from "./src/server/plugin";

export default defineConfig({
  plugins: [tiltApiPlugin()],
  server: { host: "127.0.0.1", port: 5349, strictPort: true },
  build: { target: "es2022", outDir: "dist/client" },
});
