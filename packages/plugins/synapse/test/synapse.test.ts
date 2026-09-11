import { chmod, mkdtemp, readFile, rename, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import synapsePlugin, { buildSynapseGraph } from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("synapse", () => {
  test("builds fork graph with orphan accounting", () => {
    const sessions = [
      { id: "root", path: "/root.jsonl", cwd: "/workspace", firstMessage: "Root", messageCount: 2, modified: new Date("2026-01-01") },
      {
        id: "child",
        path: "/child.jsonl",
        cwd: "/workspace",
        firstMessage: "Child",
        messageCount: 3,
        modified: new Date("2026-01-02"),
        parentSessionPath: "/root.jsonl",
      },
      {
        id: "orphan",
        path: "/orphan.jsonl",
        cwd: "/workspace",
        firstMessage: "Orphan",
        messageCount: 1,
        modified: new Date("2026-01-03"),
        parentSessionPath: "/missing.jsonl",
      },
    ];
    const graph = buildSynapseGraph(sessions as never, "/child.jsonl");
    expect(graph).toMatchObject({
      activeSessionId: "child",
      orphanCount: 1,
      edges: [{ from: "root", to: "child", kind: "fork" }],
    });
    expect(graph.nodes.find((node) => node.id === "root")).toMatchObject({ branchCount: 1 });
    expect(graph.nodes.find((node) => node.id === "child")).toMatchObject({ parentSessionId: "root", active: true });
  });

  test("refreshes native sessions and exposes strict sequential metadata", async () => {
    const list = vi
      .spyOn(SessionManager, "list")
      .mockResolvedValue([
        { id: "root", path: "/root.jsonl", cwd: "/workspace", firstMessage: "Root", messageCount: 1, modified: new Date("2026-01-01") } as never,
      ]);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: "/workspace", agentDir: "/agent", args: [], requestExit() {} });
    context.provide("piSession", {
      manager: { getCwd: () => "/workspace", getSessionId: () => "root", getSessionDir: () => "/agent/sessions", getSessionFile: () => "/root.jsonl" },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(synapsePlugin, { maxSessions: 10 });
    contexts.push(context);
    const tool = tools.snapshot().customTools.find((item) => item.name === "synapse_session_map");
    if (tool === undefined) throw new Error("synapse_session_map was not registered");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    await expect(tool.execute("map", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { nodes: [{ id: "root" }] } });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { nodes: [{ id: "root" }], refreshes: 1 } }]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("serves rapid panel polls from one bounded session scan", async () => {
    const list = vi
      .spyOn(SessionManager, "list")
      .mockResolvedValue([
        { id: "root", path: "/root.jsonl", cwd: "/workspace", firstMessage: "Root", messageCount: 1, modified: new Date("2026-01-01") } as never,
      ]);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: "/workspace", agentDir: "/agent", args: [], requestExit() {} });
    context.provide("piSession", {
      manager: { getCwd: () => "/workspace", getSessionId: () => "root", getSessionDir: () => "/agent/sessions", getSessionFile: () => "/root.jsonl" },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(synapsePlugin, { maxSessions: 10 });
    contexts.push(context);
    const [first, second] = await Promise.all([panels.snapshot(), panels.snapshot()]);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { nodes: [{ id: "root" }], refreshes: 0 } }]);
    expect(first).toMatchObject([{ data: { nodes: [{ id: "root" }] } }]);
    expect(second).toMatchObject([{ data: { nodes: [{ id: "root" }] } }]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test("counts synapse_session_map invocations rather than expired panel polls", async () => {
    const list = vi
      .spyOn(SessionManager, "list")
      .mockResolvedValue([
        { id: "root", path: "/root.jsonl", cwd: "/workspace", firstMessage: "Root", messageCount: 1, modified: new Date("2026-01-01") } as never,
      ]);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: "/workspace", agentDir: "/agent", args: [], requestExit() {} });
    context.provide("piSession", {
      manager: { getCwd: () => "/workspace", getSessionId: () => "root", getSessionDir: () => "/agent/sessions", getSessionFile: () => "/root.jsonl" },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(synapsePlugin, { maxSessions: 10 });
    contexts.push(context);
    const tool = tools.snapshot().customTools.find((item) => item.name === "synapse_session_map");
    if (tool === undefined) throw new Error("synapse_session_map was not registered");
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    const counted: number[] = [];
    // Three polls spread past the cache window, so each one rescans and would previously have been counted as a refresh.
    for (let poll = 0; poll < 3; poll += 1) {
      vi.setSystemTime(start + poll * 7_500);
      counted.push(((await panels.snapshot())[0]?.data as { refreshes: number }).refreshes);
    }
    expect(counted).toEqual([0, 0, 0]);
    expect(list).toHaveBeenCalledTimes(3);
    await tool.execute("map", {}, undefined, undefined, {} as never);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { refreshes: 1 } }]);
  });
});

test("keeps maps tied to active native managers and returns detached model-visible results", async () => {
  const root = SessionManager.inMemory("/launch");
  const active = SessionManager.inMemory("/active");
  const runtime = { session: { sessionManager: active } };
  const list = vi
    .spyOn(SessionManager, "list")
    .mockResolvedValue([{ id: "native", path: "/native.jsonl", cwd: "/active", firstMessage: "当前工作区", messageCount: 1, modified: new Date() } as never]);
  const context = new Context();
  contexts.push(context);
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: "/launch", agentDir: "/agent", args: [], requestExit() {} });
  context.provide("piSession", { manager: root } as never);
  context.provide("piRuntime", runtime as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(synapsePlugin, {});
  const tool = tools.snapshot().customTools.find((item) => item.name === "synapse_session_map")!;
  const result = await tool.execute("map", {}, undefined, undefined, {} as never);
  expect(list).toHaveBeenLastCalledWith("/active", active.getSessionDir());
  expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ cwd: "/active", nodes: [{ label: "当前工作区" }] });
  (result.details as { nodes: unknown[] }).nodes.length = 0;
  expect((await panels.snapshot())[0]?.data).toMatchObject({ nodes: [{ id: "native" }] });
  runtime.session.sessionManager = SessionManager.inMemory("/second");
  await panels.snapshot();
  expect(list).toHaveBeenLastCalledWith("/second", runtime.session.sessionManager.getSessionDir());
  const abort = new AbortController();
  abort.abort();
  await expect(tool.execute("abort", {}, abort.signal, undefined, {} as never)).rejects.toThrow(/cancel/i);
  await expect(tool.execute("invalid", { extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/parameter/i);
});

test("rejects scans that outlive their native session and does not commit cancelled work", async () => {
  const manager = SessionManager.inMemory("/workspace");
  let finish!: (value: never[]) => void;
  const list = vi.spyOn(SessionManager, "list").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const context = new Context();
  contexts.push(context);
  const tools = new PiToolRegistry();
  provideLaunchContext(context, { cwd: "/workspace", agentDir: "/agent", args: [], requestExit() {} });
  context.provide("piSession", { manager } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", new PiPluginUiRegistry());
  await context.plugin(synapsePlugin, {});
  const tool = tools.snapshot().customTools[0]!;
  const pending = tool.execute("map", {}, undefined, undefined, {} as never);
  const panel = context.piPluginUi.snapshot();
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  finish([]);
  await expect(pending).resolves.toMatchObject({ details: { nodes: [] } });
  await expect(panel).resolves.toMatchObject([{ data: { nodes: [] } }]);
  const stale = tool.execute("stale", {}, undefined, undefined, {} as never);
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  manager.newSession();
  finish([]);
  await expect(stale).rejects.toThrow(/context changed/i);
  const abort = new AbortController();
  const cancelled = tool.execute("map", {}, abort.signal, undefined, {} as never);
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  abort.abort();
  finish([]);
  await expect(cancelled).rejects.toThrow(/cancel/i);
});

test("maps real persisted native forks without modifying journals and reports truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "synapse-native-"));
  const manager = SessionManager.create(root, join(root, "sessions"));
  const context = new Context();
  try {
    manager.appendMessage({ role: "user", content: "根任务", timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const parentFile = manager.getSessionFile()!;
    const parentId = manager.getSessionId();
    manager.createBranchedSession(manager.getLeafId()!);
    const childFile = manager.getSessionFile()!;
    const childId = manager.getSessionId();
    const before = await Promise.all([readFile(parentFile), readFile(childFile)]);
    const tools = new PiToolRegistry();
    provideLaunchContext(context, { cwd: "/wrong-launch", agentDir: root, args: [], requestExit() {} });
    context.provide("piSession", { manager } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(synapsePlugin, { maxSessions: 1 });
    const result = await tools.snapshot().customTools[0]!.execute("map", {}, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ cwd: root, total: 2, truncated: true, nodes: [expect.anything()] });
    const graph = buildSynapseGraph(await SessionManager.list(root, manager.getSessionDir()), childFile);
    expect(graph).toMatchObject({ activeSessionId: childId, edges: [{ from: parentId, to: childId, kind: "fork" }] });
    expect(await Promise.all([readFile(parentFile), readFile(childFile)])).toEqual(before);
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an unavailable session directory instead of a successful empty map", async () => {
  const root = await mkdtemp(join(tmpdir(), "synapse-unavailable-"));
  const directory = join(root, "sessions");
  const manager = SessionManager.create(root, directory);
  const context = new Context();
  const tools = new PiToolRegistry();
  try {
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piSession", { manager } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(synapsePlugin, {});
    await rename(directory, directory + "-saved");
    await writeFile(directory, "not a session directory");
    const tool = tools.snapshot().customTools[0]!;
    await expect(tool.execute("unavailable", {}, undefined, undefined, {} as never)).rejects.toThrow(/ENOTDIR|directory/iu);
    expect(await readFile(directory, "utf8")).toBe("not a session directory");
    await rm(directory);
    await rename(directory + "-saved", directory);
    await expect(tool.execute("recovered", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { total: 0, nodes: [] } });
    await rename(directory, directory + "-saved");
    await expect(tool.execute("not-created-yet", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { total: 0, nodes: [] } });
    await rename(directory + "-saved", directory);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const mode = (await stat(directory)).mode & 0o777;
      await chmod(directory, 0o000);
      try {
        await expect(tool.execute("unreadable", {}, undefined, undefined, {} as never)).rejects.toThrow(/EACCES|permission/iu);
      } finally {
        await chmod(directory, mode);
      }
      await expect(tool.execute("readable-again", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { total: 0 } });
    }
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
