import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import pluginCheckPlugin, { hasExtensionlessRelativeImport, isPluginRepositoryName, type PluginCheckReport } from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];
const directories: string[] = [];

async function fixture(config: { scanLimit?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-plugin-check-"));
  directories.push(root);
  const context = new Context();
  const tools = new PiToolRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  const panels = new PiPluginUiRegistry();
  context.provide("piPluginUi", panels);
  await context.plugin(pluginCheckPlugin, config);
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
  test("accepts current plugin directory hints without DSH aliases", () => {
    expect(isPluginRepositoryName("pi-colleague-skill")).toBe(true);
    expect(isPluginRepositoryName("dsh-vision-toolkit")).toBe(false);
    expect(isPluginRepositoryName("example-plugin")).toBe(true);
  });

  test("does not scan dependency or hidden directories", () => {
    expect(isPluginRepositoryName("node_modules")).toBe(false);
    expect(isPluginRepositoryName(".git")).toBe(false);
    expect(isPluginRepositoryName("workspace")).toBe(false);
  });
});

describe("plugin source checks", () => {
  test("returns actionable diagnostics and schema definitions to the model", async () => {
    const { tool } = await fixture();
    for (const action of ["check", "schema"]) {
      const result = await tool.execute(action, { action }, undefined, undefined, {} as never);
      const text = result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      expect(() => {
        JSON.parse(text);
      }).not.toThrow();
      expect(JSON.parse(text)).toEqual(result.details);
    }
  });

  test("exposes repository identities and scan truncation in model-visible content", async () => {
    const { root, tool } = await fixture({ scanLimit: 1 });
    await mkdir(join(root, "pi-first"));
    await mkdir(join(root, "pi-second"));
    const result = await tool.execute("scan", { action: "scan" }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ scanned: 1, truncated: true });
    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(() => {
      JSON.parse(text);
    }).not.toThrow();
    expect(JSON.parse(text)).toEqual(result.details);
  });

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
    expect(details.errors).toContainEqual(expect.objectContaining({ code: "missing-plugin-metadata" }));
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

test("ignores old patch files and does not accept old install commands", async () => {
  const { root, tool } = await fixture();
  const repo = join(root, "pi-current");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      name: "pi-current",
      main: "dist/index.js",
      keywords: ["cordis"],
      peerDependencies: { "@deepseek-ai/cordis": "4.0.1" },
      scripts: { build: "tsc" },
    }),
  );
  await writeFile(join(repo, "cordis.patch.yml"), "- null");
  await writeFile(join(repo, "dsh.bundle.patch"), "not: a sequence");
  for (const command of ["dsh plugin --profile web add pi-current", "pi plugin --profile web add pi-current"]) {
    await writeFile(join(repo, "README.md"), command);
    const result = await tool.execute("old", { action: "check", path: "pi-current" }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ verdict: "warn", errors: [], warnings: [{ code: "missing-profile-install-example" }] });
  }
  await writeFile(join(repo, "README.md"), "npm install --save-exact pi-current\n```yaml\n- name: pi-current\n```");
  await writeFile(join(repo, "README.md"), "npm install --save-exact another-package\n```yaml\n- name: pi-current\n```");
  const unrelated = await tool.execute("unrelated", { action: "check", path: "pi-current" }, undefined, undefined, {} as never);
  expect((unrelated.details as PluginCheckReport).warnings).toContainEqual(expect.objectContaining({ code: "missing-profile-install-example" }));
  await writeFile(join(repo, "README.md"), "npm install --save-exact pi-current@1.0.0\n```yaml\n- name: pi-current\n```");
  const current = await tool.execute("current", { action: "check", path: "pi-current" }, undefined, undefined, {} as never);
  expect(current.details).toMatchObject({ verdict: "pass", errors: [], warnings: [] });
  const schema = await tool.execute("schema", { action: "schema" }, undefined, undefined, {} as never);
  expect(JSON.stringify(schema.details)).not.toMatch(/patch|row-id/u);
});

test("uses the active native workspace and rejects a result after replacement", async () => {
  const { root, tool, context, panels } = await fixture();
  const active = await mkdtemp(join(tmpdir(), "pi-check-active-"));
  directories.push(active);
  const native = { sessionId: "active", sessionManager: { getCwd: () => active } };
  const runtime = { session: native };
  context.provide("piRuntime", runtime as never);
  const result = await tool.execute("active", { action: "check" }, undefined, undefined, {} as never);
  expect(result.details).toMatchObject({ path: await realpath(active) });
  const pending = tool.execute("pending", { action: "check" }, undefined, undefined, {} as never);
  runtime.session = { sessionId: "replacement", sessionManager: { getCwd: () => root } };
  await expect(pending).rejects.toThrow(/workspace changed/iu);
  expect((await panels.snapshot())[0]?.data).toMatchObject({ latest: null });
});
