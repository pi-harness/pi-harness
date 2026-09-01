import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "../src/services.js";
import modelPlugin from "../src/plugins/model.js";
import modelsPlugin from "../src/plugins/models.js";
import resourcesPlugin from "../src/plugins/resources.js";
import sessionPlugin from "../src/plugins/session.js";
import toolsPlugin from "../src/plugins/tools.js";
import contextPlugin from "../src/plugins/context.js";
import agentTeamsPlugin from "../src/plugins/agent-teams.js";
import modlensPlugin from "../src/plugins/modlens.js";
import tokenGuardPlugin from "../src/plugins/token-guard.js";
import gitTimeCapsulePlugin from "../src/plugins/git-time-capsule.js";
import dependencyCheckerPlugin from "../src/plugins/dependency-checker.js";
import atFilePlugin from "../src/plugins/at-file.js";
import failLoggerPlugin from "../src/plugins/fail-logger.js";
import testHarnessPlugin from "../src/plugins/test-harness.js";

const contexts: Context[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function createContext(): Promise<{ context: Context; cwd: string; agentDir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-agent-"));
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
  return { context, cwd, agentDir };
}

const modelConfig = { provider: "deepseek", model: "deepseek-v4-flash", refreshOnCreate: false } as const;
const isolatedResources = { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } as const;

describe("Pi domain plugins", () => {
  test("fails activation when the selected model does not exist", async () => {
    const { context } = await createContext();

    await context.plugin(modelsPlugin, { provider: "missing-provider", model: "missing-model", refreshOnCreate: false });
    await context.plugin(resourcesPlugin, isolatedResources);

    await expect(context.plugin(modelPlugin)).rejects.toThrow(/missing-provider\/missing-model/);
  });

  test("activates a pending resources plugin after its models dependency", async () => {
    const { context, cwd } = await createContext();
    const pendingResources = context.plugin(resourcesPlugin, isolatedResources);

    await context.plugin(modelsPlugin, modelConfig);
    await pendingResources;

    expect(context.get("piResources")?.cwd).toBe(cwd);
    expect(context.get("piResources")?.modelRuntime).toBe(context.get("piModelRuntime")?.runtime);
  });

  test("isolates Pi model files under the configured agent directory", async () => {
    const { context, agentDir } = await createContext();

    await context.plugin(modelsPlugin, modelConfig);

    const runtime = context.piModelRuntime.runtime as unknown as { modelsPath: string };
    expect(runtime.modelsPath).toBe(join(agentDir, "models.json"));
  });

  test("selects models registered by Pi extensions after resource loading", async () => {
    const { context, agentDir } = await createContext();
    const extensionsDir = join(agentDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(
      join(extensionsDir, "provider.ts"),
      `export default function (pi) { pi.registerProvider("extension-provider", { baseUrl: "https://example.invalid", apiKey: "test-key", api: "openai-completions", models: [{ id: "extension-model", name: "Extension Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }] }); }`,
      "utf8",
    );

    await context.plugin(modelsPlugin, { provider: "extension-provider", model: "extension-model", refreshOnCreate: false });
    await context.plugin(resourcesPlugin, { ...isolatedResources, noExtensions: false });
    await context.plugin(modelPlugin);

    expect(context.piModels.model.id).toBe("extension-model");
    expect(context.piModels.model.provider).toBe("extension-provider");
  });

  test("creates an in-memory session when configured", async () => {
    const { context } = await createContext();

    await context.plugin(sessionPlugin, { storage: "memory" });

    expect(context.get("piSession")?.manager.isPersisted()).toBe(false);
  });

  test("creates a JSONL session in the configured directory", async () => {
    const { context } = await createContext();
    const directory = await mkdtemp(join(tmpdir(), "pi-harness-sessions-"));

    await context.plugin(sessionPlugin, { storage: "jsonl", directory });

    expect(context.get("piSession")?.manager.isPersisted()).toBe(true);
    expect(context.get("piSession")?.manager.getSessionDir()).toBe(directory);
  });

  test("keeps the default JSONL session under the configured agent directory", async () => {
    const { context, agentDir } = await createContext();

    await context.plugin(sessionPlugin, { storage: "jsonl" });

    expect(context.get("piSession")?.manager.getSessionDir()).toBe(join(agentDir, "sessions"));
  });

  test("contributes Pi's core tools through a lifecycle-owned registry", async () => {
    const { context } = await createContext();

    await context.plugin(toolsPlugin, { names: ["read", "bash", "edit", "write"] });

    expect(context.get("piTools")?.snapshot()).toEqual({ names: ["read", "bash", "edit", "write"], customTools: [] });
  });

  test("rejects tool contributions while runtime owns a snapshot and accepts them after release", () => {
    const tools = new PiToolRegistry();
    const lateTool = defineTool({
      name: "late",
      label: "Late",
      description: "A tool registered after runtime startup.",
      parameters: Type.Object({}),
      execute() {
        return Promise.resolve({ content: [{ type: "text", text: "late" }], details: undefined });
      },
    });

    const lease = tools.acquire();
    expect(lease.names).toEqual([]);
    expect(lease.customTools).toEqual([]);
    expect(() => tools.register(lateTool)).toThrow(/leased/);

    lease.release();
    expect(() => tools.register(lateTool)).not.toThrow();
  });

  test("registers and disposes plugin UI panels with the plugin lifecycle", async () => {
    const panels = new PiPluginUiRegistry();
    const dispose = panels.register({
      id: "example-panel",
      pluginId: "example-plugin",
      title: "Example",
      read: () => ({ ready: true }),
    });

    await expect(panels.snapshot()).resolves.toEqual([{ id: "example-panel", pluginId: "example-plugin", title: "Example", data: { ready: true } }]);
    dispose();
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("publishes a live context insight panel from the session runtime", async () => {
    const context = new Context();
    contexts.push(context);
    const panels = new PiPluginUiRegistry();
    context.provide("piRuntime", {
      session: { messages: [{ role: "user" }], getContextUsage: () => ({ tokens: 1200, contextWindow: 8000, percent: 15 }) },
    } as never);
    context.provide("piPluginUi", panels);

    await context.plugin(contextPlugin);

    await expect(panels.snapshot()).resolves.toEqual([
      {
        id: "context-insight-panel",
        pluginId: "@pi-harness/core/plugins/context",
        title: "上下文洞察",
        description: "查看当前上下文占用、消息规模和压缩事件。",
        icon: "◒",
        data: { tokens: 1200, contextWindow: 8000, percent: 15, messages: 1, events: 0, compactions: 0 },
      },
    ]);
  });

  test("persists agent team tasks and exposes a live collaboration panel", async () => {
    const context = new Context();
    contexts.push(context);
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    const entries: unknown[] = [];
    context.provide("piSession", {
      manager: {
        getEntries: () => entries,
        appendCustomEntry: (_type: string, data: unknown) => entries.push({ type: "custom", customType: "pi-harness/agent-teams", data }),
      },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);

    await context.plugin(agentTeamsPlugin);
    const tool = tools.snapshot().customTools[0];
    await expect(tool.execute("call-1", { action: "add_task", title: "Review plugin manifest" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [{ text: "Task task-1 created." }],
    });
    await expect(panels.snapshot()).resolves.toMatchObject([
      { id: "agent-teams-panel", data: { tasks: [{ title: "Review plugin manifest", status: "todo" }] } },
    ]);
    expect(entries).toHaveLength(1);
  });

  test("attaches an in-workspace image through the modlens tool", async () => {
    const { context, cwd } = await createContext();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    await writeFile(join(cwd, "screen.png"), "png-data", "utf8");
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);

    await context.plugin(modlensPlugin);
    const tool = tools.snapshot().customTools[0];
    await expect(tool.execute("call-1", { path: "screen.png" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [{ type: "image", mimeType: "image/png" }],
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "modlens-panel", data: { attached: true, image: { path: "screen.png", bytes: 8 } } }]);
    await expect(tool.execute("call-2", { path: "../outside.png" }, undefined, undefined, {} as never)).rejects.toThrow(/inside the current workspace/);
  });

  test("stops a streaming run when the configured token budget is exceeded", async () => {
    const context = new Context();
    contexts.push(context);
    const panels = new PiPluginUiRegistry();
    let aborts = 0;
    context.provide("piRuntime", {
      session: { isStreaming: true, getContextUsage: () => ({ tokens: 7200, contextWindow: 8000, percent: 90 }) },
      abort: async () => {
        aborts += 1;
      },
    } as never);
    context.provide("piPluginUi", panels);

    await context.plugin(tokenGuardPlugin, { maxPercent: 80 });
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "token-guard-panel", data: { maxPercent: 80, exceeded: true, percent: 90, aborts: 1 } }]);
    expect(aborts).toBe(1);
  });

  test("writes a Git time capsule outside the workspace", async () => {
    const { context, cwd } = await createContext();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    await execFileAsync("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["-c", "user.name=Pi", "-c", "user.email=pi@example.invalid", "commit", "-qm", "initial"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "after\n", "utf8");
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);

    await context.plugin(gitTimeCapsulePlugin);
    const tool = tools.snapshot().customTools[0];
    await expect(tool.execute("call-1", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [{ text: expect.stringMatching(/^Git snapshot saved:/) }],
    });
    const snapshot = await panels.snapshot();
    expect(snapshot[0]).toMatchObject({
      id: "git-time-capsule-panel",
      data: { latest: { files: 1, bytes: expect.any(Number) }, capsules: [{ bytes: expect.any(Number) }] },
    });
    expect(String((snapshot[0] as { data?: { latest?: { name?: string } } }).data?.latest?.name)).toMatch(/\.patch$/);
  });

  test("reports missing local dependencies without contacting a registry", async () => {
    const { context, cwd } = await createContext();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ dependencies: { "present-package": "1.0.0", "missing-package": "1.0.0" } }), "utf8");
    await mkdir(join(cwd, "node_modules", "present-package"), { recursive: true });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);

    await context.plugin(dependencyCheckerPlugin);
    const tool = tools.snapshot().customTools[0];
    await expect(tool.execute("call-1", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { declared: 2, installed: 1, missing: ["missing-package"] },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "dependency-checker-panel", data: { report: { missing: ["missing-package"] } } }]);
  });

  test("attaches a bounded workspace file for @file context", async () => {
    const { context, cwd } = await createContext();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    await writeFile(join(cwd, "notes.md"), "# Notes\ncontent", "utf8");
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);

    await context.plugin(atFilePlugin);
    const tool = tools.snapshot().customTools[0];
    await expect(tool.execute("call-1", { path: "notes.md" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [{ text: '<file path="notes.md">\n# Notes\ncontent\n</file>' }],
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "at-file-panel", data: { lastFile: { path: "notes.md", bytes: 15 } } }]);
    await expect(tool.execute("call-2", { path: "../notes.md" }, undefined, undefined, {} as never)).rejects.toThrow(/inside the current workspace/);
  });

  test("deduplicates extension failures in the live failure logger panel", async () => {
    const context = new Context();
    contexts.push(context);
    const panels = new PiPluginUiRegistry();
    context.provide("piPluginUi", panels);
    await context.plugin(failLoggerPlugin);

    const error = new Error("extension failed");
    context.emit("pi/extension-error", error);
    context.emit("pi/extension-error", error);
    await expect(panels.snapshot()).resolves.toMatchObject([
      { id: "fail-logger-panel", data: { total: 1, failures: [{ source: "extension", message: "extension failed" }] } },
    ]);
  });

  test("only runs approved project scripts in the test harness", async () => {
    const { context } = await createContext();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(testHarnessPlugin);
    const tool = tools.snapshot().customTools[0];
    await expect(tool.execute("call-1", { script: "rm -rf /" }, undefined, undefined, {} as never)).rejects.toThrow(/not allowed/);
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "test-harness-panel", data: { allowedScripts: expect.arrayContaining(["test", "build"]) } }]);
  });
});
