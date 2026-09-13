import { mkdtemp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import { listSessionBookmarks, normalizeBookmarkLabel } from "../src/index.js";
import sessionBookmarksPlugin from "../src/index.js";

describe("session bookmarks", () => {
  test("trims labels and rejects empty or oversized values", () => {
    expect(normalizeBookmarkLabel("  release candidate  ")).toBe("release candidate");
    expect(() => normalizeBookmarkLabel(" ")).toThrow("Bookmark label must contain 1-120 characters");
    expect(() => normalizeBookmarkLabel("x".repeat(121))).toThrow("Bookmark label must contain 1-120 characters");
  });

  test("resolves the latest native labels and ignores cleared entries", () => {
    expect(
      listSessionBookmarks([
        { type: "message", id: "entry-1" },
        { type: "label", id: "label-1", targetId: "entry-1", label: "old" },
        { type: "label", id: "label-2", targetId: "entry-1", label: "release" },
        { type: "label", id: "label-3", targetId: "entry-1", label: undefined },
      ]),
    ).toEqual([]);
  });

  test("adds, lists, and removes bookmarks through the native session manager", async () => {
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    const entries: Array<Record<string, unknown>> = [{ type: "message", id: "entry-7" }];
    context.provide("piHarnessLaunch", { cwd: "/tmp", agentDir: "/tmp", args: [], requestExit() {} });
    context.provide("piSession", {
      manager: {
        getHeader: () => null,
        getEntry: (id: string) => entries.find((entry) => entry.id === id),
        getEntries: () => entries,
        appendLabelChange: (entryId: string, label: string | undefined) => {
          if (!entries.some((entry) => entry.id === entryId)) throw new Error(`Entry ${entryId} not found`);
          const labelId = `label-${entries.length + 1}`;
          entries.push({ type: "label", id: labelId, targetId: entryId, label });
          return labelId;
        },
      },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(sessionBookmarksPlugin);
      const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_bookmarks");
      expect(tool).toBeDefined();
      const added = await tool!.execute("call-1", { action: "add", label: "Release candidate", entryId: "entry-7" }, undefined, undefined, {} as never);
      expect(added.details).toMatchObject({ bookmarks: [{ entryId: "entry-7", label: "Release candidate" }] });
      const bookmarkId = (added.details as { bookmarks: Array<{ id: string }> }).bookmarks[0]!.id;
      await expect(tool!.execute("call-2", { action: "list" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { bookmarks: [{ id: bookmarkId, label: "Release candidate" }] },
      });
      await expect(tool!.execute("call-3", { action: "remove", bookmarkId }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { bookmarks: [] },
      });
      await expect(panels.snapshot()).resolves.toMatchObject([{ id: "session-bookmarks-panel", data: { bookmarks: [], total: 0 } }]);
    } finally {
      await context.fiber.dispose();
    }
  });
});

test("uses the current real session and rejects cancellation, session changes, invalid actions, and disposed calls", async () => {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  const service = { manager: SessionManager.inMemory() };
  const first = service.manager;
  const entryId = first.appendCustomEntry("bookmark-test", {});
  context.provide("piSession", service);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(sessionBookmarksPlugin);
  const tool = tools.snapshot().customTools[0]!;
  const call = (params: unknown, signal?: AbortSignal) => tool.execute("test", params, signal, undefined, {} as never);
  try {
    await call({ action: "add", entryId, label: "first" });
    service.manager = SessionManager.inMemory();
    expect((await call({ action: "list" })).details).toEqual({ bookmarks: [] });
    service.manager = first;
    const abort = new AbortController();
    const pending = call({ action: "add", entryId, label: "cancelled" }, abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    const switching = call({ action: "add", entryId, label: "wrong session" });
    first.newSession();
    await expect(switching).rejects.toThrow(/session changed/);
    await expect(call({ action: "unknown" })).rejects.toThrow(/action/);
    await expect(call({ action: "list", label: "unexpected" })).rejects.toThrow(/property/);
    await context.fiber.dispose();
    await expect(call({ action: "list" })).rejects.toThrow(/cancelled/);
  } finally {
    await context.fiber.dispose();
  }
});

test("persists real labels across reopen and quarantines failed writes until disk reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-bookmarks-"));
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  const manager = SessionManager.create(root, join(root, "sessions"));
  const entryId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Journal initialization" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  context.provide("piSession", { manager });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  try {
    await context.plugin(sessionBookmarksPlugin);
    const tool = tools.snapshot().customTools[0]!;
    const call = (params: unknown) => tool.execute("real", params, undefined, undefined, {} as never);
    await call({ action: "add", entryId, label: "发布检查" });
    await call({ action: "add", entryId, label: "更新后的检查" });
    const file = manager.getSessionFile()!;
    manager.setSessionFile(file);
    expect((await call({ action: "list" })).details).toEqual({ bookmarks: [{ id: entryId, entryId, label: "更新后的检查" }] });
    const disk = await readFile(file, "utf8");
    await rename(file, file + ".backup");
    await mkdir(file);
    await expect(call({ action: "add", entryId, label: "phantom" })).rejects.toThrow(/write failed/);
    await expect(call({ action: "list" })).rejects.toThrow(/reopen the session/);
    expect((await panels.snapshot())[0]!.error).toMatch(/reopen the session/);
    await rm(file, { recursive: true });
    await rename(file + ".backup", file);
    manager.setSessionFile(file);
    expect((await call({ action: "list" })).details).toEqual({ bookmarks: [{ id: entryId, entryId, label: "更新后的检查" }] });
    expect(await readFile(file, "utf8")).toBe(disk);
    await call({ action: "remove", bookmarkId: entryId });
    manager.setSessionFile(file);
    expect((await call({ action: "list" })).details).toEqual({ bookmarks: [] });
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("labels only the current native manager and rejects a pending native switch", async () => {
  const context = new Context(),
    tools = new PiToolRegistry(),
    panels = new PiPluginUiRegistry();
  const launch = SessionManager.inMemory("/launch"),
    active = SessionManager.inMemory("/active");
  const oldEntry = launch.appendCustomEntry("fixture", {}),
    activeEntry = active.appendCustomEntry("fixture", {});
  const runtime = { session: { sessionManager: launch } };
  context.provide("piSession", { manager: launch });
  context.provide("piRuntime", runtime as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  try {
    await context.plugin(sessionBookmarksPlugin);
    const tool = tools.snapshot().customTools[0]!;
    const call = (params: unknown) => tool.execute("native", params, undefined, undefined, {} as never);
    await call({ action: "add", entryId: oldEntry, label: "launch" });
    const launchEntries = structuredClone(launch.getEntries());
    runtime.session.sessionManager = active;
    expect((await panels.snapshot())[0]!.data).toMatchObject({ total: 0, bookmarks: [] });
    await call({ action: "add", entryId: activeEntry, label: "active" });
    expect((await call({ action: "list" })).details).toMatchObject({ bookmarks: [{ entryId: activeEntry, label: "active" }] });
    expect(launch.getEntries()).toEqual(launchEntries);
    const activeEntries = structuredClone(active.getEntries());
    const pending = call({ action: "remove", bookmarkId: activeEntry });
    runtime.session.sessionManager = launch;
    await expect(pending).rejects.toThrow(/session changed/);
    expect(active.getEntries()).toEqual(activeEntries);
    expect(launch.getEntries()).toEqual(launchEntries);
    expect((await panels.snapshot())[0]!.data).toMatchObject({ bookmarks: [{ label: "launch" }] });
  } finally {
    await context.fiber.dispose();
  }
});
