import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { extractModuleMatches } from "../src/index.js";
import moduleSearchPlugin from "../src/index.js";

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

  test("matches type-only, default-plus-named, and multi-line import and export lists", () => {
    expect(extractModuleMatches('import type { Context } from "@deepseek-ai/cordis";', "plugin.ts", "Context", "import")).toEqual([
      { kind: "import", name: "Context", path: "plugin.ts", line: 1, text: 'import type { Context } from "@deepseek-ai/cordis";' },
    ]);
    expect(extractModuleMatches('import type { Context } from "@deepseek-ai/cordis";', "plugin.ts", "Context", "all")).toEqual([
      { kind: "import", name: "Context", path: "plugin.ts", line: 1, text: 'import type { Context } from "@deepseek-ai/cordis";' },
    ]);
    expect(extractModuleMatches('import {\n  readFile,\n  writeFile,\n} from "node:fs/promises";\nconst other = 1;', "fs.ts", "File", "all")).toEqual([
      { kind: "import", name: "readFile", path: "fs.ts", line: 1, text: "import {" },
      { kind: "import", name: "writeFile", path: "fs.ts", line: 1, text: "import {" },
    ]);
    expect(extractModuleMatches('import type Def from "./def.js";\nimport Other, { named } from "./other.js";', "defaults.ts", "e", "all")).toEqual([
      { kind: "import", name: "Def", path: "defaults.ts", line: 1, text: 'import type Def from "./def.js";' },
      { kind: "import", name: "Other", path: "defaults.ts", line: 2, text: 'import Other, { named } from "./other.js";' },
      { kind: "import", name: "named", path: "defaults.ts", line: 2, text: 'import Other, { named } from "./other.js";' },
    ]);
    expect(extractModuleMatches('import { type Foo, Bar as Baz } from "./x.js";', "inline.ts", "foo", "all")).toEqual([
      { kind: "import", name: "Foo", path: "inline.ts", line: 1, text: 'import { type Foo, Bar as Baz } from "./x.js";' },
    ]);
    expect(extractModuleMatches('import { type Foo, Bar as Baz } from "./x.js";', "inline.ts", "ba", "all")).toEqual([
      { kind: "import", name: "Bar", path: "inline.ts", line: 1, text: 'import { type Foo, Bar as Baz } from "./x.js";' },
    ]);
    expect(extractModuleMatches('export type { Foo } from "./foo.js";\nexport {\n  readFile as rf,\n  type Bar,\n};', "index.ts", "o", "all")).toEqual([
      { kind: "export", name: "Foo", path: "index.ts", line: 1, text: 'export type { Foo } from "./foo.js";' },
    ]);
    expect(extractModuleMatches('export type { Foo } from "./foo.js";\nexport {\n  readFile as rf,\n  type Bar,\n};', "index.ts", "r", "all")).toEqual([
      { kind: "export", name: "rf", path: "index.ts", line: 2, text: "export {" },
      { kind: "export", name: "Bar", path: "index.ts", line: 2, text: "export {" },
    ]);
  });

  test("does not let an unbalanced brace list in a comment swallow the declarations that follow it", () => {
    const source = "// re-export via import {\nfunction alpha() {\n  const beta = 1;\n  return beta;\n}\nclass Gamma {}\n";
    expect(extractModuleMatches(source, "comment.ts", "a", "all")).toEqual([
      { kind: "symbol", name: "alpha", path: "comment.ts", line: 2, text: "function alpha() {" },
      { kind: "symbol", name: "beta", path: "comment.ts", line: 3, text: "  const beta = 1;" },
      { kind: "symbol", name: "Gamma", path: "comment.ts", line: 6, text: "class Gamma {}" },
    ]);
    expect(extractModuleMatches(source, "comment.ts", "import", "all")).toEqual([]);
    const exported = "// a stray export {\nexport const delta = 1;\nexport { delta };\n";
    expect(extractModuleMatches(exported, "stray.ts", "delta", "all")).toEqual([
      { kind: "export", name: "delta", path: "stray.ts", line: 2, text: "export const delta = 1;" },
      { kind: "export", name: "delta", path: "stray.ts", line: 3, text: "export { delta };" },
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

  test("counts a single oversize target file once", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-module-search-oversize-"));
    await writeFile(join(cwd, "huge.ts"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
    const context = new Context();
    const tools = new PiToolRegistry();
    provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(moduleSearchPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "module_search");
      await expect(tool!.execute("call-1", { query: "read", path: "huge.ts" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { matches: [], scannedFiles: 0, skippedFiles: 1 },
      });
    } finally {
      await context.fiber.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("skips invalid UTF-8 source files instead of parsing replacement characters", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-module-search-utf8-"));
    await writeFile(join(cwd, "invalid.ts"), Buffer.from([0xc3, 0x28, 0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x20, 0x63, 0x6f, 0x6e, 0x73, 0x74]));
    const context = new Context();
    const tools = new PiToolRegistry();
    provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await context.plugin(moduleSearchPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "module_search");
      await expect(tool!.execute("call-1", { query: "export" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { matches: [], scannedFiles: 0, skippedFiles: 1 },
      });
    } finally {
      await context.fiber.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
  test("isolates report snapshots and uses the default limit for non-finite inputs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-module-search-snapshot-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await writeFile(join(cwd, "module.ts"), "export const readOne = 1; export const readTwo = 2;");
      await context.plugin(moduleSearchPlugin);
      const tool = tools.snapshot().customTools[0]!;
      const result = await tool.execute("snapshot", { query: "read", maxResults: Number.NaN }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ matches: [{ name: "readOne" }, { name: "readTwo" }] });
      (result.details as { matches: { name: string }[] }).matches[0]!.name = "changed";
      const first = (await panels.snapshot())[0]!.data as { latest: { matches: { name: string }[] } };
      expect(first.latest.matches[0]!.name).toBe("readOne");
      first.latest.matches[0]!.name = "changed again";
      expect((await panels.snapshot())[0]!.data).toMatchObject({ latest: { matches: [{ name: "readOne" }, { name: "readTwo" }] } });
    } finally {
      await context.fiber.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects cancelled and disposed searches without replacing the last successful report", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-module-search-cancel-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await writeFile(join(cwd, "module.ts"), "export const readOne = 1;");
      await context.plugin(moduleSearchPlugin);
      const tool = tools.snapshot().customTools[0]!;
      await tool.execute("initial", { query: "read" }, undefined, undefined, {} as never);
      const cancelled = new AbortController();
      cancelled.abort(new Error("caller cancelled"));
      await expect(tool.execute("cancelled", { query: "missing" }, cancelled.signal, undefined, {} as never)).rejects.toThrow("caller cancelled");
      const active = new AbortController();
      const pending = tool.execute("active", { query: "missing" }, active.signal, undefined, {} as never);
      active.abort(new Error("active cancelled"));
      await expect(pending).rejects.toThrow("active cancelled");
      expect((await panels.snapshot())[0]!.data).toMatchObject({ latest: { query: "read" } });
      const disposing = tool.execute("disposing", { query: "missing" }, undefined, undefined, {} as never);
      const rejected = expect(disposing).rejects.toThrow("Module search plugin disposed");
      await context.fiber.dispose();
      await rejected;
      await expect(tool.execute("retained", { query: "read" }, undefined, undefined, {} as never)).rejects.toThrow("Module search plugin disposed");
      expect(tools.snapshot().customTools).toHaveLength(0);
      expect(await panels.snapshot()).toHaveLength(0);
    } finally {
      await context.fiber.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
