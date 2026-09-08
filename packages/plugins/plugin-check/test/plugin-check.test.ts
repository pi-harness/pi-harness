import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import pluginCheckPlugin, { hasExtensionlessRelativeImport, isPluginRepositoryName, type PluginCheckReport } from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];
const directories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-plugin-check-"));
  directories.push(root);
  const context = new Context();
  const tools = new PiToolRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  const panels = new PiPluginUiRegistry();
  context.provide("piPluginUi", panels);
  await context.plugin(pluginCheckPlugin, {});
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "plugin_check");
  if (tool === undefined) throw new Error("plugin_check was not registered");
  return { root, tool, context, panels };
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

describe("independent npm plugins", () => {
  test("discovers unprefixed packages and accepts npm installation with a matching Cordis example", async () => {
    const { root, tool } = await fixture();
    const repo = join(root, "example");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src/index.ts"), "export default {}; ");
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({
        name: "@example/companion",
        main: "dist/index.js",
        keywords: ["pi-harness-plugin"],
        peerDependencies: { "@deepseek-ai/cordis": "4.0.1" },
        scripts: { build: "tsc" },
      }),
    );
    await writeFile(
      join(repo, "README.md"),
      'npm install --save-exact @example/companion\n```yaml\n- id: companion\n  name: "@example/companion"\n  config: {}\n```',
    );
    const result = await tool.execute("scan", { action: "scan" }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ scanned: 1, reports: [{ verdict: "pass", errors: [], warnings: [] }] });
  });

  test("rejects cancelled and disposed actions and detaches schema results", async () => {
    const { tool, context, panels } = await fixture();
    const result = await tool.execute("schema", { action: "schema" }, undefined, undefined, {} as never);
    (result.details as { checks: { label: string }[] }).checks[0]!.label = "changed";
    expect(JSON.stringify((await panels.snapshot())[0]!.data)).not.toContain("changed");
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute("cancel", { action: "schema" }, controller.signal, undefined, {} as never)).rejects.toThrow();
    await context.fiber.dispose();
    await expect(tool.execute("dispose", { action: "schema" }, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
  });

  test("does not scan an external symlinked source directory", async () => {
    const { root, tool } = await fixture();
    const repo = join(root, "pi-linked-source"),
      outside = join(root, "outside");
    await mkdir(repo);
    await mkdir(outside);
    await writeFile(join(outside, "secret.ts"), 'import hidden from "./secret";');
    await symlink(outside, join(repo, "src"));
    const result = await tool.execute("check", { action: "check", path: "pi-linked-source" }, undefined, undefined, {} as never);
    expect((result.details as PluginCheckReport).warnings).toContainEqual(expect.objectContaining({ code: "source-scan-incomplete" }));
    expect((result.details as PluginCheckReport).warnings.some((x) => x.code === "missing-ts-ext-imports")).toBe(false);
  });
});

test("rejects empty or malformed legacy patch rows", async () => {
  const { root, tool } = await fixture();
  const repo = join(root, "pi-malformed");
  await mkdir(repo);
  for (const patch of ["[]", "- null", "- id: example", "- id: ''\n  name: example"]) {
    await writeFile(join(repo, "cordis.patch.yml"), patch);
    const result = await tool.execute("bad-patch", { action: "check", path: "pi-malformed" }, undefined, undefined, {} as never);
    expect((result.details as PluginCheckReport).errors).toContainEqual(expect.objectContaining({ code: "malformed-patch" }));
  }
});
