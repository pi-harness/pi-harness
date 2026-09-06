import { describe, expect, test } from "vitest";
import { agentTeamsPanelView } from "../src/agent-teams-view.js";

describe("Agent Teams panel view", () => {
  test("normalizes a complete bounded collaboration-ledger payload", () => {
    expect(
      agentTeamsPanelView({
        members: [{ id: "builder", name: "Builder", role: "Implementation", status: "working" }],
        tasks: [{ id: "task-1", title: "Ship", assignee: "builder", status: "in_progress", dependsOn: [] }],
        messages: [{ id: "message-1", from: "reviewer", to: "builder", body: "Check edge cases", timestamp: "2026-09-06T00:00:00.000Z", read: false }],
        readyTasks: [],
        dependencyCycle: null,
        inventory: {
          members: { total: 3, shown: 1, truncated: true },
          tasks: { total: 25, shown: 1, ready: 25, truncated: true },
          messages: { total: 40, shown: 1, unread: 7, truncated: true },
        },
        history: { available: 200, scanned: 4, truncated: false, restored: true },
        limits: {
          members: 64,
          tasks: 256,
          messages: 1_000,
          messageCharacters: 4_000,
          mailboxReadMessages: 25,
          agentTextBytes: 32_768,
          stateBytes: 8_388_608,
          stateScanEntries: 10_000,
          panelMembers: 12,
          panelTasks: 20,
          panelMessages: 5,
        },
      }),
    ).toEqual({
      members: [{ id: "builder", name: "Builder", role: "Implementation", status: "working" }],
      tasks: [{ id: "task-1", title: "Ship", assignee: "builder", status: "in_progress", dependsOn: [] }],
      messages: [{ id: "message-1", from: "reviewer", to: "builder", body: "Check edge cases", timestamp: "2026-09-06T00:00:00.000Z", read: false }],
      readyTasks: [],
      dependencyCycle: null,
      inventory: {
        members: { total: 3, shown: 1, truncated: true },
        tasks: { total: 25, shown: 1, ready: 25, truncated: true },
        messages: { total: 40, shown: 1, unread: 7, truncated: true },
      },
      history: { available: 200, scanned: 4, truncated: false, restored: true },
      limits: {
        members: 64,
        tasks: 256,
        messages: 1_000,
        messageCharacters: 4_000,
        mailboxReadMessages: 25,
        agentTextBytes: 32_768,
        stateBytes: 8_388_608,
        stateScanEntries: 10_000,
        panelMembers: 12,
        panelTasks: 20,
        panelMessages: 5,
      },
      truncated: false,
    });
  });

  test("applies fixed browser limits and drops malformed hostile entries", () => {
    const members = Array.from({ length: 20 }, (_, index) => ({
      id: index === 0 ? "bad member" : `member-${index}`,
      name: "n".repeat(500),
      role: "r".repeat(500),
      status: index === 1 ? "working" : "unknown",
    }));
    const tasks = Array.from({ length: 30 }, (_, index) => ({
      id: `task-${index}`,
      title: "t".repeat(500),
      assignee: "member-1",
      status: index === 0 ? "done" : "unknown",
      dependsOn: Array.from({ length: 300 }, (_, dependency) => `task-${dependency}`),
    }));
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: `message-${index}`,
      from: "member-1",
      to: "member-2",
      body: "b".repeat(8_000),
      timestamp: index === 0 ? "invalid" : "2026-09-06T00:00:00.000Z",
      read: false,
    }));

    const view = agentTeamsPanelView({
      members,
      tasks,
      messages,
      readyTasks: Array.from({ length: 100 }, (_, index) => `task-${index}`),
      dependencyCycle: Array.from({ length: 100 }, (_, index) => `task-${index}`),
      inventory: {
        members: { total: Number.POSITIVE_INFINITY, shown: -1 },
        tasks: { total: 1, shown: 999, ready: 999 },
        messages: { total: 1, shown: 999, unread: 999 },
      },
      history: { available: Number.NaN, scanned: 99_999, restored: "yes" },
      limits: { members: 999, tasks: 999, messages: 999_999, panelMembers: 999, panelTasks: 999, panelMessages: 999 },
    });

    expect(view.members).toHaveLength(11);
    expect(view.members[0]).toEqual({ id: "member-1", name: "n".repeat(200), role: "r".repeat(200), status: "working" });
    expect(view.tasks).toHaveLength(20);
    expect(view.tasks[0]).toMatchObject({ title: "t".repeat(200), status: "done" });
    expect(view.tasks[0]?.dependsOn).toHaveLength(20);
    expect(view.messages).toHaveLength(4);
    expect(view.messages[0]?.body).toBe("b".repeat(4_000));
    expect(view.readyTasks).toHaveLength(20);
    expect(view.dependencyCycle).toHaveLength(20);
    expect(view.inventory).toEqual({
      members: { total: 11, shown: 11, truncated: true },
      tasks: { total: 20, shown: 20, ready: 20, truncated: true },
      messages: { total: 4, shown: 4, unread: 4, truncated: true },
    });
    expect(view.history).toEqual({ available: 0, scanned: 0, truncated: false, restored: false });
    expect(view.limits).toMatchObject({ members: 64, tasks: 256, messages: 1_000, panelMembers: 12, panelTasks: 20, panelMessages: 5 });
    expect(view.truncated).toBe(true);
  });

  test("preserves a valid deep recovery scan beyond the recent-history window", () => {
    const view = agentTeamsPanelView({
      history: { available: 10_002, scanned: 10_002, truncated: false, restored: true },
    });

    expect(view.history).toEqual({ available: 10_002, scanned: 10_002, truncated: false, restored: true });
  });

  test("tracks browser-side truncation independently for each inventory", () => {
    const view = agentTeamsPanelView({
      members: [{ id: "builder", name: "Builder", role: "Implementation", status: "idle" }],
      tasks: [{ id: "task-1", title: "Ship", assignee: "builder", status: "todo", dependsOn: [] }],
      messages: [{ id: "message-1", from: "builder", to: "builder", body: "Broken timestamp", timestamp: "invalid", read: false }],
      readyTasks: ["task-1"],
      dependencyCycle: null,
      inventory: {
        members: { total: 1, shown: 1, truncated: false },
        tasks: { total: 1, shown: 1, ready: 1, truncated: false },
        messages: { total: 1, shown: 1, unread: 1, truncated: false },
      },
    });

    expect(view.inventory).toEqual({
      members: { total: 1, shown: 1, truncated: false },
      tasks: { total: 1, shown: 1, ready: 1, truncated: false },
      messages: { total: 1, shown: 0, unread: 1, truncated: true },
    });
    expect(view.truncated).toBe(true);
  });

  test("reports malformed collection and task-metadata containers as truncated", () => {
    const view = agentTeamsPanelView({
      members: {},
      tasks: "invalid",
      messages: 42,
      readyTasks: {},
      dependencyCycle: "invalid",
    });

    expect(view.members).toEqual([]);
    expect(view.tasks).toEqual([]);
    expect(view.messages).toEqual([]);
    expect(view.readyTasks).toEqual([]);
    expect(view.dependencyCycle).toBeNull();
    expect(view.inventory).toEqual({
      members: { total: 0, shown: 0, truncated: true },
      tasks: { total: 0, shown: 0, ready: 0, truncated: true },
      messages: { total: 0, shown: 0, unread: 0, truncated: true },
    });
    expect(view.truncated).toBe(true);
  });

  test("tracks dependency truncation against the original task after malformed tasks are dropped", () => {
    const view = agentTeamsPanelView({
      members: [{ id: "builder", name: "Builder", role: "Implementation", status: "idle" }],
      tasks: [
        { id: "bad task", title: "Drop", assignee: "builder", status: "todo", dependsOn: [] },
        {
          id: "task-1",
          title: "Keep",
          assignee: "builder",
          status: "todo",
          dependsOn: Array.from({ length: 21 }, (_, index) => `dependency-${index}`),
        },
      ],
      messages: [],
      readyTasks: [],
      dependencyCycle: null,
      inventory: {
        members: { total: 1, shown: 1, truncated: false },
        tasks: { total: 2, shown: 2, ready: 0, truncated: false },
        messages: { total: 0, shown: 0, unread: 0, truncated: false },
      },
    });

    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0]?.dependsOn).toHaveLength(20);
    expect(view.inventory.tasks).toEqual({ total: 2, shown: 1, ready: 0, truncated: true });
  });
});
