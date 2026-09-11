import { mkdtemp, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import taskboardPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-taskboard-"));
  roots.push(root);
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(taskboardPlugin, { fileName: "tasks.sqlite", keyPrefix: "TST" });
  contexts.push(context);
  const find = (name: string) => {
    const tool = tools.snapshot().customTools.find((item) => item.name === name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  };
  return {
    root,
    context,
    tools,
    panels,
    create: find("taskboard_create"),
    list: find("taskboard_list"),
    update: find("taskboard_update"),
    accept: find("taskboard_accept"),
  };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("taskboard", () => {
  test("creates, updates, lists, and accepts a review task", async () => {
    const { create, list, update, accept, panels } = await fixture();
    for (const tool of [create, list, update, accept]) {
      expect(tool.executionMode).toBe("sequential");
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
    const created = await create.execute(
      "create",
      { title: "Ship feature", description: "Review and release", priority: "high" },
      undefined,
      undefined,
      {} as never,
    );
    expect(created.details).toMatchObject({ key: "TST-1", status: "backlog", priority: "high" });
    await expect(update.execute("update", { key: "TST-1", status: "in_review" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { key: "TST-1", status: "in_review" },
    });
    await expect(accept.execute("accept", { key: "TST-1", confirm: false }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    await expect(accept.execute("accept", { key: "TST-1", confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { key: "TST-1", status: "done" },
    });
    await expect(list.execute("list", { status: "done" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { total: 1 } });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { total: 1, counts: { done: 1 } } }]);
  });

  test("cleans up all registrations on disposal", async () => {
    const { context, tools, panels } = await fixture();
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
});

test("isolates tasks by the active native workspace", async () => {
  const { context, create, list } = await fixture();
  const runtime = { session: { sessionManager: SessionManager.inMemory("/active-one") } };
  context.provide("piRuntime", runtime as never);
  const task = await create.execute("one", { title: "工作区一" }, undefined, undefined, {} as never);
  expect(task.details).toMatchObject({ workspace: "/active-one" });
  runtime.session.sessionManager = SessionManager.inMemory("/active-two");
  expect((await list.execute("two", {}, undefined, undefined, {} as never)).details).toMatchObject({ total: 0 });
});

test("rejects impossible dates, invalid parameters and cancellation before creating storage", async () => {
  const { root, create, list } = await fixture();
  await expect(create.execute("date", { title: "Bad date", dueDate: "2026-02-30" }, undefined, undefined, {} as never)).rejects.toThrow(/dueDate/);
  await expect(create.execute("extra", { title: "Extra", extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/parameter/i);
  await expect(list.execute("limit", { limit: NaN }, undefined, undefined, {} as never)).rejects.toThrow(/limit/);
  const abort = new AbortController();
  abort.abort();
  await expect(create.execute("cancel", { title: "Cancelled" }, abort.signal, undefined, {} as never)).rejects.toThrow(/cancel/i);
  await expect(lstat(join(root, "tasks.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("persists dependencies, rejects cycles and gates acceptance on completed prerequisites", async () => {
  const { create, update, accept, list } = await fixture();
  await create.execute("a", { title: "Prerequisite" }, undefined, undefined, {} as never);
  await create.execute("b", { title: "Dependent", dependsOn: ["TST-1"] }, undefined, undefined, {} as never);
  await expect(update.execute("cycle", { key: "TST-1", dependsOn: ["TST-2"] }, undefined, undefined, {} as never)).rejects.toThrow(/cycle/i);
  await update.execute("review", { key: "TST-2", status: "in_review" }, undefined, undefined, {} as never);
  await expect(accept.execute("early", { key: "TST-2", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(/prerequisite/i);
  await update.execute("review-a", { key: "TST-1", status: "in_review" }, undefined, undefined, {} as never);
  await accept.execute("accept-a", { key: "TST-1", confirm: true }, undefined, undefined, {} as never);
  await accept.execute("accept-b", { key: "TST-2", confirm: true }, undefined, undefined, {} as never);
  expect((await list.execute("list", { status: "done" }, undefined, undefined, {} as never)).details).toMatchObject({
    total: 2,
    tasks: expect.arrayContaining([expect.objectContaining({ key: "TST-2", dependsOn: ["TST-1"] })]) as unknown,
  });
});

test("rolls back invalid dependency writes and preserves workspace isolation in queued operations", async () => {
  const { context, create, list, update } = await fixture();
  await expect(create.execute("bad", { title: "Must rollback", dependsOn: ["TST-99"] }, undefined, undefined, {} as never)).rejects.toThrow(
    /prerequisite not found/,
  );
  expect((await list.execute("empty", {}, undefined, undefined, {} as never)).details).toMatchObject({ total: 0 });
  await create.execute("first", { title: "First" }, undefined, undefined, {} as never);
  await create.execute("second", { title: "Second", dependsOn: ["TST-1"] }, undefined, undefined, {} as never);
  await update.execute("clear", { key: "TST-2", dependsOn: [] }, undefined, undefined, {} as never);
  const limited = await list.execute("limit", { limit: 1 }, undefined, undefined, {} as never);
  expect(limited.details).toMatchObject({ total: 2, truncated: true, tasks: [expect.anything()] });
  expect(JSON.parse((limited.content[0] as { text: string }).text)).toEqual(limited.details);
  const runtime = { session: { sessionManager: SessionManager.inMemory("/new-workspace") } };
  context.provide("piRuntime", runtime as never);
  await expect(create.execute("cross", { title: "Cross", dependsOn: ["TST-1"] }, undefined, undefined, {} as never)).rejects.toThrow(/this workspace/);
  const pending = create.execute("stale", { title: "Stale" }, undefined, undefined, {} as never);
  runtime.session.sessionManager = SessionManager.inMemory("/other-workspace");
  await expect(pending).rejects.toThrow(/context changed/);
});

test.each(["ABORT", "ROLLBACK"])("preserves the original SQLite %s failure, rolls back fields and dependencies, and recovers", async (mode) => {
  const { root, create, list, update, panels } = await fixture();
  await create.execute("a", { title: "Prerequisite" }, undefined, undefined, {} as never);
  await create.execute("b", { title: "Dependent", dependsOn: ["TST-1"] }, undefined, undefined, {} as never);
  const before = (await list.execute("before", {}, undefined, undefined, {} as never)).details;
  const panelBefore = (await panels.snapshot())[0]!.data;
  const database = new DatabaseSync(join(root, "tasks.sqlite"));
  try {
    database.exec(`CREATE TRIGGER owned_write_failure BEFORE DELETE ON task_dependencies BEGIN SELECT RAISE(${mode}, 'Owned SQLite write failure'); END`);
    await expect(update.execute("fail", { key: "TST-2", title: "Must roll back", dependsOn: [] }, undefined, undefined, {} as never)).rejects.toThrow(
      "Owned SQLite write failure",
    );
    expect((await list.execute("after", {}, undefined, undefined, {} as never)).details).toEqual(before);
    expect((await panels.snapshot())[0]!.data).toEqual(panelBefore);
    database.exec("DROP TRIGGER owned_write_failure");
    await expect(update.execute("recover", { key: "TST-2", title: "Recovered", dependsOn: [] }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { title: "Recovered", dependsOn: [], version: 2 },
    });
  } finally {
    database.close();
  }
});
