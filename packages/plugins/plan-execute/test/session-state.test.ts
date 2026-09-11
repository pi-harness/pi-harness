import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import plugin from "../src/index.js";

const contexts: Context[] = [];
const directories: string[] = [];
const customType = "pi-harness/plan-execute";
const params = { title: "会话计划😀", steps: ["验证", "交付"], dependencies: [{ step: 2, dependsOn: [1] }] };

async function fixture(manager = SessionManager.inMemory("/plan")) {
  const context = new Context();
  contexts.push(context);
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  const runtime = { session: { sessionManager: manager } };
  context.provide("piSession", { manager: SessionManager.inMemory("/stale-launch") });
  context.provide("piRuntime", runtime as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(plugin);
  const call = (name: string, args: unknown = {}) => {
    const tool = tools.snapshot().customTools.find((item) => item.name === name)!;
    return tool.execute("test", args, undefined, undefined, {} as never);
  };
  return { context, runtime, panels, call, manager };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("isolates runtime sessions and restores each plan when returning", async () => {
  const f = await fixture();
  const created = await f.call("plan_create", params);
  const first = f.manager;
  f.runtime.session.sessionManager = SessionManager.inMemory("/other");
  await expect(f.call("plan_get")).rejects.toThrow(/No plan/);
  expect((await f.panels.snapshot())[0]!.data).toMatchObject({ title: null, total: 0, steps: [] });
  await f.call("plan_create", { title: "Other", steps: ["独立"] });
  f.runtime.session.sessionManager = first;
  expect(await f.call("plan_get")).toEqual(created);
  first.newSession();
  await expect(f.call("plan_get")).rejects.toThrow(/No plan/);
});

test.each(["plan_create", "plan_advance", "plan_get"])("rejects a queued %s after the same manager changes session", async (name) => {
  const f = await fixture();
  await f.call("plan_create", params);
  const pending = f.call(name, name === "plan_create" ? params : name === "plan_advance" ? { step: 1, status: "done" } : {});
  f.manager.newSession();
  await expect(pending).rejects.toThrow(/session changed/i);
  expect(f.manager.getEntries()).toEqual([]);
});

test("persists progress across native disk reopen and uses the current branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-state-"));
  directories.push(root);
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Synthetic plan audit" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const f = await fixture(manager);
  const created = await f.call("plan_create", params);
  const initialLeaf = manager.getLeafId()!;
  const advanced = await f.call("plan_advance", { step: 1, status: "done" });
  const reopened = SessionManager.open(manager.getSessionFile()!);
  const next = await fixture(reopened);
  expect(await next.call("plan_get")).toEqual(advanced);
  const before = reopened.getEntries();
  await next.call("plan_get");
  expect(reopened.getEntries()).toEqual(before);
  reopened.branch(initialLeaf);
  expect(await next.call("plan_get")).toEqual(created);
});

test.each(["plan_create", "plan_advance", "plan_get"])("rejects queued %s across a branch change without appending entries", async (name) => {
  const f = await fixture();
  await f.call("plan_create", params);
  const initial = f.manager.getLeafId()!;
  await f.call("plan_advance", { step: 1, status: "done" });
  const before = f.manager.getEntries();
  const pending = f.call(name, name === "plan_create" ? params : name === "plan_advance" ? { step: 1, status: "skipped" } : {});
  f.manager.branch(initial);
  await expect(pending).rejects.toThrow(/branch changed/i);
  expect(f.manager.getEntries()).toEqual(before);
});

test("does not report in-memory state as saved after a journal write failure", async () => {
  const f = await fixture();
  await f.call("plan_create", params);
  const append = f.manager.appendCustomEntry.bind(f.manager);
  vi.spyOn(f.manager, "appendCustomEntry").mockImplementation((type, data) => {
    append(type, data); // Native manager mutates memory before attempting disk persistence.
    throw new Error("simulated disk full");
  });
  await expect(f.call("plan_advance", { step: 1, status: "done" })).rejects.toThrow(/write failed/i);
  await expect(f.call("plan_get")).rejects.toThrow(/reopen/i);
  await expect(f.call("plan_create", params)).rejects.toThrow(/reopen/i);
  expect((await f.panels.snapshot())[0]).toMatchObject({ error: expect.stringMatching(/reopen/i) as unknown });
  vi.restoreAllMocks();
  f.manager.newSession();
  await f.call("plan_create", params);
  expect((await f.call("plan_get")).details).toMatchObject({ title: params.title });
});

test.each([
  { title: "bad", steps: [{ id: 1, title: "x", status: "invented" }] },
  { title: "bad", steps: [{ id: 1, title: "x", status: "done", dependsOn: [2] }] },
  { title: "bad", steps: [{ id: 2, title: "x", status: "pending" }] },
  { title: "bad", steps: [{ id: 1, title: "x".repeat(501), status: "pending" }] },
])("rejects malformed saved plan without overwriting it: %j", async (data) => {
  const f = await fixture();
  f.manager.appendCustomEntry(customType, data);
  const before = f.manager.getEntries();
  await expect(f.call("plan_get")).rejects.toThrow(/plan|depend|status/i);
  await expect(f.call("plan_create", params)).rejects.toThrow(/plan|depend|status/i);
  expect(f.manager.getEntries()).toEqual(before);
});
