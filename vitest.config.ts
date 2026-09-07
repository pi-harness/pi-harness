import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@pi-harness/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@pi-harness/plugin-api": fileURLToPath(new URL("./packages/plugin-api/src/index.ts", import.meta.url)),
    },
  },
  test: {
    execArgv: ["--expose-internals"],
    pool: "forks",
    maxWorkers: 4,
  },
});
