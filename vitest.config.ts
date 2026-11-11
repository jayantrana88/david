import { defineConfig } from "vitest/config";

// Pure logic only (no bindings): plain Node is enough, so no Workers test pool.
export default defineConfig({ test: { environment: "node", include: ["test/**/*.test.ts"] } });
