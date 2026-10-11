import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Local only: dev and preview servers bind 127.0.0.1. In dev, /api goes to
// the Fastify server (`pcs serve` on PCS_PORT, default 5317), which holds the
// HotCRP token; the browser never sees it. In production the Fastify server
// serves web/dist itself.
const apiPort = Number(process.env.PCS_PORT ?? 5317);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
