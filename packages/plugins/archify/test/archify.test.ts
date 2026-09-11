import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import archifyPlugin, { buildArchitectureReport } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("archify", () => {
  test("exposes incomplete scan metadata alongside the diagram to the model", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-report-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    const context = new Context();
    const tools = new PiToolRegistry();
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(archifyPlugin);
    try {
      const tool = tools.snapshot().customTools.find((item) => item.name === "architecture_map")!;
      const result = await tool.execute("partial", { maxNodes: 1 }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ truncated: true, workspace: root });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("keeps component ids unique when an original name matches a generated suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    for (const name of ["a-b", "a_b", "a_b_2", "a-b-2"]) await mkdir(join(root, name));
    const report = await buildArchitectureReport(root);
    const ids = report.components.map((component) => component.id);
    expect(new Set(ids).size).toBe(4);
    for (const component of report.components) expect(report.mermaid).toContain(`${component.id}["${component.label}`);
  });

  test("keeps dependency ids unique when an original name matches a generated suffix", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-archify-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "a-b": "1", a_b: "1", a_b_2: "1", "a-b-2": "1" } }));
    const report = await buildArchitectureReport(root);
    const ids = [...report.mermaid.matchAll(/^ {4}(dependency_\w+)\[/gmu)].map((match) => match[1]);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

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

test("maps the current native workspace and discards switched, cancelled, and disposed scans", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-archify-native-"));
  temporaryDirectories.push(root);
  const active = join(root, "active");
  await mkdir(join(root, "launch-only"));
  await mkdir(join(active, "current-only"), { recursive: true });
  await writeFile(join(active, "package.json"), JSON.stringify({ dependencies: { current: "1" } }));
  const context = new Context(),
    tools = new PiToolRegistry(),
    panels = new PiPluginUiRegistry();
  let id = "first";
  let session = { sessionId: id, sessionManager: { getCwd: () => root } };
  try {
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    context.provide("piRuntime", {
      get session() {
        return session;
      },
    } as never);
    await context.plugin(archifyPlugin);
    const tool = tools.snapshot().customTools[0]!;
    await tool.execute("first", {}, undefined, undefined, {} as never);
    session = {
      get sessionId() {
        return id;
      },
      sessionManager: { getCwd: () => active },
    };
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { latest: null, componentCount: 0, dependencyCount: 0 } }]);
    await expect(tool.execute("active", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { workspace: active, components: [{ path: "current-only" }], dependencies: ["current"] },
    });
    const pending = tool.execute("pending", {}, undefined, undefined, {} as never);
    id = "replacement";
    await expect(pending).rejects.toThrow(/workspace changed/iu);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { latest: null } }]);
    await expect(
      tool.execute(
        "getter",
        {
          get maxNodes() {
            id = "getter-replacement";
            return 100;
          },
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/workspace changed/iu);
    const cancelled = new AbortController();
    const cancelling = tool.execute("cancel", {}, cancelled.signal, undefined, {} as never);
    cancelled.abort(new Error("scan cancelled"));
    await expect(cancelling).rejects.toThrow("scan cancelled");
    const disposing = tool.execute("dispose", {}, undefined, undefined, {} as never);
    const disposedResult = expect(disposing).rejects.toThrow(/disposed/iu);
    await context.fiber.dispose();
    await disposedResult;
    await expect(tool.execute("retained", {}, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
  } finally {
    await context.fiber.dispose();
  }
});
