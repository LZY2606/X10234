import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createApiServerPlugin } from "./src/server/vitePlugin";

export default defineConfig({
  plugins: [react(), createApiServerPlugin()],
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./src/core", import.meta.url)),
      "@server": fileURLToPath(new URL("./src/server", import.meta.url)),
    },
  },
  server: { host: "127.0.0.1" },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
  },
});
