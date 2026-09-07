import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import pluginCheckPlugin, { hasExtensionlessRelativeImport, isPluginRepositoryName } from "../src/plugins/plugin-check.js";
import { provideLaunchContext, PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("plugin repository discovery", () => {
  test("accepts Pi Harness and legacy DSH plugin directory names", () => {
    expect(isPluginRepositoryName("pi-colleague-skill")).toBe(true);
    expect(isPluginRepositoryName("dsh-vision-toolkit")).toBe(true);
    expect(isPluginRepositoryName("example-plugin")).toBe(true);
  });

  test("does not scan dependency or hidden directories", () => {
    expect(isPluginRepositoryName("node_modules")).toBe(false);
    expect(isPluginRepositoryName(".git")).toBe(false);
    expect(isPluginRepositoryName("workspace")).toBe(false);
  });
});

describe("plugin source checks", () => {
  test("accepts relative imports that already carry their emitted extension", () => {
    expect(hasExtensionlessRelativeImport('import { a } from "./a.js";\nimport b from "../nested/b.json";\n')).toBe(false);
    expect(hasExtensionlessRelativeImport('export { c } from "./c.mjs";\n')).toBe(false);
  });

  test("flags relative imports that omit their file extension", () => {
    expect(hasExtensionlessRelativeImport('import { a } from "./a.js";\nimport { d } from "../nested/d";\n')).toBe(true);
    expect(hasExtensionlessRelativeImport('import e from "./nested/e";\n')).toBe(true);
  });

  test("ignores bare package specifiers", () => {
    expect(hasExtensionlessRelativeImport('import { Type } from "@earendil-works/pi-ai";\nimport z from "yaml";\n')).toBe(false);
  });

  test("enumerates the supported actions in the tool schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-plugin-check-"));
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(pluginCheckPlugin, {});
    contexts.push(context);
    const tool = tools.snapshot().customTools.find((item) => item.name === "plugin_check");
    if (tool === undefined) throw new Error("plugin_check was not registered");
    expect(tool.parameters).toMatchObject({
      properties: { action: { anyOf: [{ const: "check" }, { const: "scan" }, { const: "schema" }] } },
    });
  });
});
