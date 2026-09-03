import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "../src/services.js";
import { extractModuleMatches } from "../src/plugins/module-search.js";
import moduleSearchPlugin from "../src/plugins/module-search.js";

describe("module search", () => {
  test("extracts matching imports and exports with line numbers", () => {
    expect(
      extractModuleMatches(
        'import { readFile } from "node:fs/promises";\nexport function readConfig() { return readFile; }\nconst ignored = 1;',
        "config.ts",
        "read",
        "all",
      ),
    ).toEqual([
      { kind: "import", name: "readFile", path: "config.ts", line: 1, text: 'import { readFile } from "node:fs/promises";' },
      { kind: "export", name: "readConfig", path: "config.ts", line: 2, text: "export function readConfig() { return readFile; }" },
    ]);
    expect(extractModuleMatches('import { readFile, writeFile } from "node:fs/promises";', "config.ts", "readFile", "import")).toEqual([
      { kind: "import", name: "readFile", path: "config.ts", line: 1, text: 'import { readFile, writeFile } from "node:fs/promises";' },
    ]);
  });

  test("searches source files without traversing dependency directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-module-search-"));
    await writeFile(join(cwd, "module.ts"), 'import { readFile } from "node:fs";\nexport const readConfig = readFile;\n', "utf8");
    await writeFile(join(cwd, "ignored.js"), "export const readIgnored = true;\n", "utf8");
    await mkdir(join(cwd, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "dependency", "index.ts"), "export const readDependency = true;\n", "utf8");
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(moduleSearchPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "module_search");
      expect(tool).toBeDefined();
      await expect(tool!.execute("call-1", { query: "read", kind: "export" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: {
          matches: [
            { name: "readIgnored", path: "ignored.js" },
            { name: "readConfig", path: "module.ts" },
          ],
          scannedFiles: 2,
        },
      });
    } finally {
      await context.fiber.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reports truncation when one file contains more matches than the limit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-module-search-limit-"));
    await writeFile(join(cwd, "module.ts"), "export const readOne = 1; export const readTwo = 2;\n", "utf8");
    const context = new Context();
    const tools = new PiToolRegistry();
    provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(moduleSearchPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "module_search");
      await expect(tool!.execute("call-1", { query: "read", kind: "export", maxResults: 1 }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { matches: [{ name: "readOne" }], truncated: true },
      });
    } finally {
      await context.fiber.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
