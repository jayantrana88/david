import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

// The API refuses a POST whose Origin isn't its own, so the dev proxy presents the Worker's address as the origin.
const WORKER = "http://127.0.0.1:8787";
const devProxy = {
  target: WORKER,
  configure: (proxy: { on(event: "proxyReq", fn: (req: { setHeader(k: string, v: string): void }) => void): void }) =>
    proxy.on("proxyReq", (req) => req.setHeader("Origin", WORKER)),
};

// The dashboard is a static single-page app: the Worker serves web/dist (wrangler.jsonc "assets") and answers
// /api/* and /oauth/*. `npm run dev:web` runs it with hot reload against `npm run dev` (wrangler dev, port 8787).
export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.join(root, "src") } },
  build: { outDir: path.join(root, "dist"), emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { proxy: { "/api": devProxy, "/oauth": devProxy } },
});
