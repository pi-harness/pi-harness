import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import synapsePlugin, { buildSynapseGraph } from "../src/plugins/synapse.js";
import { provideLaunchContext, PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];

afterEach(async () => {
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
    vi.spyOn(SessionManager, "list").mockResolvedValue([
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
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { nodes: [{ id: "root" }], refreshes: 2 } }]);
  });
});
