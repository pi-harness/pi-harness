import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Ordered: the subpath and plugin-package patterns must win before the bare "@pi-harness/core" prefix alias.
    alias: [
      { find: "@pi-harness/plugin-api", replacement: source("./packages/plugin-api/src/index.ts") },
      { find: /^@pi-harness\/plugin-([a-z0-9-]+)$/u, replacement: source("./packages/plugins/$1/src/index.ts") },
      { find: "@pi-harness/core/test-harness", replacement: source("./packages/core/src/test-harness.ts") },
      { find: /^@pi-harness\/core\/plugins\/([a-z0-9-]+)$/u, replacement: source("./packages/core/src/plugins/$1.ts") },
      { find: "@pi-harness/core", replacement: source("./packages/core/src/index.ts") },
    ],
  },
  test: {
    execArgv: ["--expose-internals"],
    pool: "forks",
    maxWorkers: 4,
  },
});
