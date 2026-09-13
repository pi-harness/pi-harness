import { describe, expect, test } from "vitest";
import { taskboardPanelView } from "../src/taskboard-view.js";

const counts = { backlog: 0, todo: 1, in_progress: 0, in_review: 0, blocked: 0, canceled: 0, done: 0 };
const task = {
  id: "task-1",
  key: "OPS-1",
  workspace: "/workspace",
  title: "Investigate order",
  description: "Check inventory and refund state",
  status: "todo",
  priority: "high",
  dueDate: "2026-09-30",
  createdAt: "2026-09-12T03:00:00.000Z",
  updatedAt: "2026-09-12T03:00:01.000Z",
  version: 2,
  dependsOn: [],
};
const report = { workspace: "/workspace", total: 1, counts, recent: [task] };

describe("Taskboard panel view", () => {
  test("normalizes the complete backend contract into detached data", () => {
    const view = taskboardPanelView(report);
    expect(view).toEqual({ ...report, malformed: false });
    expect(view).not.toBe(report);
    expect(view.counts).not.toBe(counts);
    expect(view.recent).not.toBe(report.recent);
    expect(view.recent[0]).not.toBe(task);
  });

  test("accepts resolved workspace paths whose names end in whitespace", () => {
    const workspace = "/workspace/order operations ";
    expect(
      taskboardPanelView({
        ...report,
        workspace,
        recent: [{ ...task, workspace }],
      }),
    ).toMatchObject({ workspace, malformed: false });
  });

  test("retains a bounded write failure alongside the last valid board", () => {
    expect(taskboardPanelView({ ...report, lastError: "attempt to write a readonly database" })).toMatchObject({
      malformed: false,
      total: 1,
      lastError: "attempt to write a readonly database",
    });
    expect(taskboardPanelView({ ...report, lastError: "x".repeat(2_001) }).malformed).toBe(true);
  });

  test("compares canonical timestamps chronologically across expanded years", () => {
    expect(
      taskboardPanelView({
        ...report,
        recent: [{ ...task, createdAt: "9999-12-31T23:59:59.999Z", updatedAt: "+010000-01-01T00:00:00.000Z" }],
      }),
    ).toMatchObject({ malformed: false });
  });

  test("fails closed for contradictory totals, invalid tasks, duplicates, and oversized inventories", () => {
    const malformed = [
      null,
      { ...report, total: 2 },
      { ...report, workspace: "   ", recent: [{ ...task, workspace: "   " }] },
      { ...report, counts: { ...counts, todo: -1 } },
      { ...report, recent: [] },
      { ...report, recent: [{ ...task, workspace: "/other" }] },
      { ...report, recent: [{ ...task, updatedAt: "not-a-date" }] },
      { ...report, recent: [{ ...task, dueDate: "2026-02-30" }] },
      { ...report, recent: [{ ...task, dependsOn: ["OPS-1"] }] },
      { ...report, counts: { ...counts, todo: 0, done: 1 }, recent: [task] },
      { ...report, total: 2, counts: { ...counts, todo: 2 }, recent: [task, task] },
      {
        ...report,
        total: 9,
        counts: { ...counts, todo: 9 },
        recent: Array.from({ length: 9 }, (_, index) => ({ ...task, id: `task-${index}`, key: `OPS-${index + 1}` })),
      },
    ];
    for (const value of malformed) expect(taskboardPanelView(value)).toMatchObject({ malformed: true, total: 0, recent: [] });
  });

  test("rejects recent tasks that do not follow the backend ordering contract", () => {
    const older = { ...task, id: "task-older", key: "OPS-2", updatedAt: "2026-09-12T03:00:01.000Z" };
    const newer = { ...task, id: "task-newer", key: "OPS-3", updatedAt: "2026-09-12T03:00:02.000Z" };
    expect(
      taskboardPanelView({
        ...report,
        total: 2,
        counts: { ...counts, todo: 2 },
        recent: [older, newer],
      }),
    ).toMatchObject({ malformed: true });
  });

  test("does not invoke accessors or revoked proxies", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "workspace", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "/workspace";
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [accessor, revoked.proxy]) {
      expect(() => taskboardPanelView(value)).not.toThrow();
      expect(taskboardPanelView(value).malformed).toBe(true);
    }
    expect(getterCalls).toBe(0);
  });
});
