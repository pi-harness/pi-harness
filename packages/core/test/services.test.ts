import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
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
import sessionInsightsPlugin from "../src/plugins/session-insights.js";
import cleanerPlugin from "../src/plugins/cleaner.js";
import i18nPairPlugin from "../src/plugins/i18n-pair.js";
import sqlLensPlugin from "../src/plugins/sql-lens.js";
import dockerSandboxPlugin from "../src/plugins/docker-sandbox.js";
import mcpClientPlugin from "../src/plugins/mcp-client.js";
import browserFetchPlugin from "../src/plugins/browser-fetch.js";
import browserSessionPlugin from "../src/plugins/browser-session.js";
import yamlValidatorPlugin from "../src/plugins/yaml-validator.js";
import readmeGenPlugin from "../src/plugins/readme-gen.js";

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

  test("publishes native session usage statistics without duplicating session storage", async () => {
    const { context } = await createContext();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    const report = {
      sessionId: "session-1",
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 4,
      tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
      cost: 0.01,
      contextUsage: { tokens: 30, contextWindow: 1000, percent: 3 },
    };
    context.provide("piRuntime", { session: { getSessionStats: () => report } } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(sessionInsightsPlugin);
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "session-insights-panel", data: report }]);
    await expect(tools.snapshot().customTools[0].execute("call-1", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: report });
  });

  test("generates a README report without overwriting project files", async () => {
    const { context, cwd } = await createContext();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ name: "demo", version: "1.2.3", description: "Demo project", scripts: { test: "vitest", build: "tsc" } }),
      "utf8",
    );
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(readmeGenPlugin);
    const result = await tools.snapshot().customTools[0].execute("call-1", {}, undefined, undefined, {} as never);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("# demo") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("npm run test") });
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "readme-gen-panel", data: { generated: true, name: "demo", scripts: 2 } }]);
  });

  test("requires explicit confirmation before cleaning only generated capsules", async () => {
    const { context, agentDir } = await createContext();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    await mkdir(join(agentDir, "capsules"), { recursive: true });
    await writeFile(join(agentDir, "capsules", "202601.patch"), "new", "utf8");
    await writeFile(join(agentDir, "capsules", "202501.patch"), "old", "utf8");
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(cleanerPlugin);
    const tool = tools.snapshot().customTools[0];
    await expect(tool.execute("call-1", { confirm: false }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/);
    await expect(tool.execute("call-2", { confirm: true, keep: 1 }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { removed: 1, kept: 1 },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "cleaner-panel", data: { capsules: [{ name: "202601.patch" }] } }]);
  });

  test("reports missing and extra keys between local locale files", async () => {
    const { context, cwd } = await createContext();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    await mkdir(join(cwd, "locales"), { recursive: true });
    await writeFile(join(cwd, "locales", "en.json"), JSON.stringify({ greeting: { title: "Hello" }, save: "Save" }), "utf8");
    await writeFile(join(cwd, "locales", "zh-CN.json"), JSON.stringify({ greeting: { title: "你好" }, onlyHere: "仅此处" }), "utf8");
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(i18nPairPlugin);
    const result = await tools.snapshot().customTools[0].execute("call-1", {}, undefined, undefined, {} as never);
    expect(result).toMatchObject({ details: { missing: ["save"], extra: ["onlyHere"] } });
  });

  test("executes bounded read-only SQLite queries and rejects mutations", async () => {
    const { context, cwd } = await createContext();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    const db = new DatabaseSync(join(cwd, "data.db"));
    db.exec("CREATE TABLE users (id INTEGER, name TEXT); INSERT INTO users VALUES (1, 'Ada');");
    db.close();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(sqlLensPlugin);
    const tool = tools.snapshot().customTools[0];
    await expect(
      tool.execute("call-1", { database: "data.db", query: "SELECT id, name FROM users" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ details: { rows: [{ id: 1, name: "Ada" }], columns: ["id", "name"] } });
    await expect(tool.execute("call-2", { database: "data.db", query: "DELETE FROM users" }, undefined, undefined, {} as never)).rejects.toThrow(
      /only allows|rejected/,
    );
    await expect(tool.execute("call-3", { database: "data.db", query: "PRAGMA journal_mode=WAL" }, undefined, undefined, {} as never)).rejects.toThrow(
      /read-only|rejected/,
    );
  });

  test("requires confirmation and argv execution for Docker sandbox writes", async () => {
    const { context } = await createContext();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(dockerSandboxPlugin);
    const tool = tools.snapshot().customTools[0];
    await expect(tool.execute("call-1", { command: ["echo", "ok"], write: true }, undefined, undefined, {} as never)).rejects.toThrow(/confirmWrite=true/);
    await expect(tool.execute("call-2", { command: ["sh", "-c", "echo ok"] }, undefined, undefined, {} as never)).rejects.toThrow(/Shell wrappers/);
    await expect(tool.execute("call-3", { command: ["/bin/sh", "-c", "echo ok"] }, undefined, undefined, {} as never)).rejects.toThrow(/Shell wrappers/);
  });

  test("discovers and calls tools through an MCP stdio server", async () => {
    const { context, cwd } = await createContext();
    const server = join(cwd, "mcp-fixture.mjs");
    await writeFile(
      server,
      `let buffer = Buffer.alloc(0); const handle = (message) => { let result = {}; if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { resources: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1" } }; if (message.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }] }; if (message.method === "tools/call") result = { content: [{ type: "text", text: String(message.params.arguments?.text ?? "") }], isError: false }; if (message.method === "resources/list") result = { resources: [{ uri: "fixture://readme", name: "Readme", mimeType: "text/plain" }] }; if (message.method === "resources/read") result = { contents: [{ uri: message.params.uri, mimeType: "text/plain", text: "resource body" }] }; if (message.method === "prompts/list") result = { prompts: [{ name: "review", description: "Review prompt", arguments: [] }] }; if (message.method === "prompts/get") result = { description: "Review prompt", messages: [{ role: "user", content: { type: "text", text: "Review this" } }] }; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n"); }; process.stdin.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); while (true) { const end = buffer.indexOf("\\r\\n\\r\\n"); if (end < 0) break; const match = buffer.subarray(0, end).toString().match(/Content-Length: (\\d+)/i); if (!match) break; const length = Number(match[1]); if (buffer.length < end + 4 + length) break; const body = buffer.subarray(end + 4, end + 4 + length); buffer = buffer.subarray(end + 4 + length); handle(JSON.parse(body)); } });`,
      "utf8",
    );
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(mcpClientPlugin, { servers: [{ id: "fixture", command: [process.execPath, server], autoStart: false }] });
    const registered = tools.snapshot().customTools;
    const listTools = registered.find((tool) => tool.name === "mcp_list_tools");
    const callTool = registered.find((tool) => tool.name === "mcp_call");
    const startTool = registered.find((tool) => tool.name === "mcp_server_start");
    const statusTool = registered.find((tool) => tool.name === "mcp_server_status");
    const stopTool = registered.find((tool) => tool.name === "mcp_server_stop");
    const listResourcesTool = registered.find((tool) => tool.name === "mcp_list_resources");
    const readResourceTool = registered.find((tool) => tool.name === "mcp_read_resource");
    const listPromptsTool = registered.find((tool) => tool.name === "mcp_list_prompts");
    const getPromptTool = registered.find((tool) => tool.name === "mcp_get_prompt");
    expect(listTools).toBeDefined();
    expect(callTool).toBeDefined();
    expect(startTool).toBeDefined();
    expect(statusTool).toBeDefined();
    expect(stopTool).toBeDefined();
    expect(listResourcesTool).toBeDefined();
    expect(readResourceTool).toBeDefined();
    expect(listPromptsTool).toBeDefined();
    expect(getPromptTool).toBeDefined();
    await expect(listTools!.execute("call-1", { command: [process.execPath, server] }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tools: [{ name: "echo" }] },
    });
    await expect(
      callTool!.execute("call-2", { command: [process.execPath, server], name: "echo", arguments: { text: "hello" } }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "hello" }] });
    const started = await startTool!.execute("call-3", { serverId: "fixture" }, undefined, undefined, {} as never);
    const serverId = (started.details as { serverId: string }).serverId;
    await expect(statusTool!.execute("call-4", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { servers: [{ id: serverId, status: "running" }] },
    });
    await expect(listTools!.execute("call-5", { serverId }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tools: [{ name: "echo" }] },
    });
    await expect(
      callTool!.execute("call-6", { serverId, name: "echo", arguments: { text: "persistent" } }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "persistent" }] });
    await expect(listResourcesTool!.execute("call-6a", { serverId }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { resources: [{ uri: "fixture://readme" }] },
    });
    await expect(readResourceTool!.execute("call-6b", { serverId, uri: "fixture://readme" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { contents: [{ text: "resource body" }] },
    });
    await expect(listPromptsTool!.execute("call-6c", { serverId }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { prompts: [{ name: "review" }] },
    });
    await expect(getPromptTool!.execute("call-6d", { serverId, name: "review" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { messages: [{ role: "user" }] },
    });
    await expect(stopTool!.execute("call-7", { serverId }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { stopped: true } });
    await expect(statusTool!.execute("call-8", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { servers: [{ id: "fixture", status: "stopped" }] },
    });
    await expect(listTools!.execute("call-9", { command: ["/bin/sh", "-c", "echo bad"] }, undefined, undefined, {} as never)).rejects.toThrow(
      /shell wrapper/iu,
    );
  });

  test("fetches bounded browser pages and blocks private targets by default", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<html><body><h1>Pi Harness</h1></body></html>");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test server did not bind to a port");
    try {
      const { context } = await createContext();
      const panels = new PiPluginUiRegistry();
      const tools = new PiToolRegistry();
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(browserFetchPlugin, { allowPrivate: true });
      const fetchTool = tools.snapshot().customTools[0];
      await expect(fetchTool.execute("call-1", { url: `http://127.0.0.1:${address.port}/` }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { status: 200, contentType: "text/html", text: "<html><body><h1>Pi Harness</h1></body></html>" },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    const blocked = await createContext();
    const blockedPanels = new PiPluginUiRegistry();
    const blockedTools = new PiToolRegistry();
    blocked.context.provide("piTools", blockedTools);
    blocked.context.provide("piPluginUi", blockedPanels);
    await blocked.context.plugin(browserFetchPlugin);
    await expect(blockedTools.snapshot().customTools[0].execute("call-2", { url: "http://127.0.0.1:1/" }, undefined, undefined, {} as never)).rejects.toThrow(
      /private|local/iu,
    );
  });

  test("connects to a real Chrome DevTools session for tabs, text, and clicks", async () => {
    const pageServer = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        '<html><body><button id="toggle" onclick="document.body.dataset.clicked=\'yes\'">Click me</button><p>Browser session fixture</p></body></html>',
      );
    });
    await new Promise<void>((resolve, reject) => {
      pageServer.once("error", reject);
      pageServer.listen(0, "127.0.0.1", () => resolve());
    });
    const portProbe = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      portProbe.once("error", reject);
      portProbe.listen(0, "127.0.0.1", () => resolve());
    });
    const portAddress = portProbe.address();
    if (portAddress === null || typeof portAddress === "string") throw new Error("Chrome port probe failed");
    const debugPort = portAddress.port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    const profileDir = await mkdtemp(join(tmpdir(), "pi-harness-chrome-"));
    const chrome = execFile(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${debugPort}`,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    try {
      let endpoint = `http://127.0.0.1:${debugPort}`;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const response = await fetch(`${endpoint}/json/version`);
          if (response.ok) break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const { context } = await createContext();
      const panels = new PiPluginUiRegistry();
      const tools = new PiToolRegistry();
      context.provide("piTools", tools);
      context.provide("piPluginUi", panels);
      await context.plugin(browserSessionPlugin, { endpoint });
      const registered = tools.snapshot().customTools;
      const tabsTool = registered.find((tool) => tool.name === "browser_tabs");
      const navigateTool = registered.find((tool) => tool.name === "browser_navigate");
      const readTool = registered.find((tool) => tool.name === "browser_read");
      const clickTool = registered.find((tool) => tool.name === "browser_click");
      expect(tabsTool).toBeDefined();
      expect(navigateTool).toBeDefined();
      const tabs = await tabsTool!.execute("call-1", {}, undefined, undefined, {} as never);
      const tab = (tabs.details as { tabs: Array<{ targetId: string }> }).tabs.find((item) => item.targetId);
      expect(tab).toBeDefined();
      await expect(
        navigateTool!.execute(
          "call-2",
          { targetId: tab!.targetId, url: `http://127.0.0.1:${(pageServer.address() as { port: number }).port}/` },
          undefined,
          undefined,
          {} as never,
        ),
      ).resolves.toMatchObject({ details: { status: "navigated" } });
      await expect(readTool!.execute("call-3", { targetId: tab!.targetId }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { text: expect.stringContaining("Browser session fixture") },
      });
      await expect(clickTool!.execute("call-4", { targetId: tab!.targetId, selector: "#toggle" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { clicked: true },
      });
    } finally {
      chrome.kill();
      await new Promise<void>((resolve) => {
        if (chrome.exitCode !== null) resolve();
        else chrome.once("exit", () => resolve());
      });
      await rm(profileDir, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => pageServer.close((error) => (error ? reject(error) : resolve())));
    }
  }, 30_000);

  test("validates YAML files with line-aware diagnostics without modifying them", async () => {
    const { context, cwd } = await createContext();
    await writeFile(join(cwd, "valid.yml"), "name: pi-harness\nitems:\n  - one\n  - two\n", "utf8");
    await writeFile(join(cwd, "invalid.yml"), "name: [broken\n", "utf8");
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(yamlValidatorPlugin);
    const tool = tools.snapshot().customTools[0];
    await expect(tool.execute("call-1", { path: "valid.yml" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { valid: true, documents: 1, rootType: "map", errors: [] },
    });
    await expect(tool.execute("call-2", { path: "invalid.yml" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { valid: false, errors: [{ line: 2 }] },
    });
    await expect(tool.execute("call-3", { path: "../invalid.yml" }, undefined, undefined, {} as never)).rejects.toThrow(/inside the current workspace/);
  });
});
