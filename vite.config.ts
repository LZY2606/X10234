import { defineConfig } from "vite";
import { tiltApiPlugin } from "./src/server/api-plugin";

export default defineConfig({
  root: "public",
  publicDir: false,
  server: {
    host: "127.0.0.1",
    port: 5349,
    strictPort: true
  },
  plugins: [
    tiltApiPlugin({
      dbPath: process.env.TILT_DB_PATH ?? "./data/tilt-room.sqlite"
    })
  ],
  build: {
    outDir: "../dist"
  }
});
