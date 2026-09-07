import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import pluginCheckPlugin, { hasExtensionlessRelativeImport, isPluginRepositoryName, type PluginCheckReport } from "../src/plugins/plugin-check.js";
import { provideLaunchContext, PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];
const directories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-plugin-check-"));
  directories.push(root);
  const context = new Context();
  const tools = new PiToolRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", new PiPluginUiRegistry());
  await context.plugin(pluginCheckPlugin, {});
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "plugin_check");
  if (tool === undefined) throw new Error("plugin_check was not registered");
  return { root, tool };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
    const { tool } = await fixture();
    expect(tool.parameters).toMatchObject({
      properties: { action: { anyOf: [{ const: "check" }, { const: "scan" }, { const: "schema" }] } },
    });
  });
});

describe("plugin metadata read failures", () => {
  test("reports symlinked metadata files as per-file diagnostics instead of failing the tool call", async () => {
    const { root, tool } = await fixture();
    const repo = join(root, "pi-linked-metadata");
    const outside = join(root, "outside");
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "package.json"), JSON.stringify({ name: "pi-linked-metadata", main: "dist/index.js" }), "utf8");
    await writeFile(join(outside, "README.md"), "pi plugin --profile web add github:example/pi-linked-metadata\n", "utf8");
    await writeFile(join(outside, "cordis.patch.yml"), "- id: pi-linked-metadata\n", "utf8");
    await symlink(join(outside, "package.json"), join(repo, "package.json"));
    await symlink(join(outside, "README.md"), join(repo, "README.md"));
    await symlink(join(outside, "cordis.patch.yml"), join(repo, "cordis.patch.yml"));

    const result = await tool.execute("call-1", { action: "check", path: "pi-linked-metadata" }, undefined, undefined, {} as never);

    const details = result.details as PluginCheckReport;
    expect(details.errors.find((error) => error.code === "no-manifest")?.message).toMatch(/package\.json is not a readable regular file/u);
    expect(details.errors.find((error) => error.code === "no-patch")?.message).toMatch(/cordis\.patch\.yml is not a readable regular file/u);
    expect(details.warnings.find((warning) => warning.code === "missing-profile-install-example")?.message).toMatch(
      /README\.md is not a readable regular file/u,
    );
  });
});
