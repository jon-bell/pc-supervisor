import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Local only: dev and preview servers bind 127.0.0.1. M5 adds a proxy to the
// Fastify API on PCS_PORT; the browser never sees the HotCRP token.
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
