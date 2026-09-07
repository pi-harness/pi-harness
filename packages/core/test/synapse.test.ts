import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import synapsePlugin, { buildSynapseGraph } from "../src/plugins/synapse.js";
import { provideLaunchContext, PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

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
    context.provide("piSession", { manager: { getSessionDir: () => "/agent/sessions", getSessionFile: () => "/root.jsonl" } } as never);
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
    context.provide("piSession", { manager: { getSessionDir: () => "/agent/sessions", getSessionFile: () => "/root.jsonl" } } as never);
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
    context.provide("piSession", { manager: { getSessionDir: () => "/agent/sessions", getSessionFile: () => "/root.jsonl" } } as never);
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
