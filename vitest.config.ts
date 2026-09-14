import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Keep tests on local source for plugins that still live in this repository. Published plugins
// have no source directory after migration, so letting Vite resolve their package entry avoids
// pointing a broad alias at a path that cannot exist in a clean checkout.
const localPluginAliases = readdirSync(source("./packages/plugins"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(source(`./packages/plugins/${entry.name}/src/index.ts`)))
  .map((entry) => ({ find: `@pi-harness/plugin-${entry.name}`, replacement: source(`./packages/plugins/${entry.name}/src/index.ts`) }));

export default defineConfig({
  resolve: {
    // Ordered: the subpath and plugin-package patterns must win before the bare "@pi-harness/core" prefix alias.
    alias: [
      { find: "@pi-harness/plugin-api", replacement: source("./packages/plugin-api/src/index.ts") },
      ...localPluginAliases,
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
