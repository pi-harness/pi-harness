import { Context } from "@deepseek-ai/cordis";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import agentTeamsPlugin, { dependencyCycle, readyTeamTasks } from "../src/plugins/agent-teams.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function createPlugin(manager = SessionManager.inMemory()): Promise<{
  context: Context;
  manager: SessionManager;
  panels: PiPluginUiRegistry;
  tool: ToolDefinition;
}> {
  const context = new Context();
  contexts.push(context);
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piSession", { manager });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(agentTeamsPlugin);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "team_task");
  if (tool === undefined) throw new Error("team_task was not registered");
  return { context, manager, panels, tool };
}

function persistedState(title: string, taskCount = 1, memberCount = 1, messageCount = 0) {
  const members = Array.from({ length: memberCount }, (_, index) => ({
    id: `member-${index + 1}`,
    name: `Member ${index + 1}`,
    role: "Builder",
    status: "idle",
  }));
  return {
    members,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `task-${index + 1}`,
      title: index === 0 ? title : `Task ${index + 1}`,
      assignee: members[0]?.id ?? "unassigned",
      status: "todo",
      dependsOn: [] as string[],
    })),
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: `message-${index + 1}`,
      from: members[0]?.id,
      to: members[0]?.id,
      body: `Message ${index + 1}`,
      timestamp: new Date(index).toISOString(),
      read: index % 2 === 0,
    })),
  };
}

describe("agent teams dependency graph", () => {
  test("finds a cycle and returns its task ids", () => {
    const tasks = [
      { id: "plan", title: "Plan", assignee: "planner", status: "todo", dependsOn: ["review"] },
      { id: "build", title: "Build", assignee: "builder", status: "todo", dependsOn: ["plan"] },
      { id: "review", title: "Review", assignee: "reviewer", status: "todo", dependsOn: ["build"] },
    ];

    expect(dependencyCycle(tasks)).toEqual(["plan", "review", "build", "plan"]);
  });

  test("returns only tasks whose dependencies are complete", () => {
    const tasks = [
      { id: "plan", title: "Plan", assignee: "planner", status: "done", dependsOn: [] },
      { id: "build", title: "Build", assignee: "builder", status: "todo", dependsOn: ["plan"] },
      { id: "review", title: "Review", assignee: "reviewer", status: "blocked", dependsOn: ["build"] },
    ];

    expect(readyTeamTasks(tasks).map((task) => task.id)).toEqual(["build"]);
  });
});

describe("agent teams plugin", () => {
  test("rejects unknown configuration before registering surfaces", async () => {
    const context = new Context();
    contexts.push(context);
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    context.provide("piSession", { manager: SessionManager.inMemory() });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);

    await expect(context.plugin(agentTeamsPlugin, { surprise: true })).rejects.toThrow(/unknown.*config/iu);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("restores state from the active session branch rather than a newer abandoned branch", async () => {
    const manager = SessionManager.inMemory();
    const base = manager.appendCustomEntry("pi-harness/agent-teams", persistedState("Base"));
    const active = manager.appendCustomEntry("pi-harness/agent-teams", persistedState("Active branch"));
    manager.branch(base);
    manager.appendCustomEntry("pi-harness/agent-teams", persistedState("Abandoned branch"));
    manager.branch(active);
    const { panels } = await createPlugin(manager);

    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { tasks: [{ title: "Active branch" }] } }]);
  });

  test("restores durable state after more than ten thousand unrelated branch entries", async () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("pi-harness/agent-teams", persistedState("Long-lived board"));
    for (let index = 0; index < 10_001; index += 1) {
      manager.appendMessage({ role: "user", content: `Unrelated turn ${index}`, timestamp: index });
    }

    const { panels } = await createPlugin(manager);

    await expect(panels.snapshot()).resolves.toMatchObject([
      {
        data: {
          tasks: [{ title: "Long-lived board" }],
          history: { available: 10_002, scanned: 10_002, truncated: false, restored: true },
        },
      },
    ]);
  });

  test("rejects accessors, inherited inputs, unknown fields, and invalid action fields without invoking them", async () => {
    const { manager, tool } = await createPlugin();
    let accessed = 0;
    const accessor = Object.defineProperty({ action: "get_state" }, "title", {
      enumerable: true,
      get() {
        accessed += 1;
        return "unsafe";
      },
    });

    await expect(tool.execute("accessor", accessor as never, undefined, undefined, {} as never)).rejects.toThrow(/data properties/iu);
    expect(accessed).toBe(0);
    await expect(tool.execute("prototype", Object.create({ action: "get_state" }) as never, undefined, undefined, {} as never)).rejects.toThrow(
      /plain object/iu,
    );
    await expect(tool.execute("unknown", { action: "get_state", surprise: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
    await expect(tool.execute("irrelevant", { action: "claim_task", title: "ignored" }, undefined, undefined, {} as never)).rejects.toThrow(
      /not valid for claim_task/iu,
    );
    expect(manager.getEntries()).toEqual([]);
  });

  test("rejects malformed scalar and dependency values without coercion or accessor execution", async () => {
    const { manager, tool } = await createPlugin();
    let invoked = 0;
    const action = {
      toString() {
        invoked += 1;
        return "get_state";
      },
    };
    const dependencies: unknown[] = [];
    Object.defineProperty(dependencies, "0", {
      enumerable: true,
      get() {
        invoked += 1;
        return "task-1";
      },
    });

    await expect(tool.execute("action", { action }, undefined, undefined, {} as never)).rejects.toThrow(/unknown team action: object/iu);
    await expect(tool.execute("id", { action: "add_task", id: 42, title: "Invalid" }, undefined, undefined, {} as never)).rejects.toThrow(
      /parameter id must be a string/iu,
    );
    await expect(tool.execute("boolean", { action: "read_messages", to: "reviewer", unreadOnly: "yes" }, undefined, undefined, {} as never)).rejects.toThrow(
      /unreadOnly must be a boolean/iu,
    );
    await expect(tool.execute("sparse", { action: "add_task", title: "Invalid", dependsOn: Array(1) }, undefined, undefined, {} as never)).rejects.toThrow(
      /contain only strings/iu,
    );
    await expect(
      tool.execute("accessor", { action: "add_task", title: "Invalid", dependsOn: dependencies }, undefined, undefined, {} as never),
    ).rejects.toThrow(/plain array of data properties/iu);
    expect(invoked).toBe(0);
    expect(manager.getEntries()).toEqual([]);
  });

  test("honors caller cancellation before reading or mutating state", async () => {
    const { manager, tool } = await createPlugin();
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await expect(tool.execute("cancelled", { action: "add_task", title: "Must not persist" }, controller.signal, undefined, {} as never)).rejects.toThrow(
      /cancelled/iu,
    );
    expect(manager.getEntries()).toEqual([]);
  });

  test("queries the durable task board without writing another snapshot", async () => {
    const { manager, tool } = await createPlugin();
    await tool.execute("create", { action: "add_task", title: "Production verification" }, undefined, undefined, {} as never);
    const before = manager.getEntries().length;

    const result = await tool.execute("state", { action: "get_state" }, undefined, undefined, {} as never);
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Production verification");
    expect(result.details).toMatchObject({
      kind: "state",
      tasks: [{ title: "Production verification", status: "todo" }],
      readyTasks: ["task-1"],
    });
    expect(manager.getEntries()).toHaveLength(before);
  });

  test("removes completed leaf tasks and read messages only after explicit confirmation", async () => {
    const { manager, tool } = await createPlugin();
    await tool.execute("task", { action: "add_task", title: "Disposable", assignee: "builder" }, undefined, undefined, {} as never);
    await tool.execute("done", { action: "update_task", id: "task-1", status: "done" }, undefined, undefined, {} as never);
    await tool.execute("message", { action: "send_message", from: "builder", to: "reviewer", body: "Reviewed" }, undefined, undefined, {} as never);
    await tool.execute("read", { action: "read_messages", to: "reviewer" }, undefined, undefined, {} as never);
    const before = manager.getEntries().length;

    await expect(tool.execute("unsafe-remove", { action: "remove_task", id: "task-1" }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    await expect(tool.execute("unsafe-clear", { action: "clear_messages" }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    expect(manager.getEntries()).toHaveLength(before);
    await expect(tool.execute("remove", { action: "remove_task", id: "task-1", confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { kind: "task", removed: { id: "task-1" } },
    });
    await expect(tool.execute("clear", { action: "clear_messages", confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { kind: "mailbox", removed: 1 },
    });
  });

  test("refuses to remove members and completed tasks while durable references remain", async () => {
    const { tool } = await createPlugin();
    await tool.execute("dependency", { action: "add_task", id: "dependency", title: "Dependency", assignee: "builder" }, undefined, undefined, {} as never);
    await tool.execute("done", { action: "update_task", id: "dependency", status: "done" }, undefined, undefined, {} as never);
    await tool.execute("dependent", { action: "add_task", id: "dependent", title: "Dependent", dependsOn: ["dependency"] }, undefined, undefined, {} as never);

    await expect(tool.execute("remove-task", { action: "remove_task", id: "dependency", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
      /another task depends/iu,
    );
    await expect(tool.execute("remove-assignee", { action: "remove_member", id: "builder", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
      /tasks are assigned/iu,
    );

    await tool.execute("mail", { action: "send_message", from: "planner", to: "reviewer", body: "Keep reference" }, undefined, undefined, {} as never);
    await expect(
      tool.execute("remove-recipient", { action: "remove_member", id: "reviewer", confirm: true }, undefined, undefined, {} as never),
    ).rejects.toThrow(/mailbox messages reference/iu);
  });

  test("clears only read mailbox notes and retains every unread note", async () => {
    const { tool } = await createPlugin();
    await tool.execute("review", { action: "send_message", from: "builder", to: "reviewer", body: "Read me" }, undefined, undefined, {} as never);
    await tool.execute("plan", { action: "send_message", from: "builder", to: "planner", body: "Keep unread" }, undefined, undefined, {} as never);
    await tool.execute("read", { action: "read_messages", to: "reviewer", unreadOnly: true }, undefined, undefined, {} as never);

    await expect(tool.execute("clear", { action: "clear_messages", confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { removed: 1, retained: 1 },
    });
    await expect(tool.execute("state", { action: "get_state" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { messages: [{ body: "Keep unread", read: false }], unreadMessages: 1 },
    });
  });

  test("identifies the optional clear-messages filter as a member id", async () => {
    const { tool } = await createPlugin();

    await expect(tool.execute("clear", { action: "clear_messages", id: "bad id", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
      /team member id/iu,
    );
  });

  test("does not expose mutable references to persisted state in tool or panel results", async () => {
    const { panels, tool } = await createPlugin();
    const result = await tool.execute("create", { action: "add_task", title: "Original" }, undefined, undefined, {} as never);
    const item = (result.details as { item: { title: string } }).item;
    item.title = "Mutated result";
    const [firstPanel] = await panels.snapshot();
    if (firstPanel === undefined) throw new Error("agent-teams-panel was not registered");
    (firstPanel.data as { tasks: Array<{ title: string }> }).tasks[0]!.title = "Mutated panel";

    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { tasks: [{ title: "Original" }] } }]);
  });

  test("publishes bounded panel inventories with complete counts", async () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("pi-harness/agent-teams", persistedState("First", 30, 20, 10));
    const { panels } = await createPlugin(manager);
    const [panel] = await panels.snapshot();
    if (panel === undefined) throw new Error("agent-teams-panel was not registered");
    const data = panel.data as {
      members: unknown[];
      tasks: unknown[];
      messages: unknown[];
      inventory: { members: { total: number }; tasks: { total: number; ready: number }; messages: { total: number; unread: number } };
    };

    expect(data.members).toHaveLength(12);
    expect(data.tasks).toHaveLength(20);
    expect(data.messages).toHaveLength(5);
    expect(data.inventory).toEqual({
      members: { total: 20, shown: 12, truncated: true },
      tasks: { total: 30, shown: 20, ready: 30, truncated: true },
      messages: { total: 10, shown: 5, unread: 5, truncated: true },
    });
  });

  test("returns bounded mailbox bodies to the Agent and marks only the returned batch as read", async () => {
    const manager = SessionManager.inMemory();
    const state = persistedState("Mailbox", 0, 1, 55);
    for (const message of state.messages) message.read = false;
    manager.appendCustomEntry("pi-harness/agent-teams", state);
    const { tool } = await createPlugin(manager);

    const result = await tool.execute("read", { action: "read_messages", to: "member-1", unreadOnly: true }, undefined, undefined, {} as never);
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Message 2");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("30 more matching messages remain unread");
    expect((result.details as { messages: unknown[] }).messages).toHaveLength(25);
    const current = await tool.execute("state", { action: "get_state" }, undefined, undefined, {} as never);
    expect(current.details).toMatchObject({ unreadMessages: 30 });
  });

  test("persists growing mailboxes with linear-size journal entries", async () => {
    const { manager, tool } = await createPlugin();
    const body = "x".repeat(4_000);

    for (let index = 0; index < 50; index += 1) {
      await tool.execute(`message-${index}`, { action: "send_message", from: "builder", to: "reviewer", body }, undefined, undefined, {} as never);
    }

    const persistedBytes = manager
      .getEntries()
      .reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.type === "custom" ? entry.data : null), "utf8"), 0);
    expect(persistedBytes).toBeLessThan(500_000);
    const result = await tool.execute("state", { action: "get_state" }, undefined, undefined, {} as never);
    const details = result.details as { messages: Array<{ id: string; body: string }>; unreadMessages: number };
    expect(details.messages).toHaveLength(50);
    expect(details.messages.at(-1)).toMatchObject({ id: "message-50", body });
    expect(details.unreadMessages).toBe(50);
  });

  test("rejects an invalid journal delta atomically instead of partially applying it", async () => {
    const { manager, panels, tool } = await createPlugin();
    await tool.execute("task", { action: "add_task", id: "task-1", title: "Keep me" }, undefined, undefined, {} as never);
    manager.appendCustomEntry("pi-harness/agent-teams", {
      journalVersion: 1,
      kind: "delta",
      baseRevision: 1,
      revision: 2,
      changes: {
        tasks: {
          remove: ["task-1"],
          upsert: [{ id: "task-2", title: 42, assignee: "unassigned", status: "todo", dependsOn: [] }],
        },
      },
    });

    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { tasks: [{ id: "task-1", title: "Keep me" }] } }]);
    await tool.execute("recover", { action: "update_task", id: "task-1", title: "Recovered after corruption" }, undefined, undefined, {} as never);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { tasks: [{ id: "task-1", title: "Recovered after corruption" }] } }]);
  });

  test("rejects an invalid journal checkpoint and falls back to the previous valid state", async () => {
    const { manager, panels, tool } = await createPlugin();
    await tool.execute("task", { action: "add_task", id: "task-1", title: "Valid checkpoint" }, undefined, undefined, {} as never);
    manager.appendCustomEntry("pi-harness/agent-teams", {
      journalVersion: 1,
      kind: "checkpoint",
      revision: 2,
      state: {
        members: [{ id: "planner", name: "Planner", role: "Planning", status: "idle" }],
        tasks: [{ id: "task-2", title: 42, assignee: "planner", status: "todo", dependsOn: [] }],
        messages: [],
      },
    });

    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { tasks: [{ id: "task-1", title: "Valid checkpoint" }] } }]);
  });

  test("periodically checkpoints the delta journal and restores it in a fresh plugin instance", async () => {
    const manager = SessionManager.inMemory();
    const first = await createPlugin(manager);
    await first.tool.execute("task", { action: "add_task", id: "task-1", title: "Revision seed" }, undefined, undefined, {} as never);
    for (let index = 0; index < 512; index += 1) {
      await first.tool.execute(`update-${index}`, { action: "update_task", id: "task-1", title: `Revision ${index}` }, undefined, undefined, {} as never);
    }

    const checkpointRevisions = manager.getEntries().flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== "pi-harness/agent-teams" || entry.data === null || typeof entry.data !== "object") return [];
      const data = entry.data as { kind?: unknown; revision?: unknown };
      return data.kind === "checkpoint" && typeof data.revision === "number" ? [data.revision] : [];
    });
    expect(checkpointRevisions).toEqual([1, 513]);

    const reopened = await createPlugin(manager);
    await expect(reopened.tool.execute("state", { action: "get_state" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tasks: [{ id: "task-1", title: "Revision 511" }] },
    });
  }, 60_000);

  test("rejects a mutation when the combined persisted state exceeds eight MiB", async () => {
    const manager = SessionManager.inMemory();
    const taskIds = Array.from({ length: 256 }, (_, index) => `t${String(index).padStart(63, "0")}`);
    const state = {
      members: [{ id: "member-1", name: "Member", role: "Builder", status: "idle" }],
      tasks: taskIds.map((id) => ({
        id,
        title: "t".repeat(200),
        assignee: "member-1",
        status: "todo",
        dependsOn: taskIds,
      })),
      messages: Array.from({ length: 1_000 }, (_, index) => ({
        id: `m${String(index).padStart(63, "0")}`,
        from: "member-1",
        to: "member-1",
        body: "m".repeat(4_000),
        timestamp: new Date(0).toISOString(),
        read: false,
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeGreaterThan(8 * 1024 * 1024);
    manager.appendCustomEntry("pi-harness/agent-teams", state);
    const { tool } = await createPlugin(manager);

    await expect(
      tool.execute("update", { action: "update_task", id: taskIds[0], title: "Still too large" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/8388608-byte persistence limit/iu);
    expect(manager.getEntries()).toHaveLength(1);
  });

  test("does not steal a ready task already assigned to another member", async () => {
    const manager = SessionManager.inMemory();
    const state = persistedState("Reviewer task", 1, 2);
    state.tasks[0]!.assignee = "member-2";
    manager.appendCustomEntry("pi-harness/agent-teams", state);
    const { tool } = await createPlugin(manager);

    await expect(tool.execute("claim", { action: "claim_task", assignee: "member-1" }, undefined, undefined, {} as never)).rejects.toThrow(
      /no ready.*available.*member-1/iu,
    );
    await expect(tool.execute("state", { action: "get_state" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { tasks: [{ assignee: "member-2", status: "todo" }] },
    });
  });

  test("bounds Agent-facing state text even when task dependency metadata is large", async () => {
    const manager = SessionManager.inMemory();
    const state = persistedState("x".repeat(200), 256, 1);
    const dependencyIds = state.tasks.slice(0, 200).map((task) => task.id);
    for (const task of state.tasks) task.dependsOn = dependencyIds;
    manager.appendCustomEntry("pi-harness/agent-teams", state);
    const { tool } = await createPlugin(manager);

    const result = await tool.execute("state", { action: "get_state" }, undefined, undefined, {} as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(text).toContain("more tasks omitted");
  });

  test("rejects stale tool calls after plugin disposal", async () => {
    const { context, manager, tool } = await createPlugin();
    await context.fiber.dispose();

    await expect(tool.execute("stale", { action: "add_task", title: "Too late" }, undefined, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
    expect(manager.getEntries()).toEqual([]);
  });

  test("does not invoke accessors embedded in persisted collaboration state", async () => {
    const manager = SessionManager.inMemory();
    let accessed = 0;
    const member = Object.defineProperty({ name: "Unsafe", role: "Unsafe", status: "idle" }, "id", {
      enumerable: true,
      get() {
        accessed += 1;
        return "unsafe";
      },
    });
    manager.appendCustomEntry("pi-harness/agent-teams", { members: [member], tasks: [], messages: [] });
    const { panels } = await createPlugin(manager);

    const [panel] = await panels.snapshot();
    if (panel === undefined) throw new Error("agent-teams-panel was not registered");
    expect((panel.data as { members: Array<{ id: string }> }).members[0]?.id).toBe("planner");
    expect(accessed).toBe(0);
  });

  test("does not invoke array element accessors embedded in persisted collaboration state", async () => {
    const manager = SessionManager.inMemory();
    let accessed = 0;
    const members: unknown[] = [];
    Object.defineProperty(members, "0", {
      configurable: true,
      enumerable: true,
      get() {
        accessed += 1;
        return { id: "unsafe", name: "Unsafe", role: "Unsafe", status: "idle" };
      },
    });
    manager.appendCustomEntry("pi-harness/agent-teams", { members, tasks: [], messages: [] });
    const { panels } = await createPlugin(manager);

    const [panel] = await panels.snapshot();
    if (panel === undefined) throw new Error("agent-teams-panel was not registered");
    expect((panel.data as { members: Array<{ id: string }> }).members[0]?.id).toBe("planner");
    expect(accessed).toBe(0);
  });

  test("falls back to an older valid snapshot when the newest snapshot contains unsafe arrays", async () => {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("pi-harness/agent-teams", persistedState("Safe snapshot"));
    const members: unknown[] = [];
    Object.defineProperty(members, "0", { enumerable: true, get: () => ({ id: "unsafe", name: "Unsafe" }) });
    manager.appendCustomEntry("pi-harness/agent-teams", { members, tasks: [], messages: [] });
    const { panels } = await createPlugin(manager);

    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { tasks: [{ title: "Safe snapshot" }] } }]);
  });
});
