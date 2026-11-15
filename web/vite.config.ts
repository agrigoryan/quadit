import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The Go server answers the API and serves files; in development Vite
// forwards both to it. Set QUADIT_API to point somewhere else.
const api = process.env.QUADIT_API ?? "http://127.0.0.1:4780";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/f": { target: api, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // Pure logic runs in node. A component test starts with the line
    //   // @vitest-environment jsdom
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    restoreMocks: true,
  },
});
