import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import archifyPlugin, { buildArchitectureReport } from "../src/plugins/archify.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("archify", () => {
  test("maps top-level workspace components and package dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src", "api"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "src", "api", "server.ts"), "export {}", "utf8");
    await writeFile(join(root, "tests", "server.test.ts"), "export {}", "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { zod: "^4.0.0" }, devDependencies: { vitest: "^4.0.0" } }), "utf8");

    const report = await buildArchitectureReport(root);

    expect(report.components).toEqual([
      { id: "component_src", label: "src", path: "src", files: 1, directories: 1 },
      { id: "component_tests", label: "tests", path: "tests", files: 1, directories: 0 },
    ]);
    expect(report.dependencies).toEqual(["vitest", "zod"]);
    expect(report.mermaid).toContain("project --> component_src");
    expect(report.mermaid).toContain('dependency_zod["zod"]');
  });

  test("marks the architecture report truncated when package metadata exceeds its input limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: {}, padding: "x".repeat(1024 * 1024) }), "utf8");

    await expect(buildArchitectureReport(root)).resolves.toMatchObject({ dependencies: [], truncated: true });
  });

  test("marks the architecture report incomplete when package metadata is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), "{ invalid", "utf8");

    await expect(buildArchitectureReport(root)).resolves.toMatchObject({ dependencies: [], truncated: true });
  });

  test("marks the architecture report incomplete when the package manifest root is not an object", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), "[]", "utf8");

    await expect(buildArchitectureReport(root)).resolves.toMatchObject({ dependencies: [], truncated: true });
  });

  test("marks the architecture report incomplete when a dependency section is not an object", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: [] }), "utf8");

    await expect(buildArchitectureReport(root)).resolves.toMatchObject({ dependencies: [], truncated: true });
  });

  test("normalizes a non-finite node limit before scanning the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await Promise.all(Array.from({ length: 301 }, (_, index) => mkdir(join(root, `component-${String(index).padStart(3, "0")}`))));

    const report = await buildArchitectureReport(root, Number.NaN);

    expect(report.truncated).toBe(true);
  });

  test("marks the architecture report truncated when top-level components exceed the output limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await Promise.all(Array.from({ length: 41 }, (_, index) => mkdir(join(root, `component-${String(index).padStart(2, "0")}`))));

    const report = await buildArchitectureReport(root, 500);

    expect(report.components).toHaveLength(40);
    expect(report.truncated).toBe(true);
  });

  test("assigns distinct Mermaid ids to components whose normalized paths collide", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "a-b"));
    await mkdir(join(root, "a_b"));

    const report = await buildArchitectureReport(root);

    expect(report.components.map((component) => component.id)).toEqual(["component_a_b", "component_a_b_2"]);
    for (const component of report.components) expect(report.mermaid).toContain(`${component.id}["${component.label}`);
  });

  test("assigns distinct Mermaid ids to dependencies whose normalized names collide", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "a-b": "1.0.0", a_b: "1.0.0" } }), "utf8");

    const report = await buildArchitectureReport(root);

    expect(report.mermaid).toContain('dependency_a_b["');
    expect(report.mermaid).toContain('dependency_a_b_2["');
    expect(report.mermaid.match(/project --> dependency_a_b(?:_2)?/gu)).toHaveLength(2);
  });

  test("drops oversized dependency names and marks the architecture report truncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { ["d".repeat(215)]: "1.0.0" } }), "utf8");

    await expect(buildArchitectureReport(root)).resolves.toMatchObject({ dependencies: [], truncated: true });
  });

  test("limits package dependencies and marks the architecture report truncated", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    const dependencies = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`dependency-${String(index).padStart(2, "0")}`, "1.0.0"]));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies }), "utf8");

    const report = await buildArchitectureReport(root);

    expect(report.dependencies).toHaveLength(40);
    expect(report.dependencies.at(-1)).toBe("dependency-39");
    expect(report.truncated).toBe(true);
  });

  test("treats a missing package manifest as a complete empty dependency scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);

    await expect(buildArchitectureReport(root)).resolves.toMatchObject({ dependencies: [], truncated: false });
  });

  test("escapes HTML-sensitive characters in Mermaid labels", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'evil&<script>"'));

    const report = await buildArchitectureReport(root);

    expect(report.mermaid).toContain("evil&amp;&lt;script&gt;&quot;");
    expect(report.mermaid).not.toContain("<script>");
  });

  test("marks the architecture report truncated when files exist below the scan depth", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    const deepest = join(root, "src", "one", "two", "three");
    await mkdir(deepest, { recursive: true });
    await writeFile(join(deepest, "hidden.ts"), "export {}", "utf8");

    const report = await buildArchitectureReport(root);

    expect(report.truncated).toBe(true);
  });

  test("registers the architecture tool and live panel for the launch workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export {}", "utf8");
    const context = new Context();
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(archifyPlugin);
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "architecture_map");
    if (tool === undefined) throw new Error("architecture_map was not registered");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ additionalProperties: false });
    expect(tool.parameters).toMatchObject({ properties: { maxNodes: { type: "integer", minimum: 1, maximum: 500 } } });

    await expect(tool.execute("map", { maxNodes: 100 }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { workspace: root, components: [{ path: "src", files: 1 }], dependencies: [] },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([
      { id: "archify-panel", data: { componentCount: 1, dependencyCount: 0, latest: { workspace: root } } },
    ]);

    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("does not expose mutable architecture state through tool or panel results", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"));
    const context = new Context();
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(archifyPlugin);
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "architecture_map");
    if (tool === undefined) throw new Error("architecture_map was not registered");
    const result = await tool.execute("map", {}, undefined, undefined, {} as never);
    (result.details as { components: Array<{ label: string }> }).components[0]!.label = "Mutated tool result";

    const firstPanel = (await panels.snapshot())[0];
    if (firstPanel === undefined) throw new Error("archify-panel was not registered");
    const firstLatest = (firstPanel.data as { latest: { components: Array<{ label: string }> } }).latest;
    expect(firstLatest.components[0]?.label).toBe("src");
    firstLatest.components[0]!.label = "Mutated panel result";

    const secondPanel = (await panels.snapshot())[0];
    if (secondPanel === undefined) throw new Error("archify-panel was not registered");
    expect((secondPanel.data as { latest: { components: Array<{ label: string }> } }).latest.components[0]?.label).toBe("src");
    await context.fiber.dispose();
  });

  test("preserves the last successful panel snapshot when a later scan fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"));
    const context = new Context();
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(archifyPlugin);
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "architecture_map");
    if (tool === undefined) throw new Error("architecture_map was not registered");
    await tool.execute("map", {}, undefined, undefined, {} as never);
    await rm(root, { recursive: true, force: true });

    await expect(tool.execute("map-again", {}, undefined, undefined, {} as never)).rejects.toThrow();
    await expect(panels.snapshot()).resolves.toMatchObject([
      { id: "archify-panel", data: { componentCount: 1, latest: { workspace: root, components: [{ path: "src" }] } } },
    ]);
    await context.fiber.dispose();
  });
});
