import { ReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rename, stat, utimes, writeFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import synapsePlugin, { buildSynapseGraph } from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

const contexts: Context[] = [];
const directories: string[] = [];

async function persistedSession(id = "root", text = "Root") {
  const cwd = await mkdtemp(join(tmpdir(), "synapse-fixture-"));
  directories.push(cwd);
  const sessionDir = join(cwd, "sessions");
  await mkdir(sessionDir);
  const path = join(sessionDir, `2026-09-12_${id}.jsonl`);
  await writeFile(
    path,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-12T00:00:00.000Z", cwd })}\n${JSON.stringify({
      type: "message",
      id: `${id}-message`,
      parentId: null,
      timestamp: "2026-09-12T00:01:00.000Z",
      message: { role: "user", content: text },
    })}\n`,
    "utf8",
  );
  return {
    cwd,
    sessionDir,
    path,
    manager: {
      getCwd: () => cwd,
      getSessionId: () => id,
      getSessionDir: () => sessionDir,
      getSessionFile: () => path,
      usesDefaultSessionDir: () => false,
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
    const fixture = await persistedSession();
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: fixture.cwd, agentDir: fixture.cwd, args: [], requestExit() {} });
    context.provide("piSession", { manager: fixture.manager } as never);
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
  });

  test("serves rapid panel polls from one bounded session scan", async () => {
    const fixture = await persistedSession();
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: fixture.cwd, agentDir: fixture.cwd, args: [], requestExit() {} });
    context.provide("piSession", { manager: fixture.manager } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(synapsePlugin, { maxSessions: 10 });
    contexts.push(context);
    const handle = await open(fixture.path);
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    const originalRead = Object.getOwnPropertyDescriptor(prototype, "read")?.value as FileHandle["read"];
    let reads = 0;
    prototype.read = async function (...args: Parameters<FileHandle["read"]>) {
      reads += 1;
      return originalRead.apply(this, args);
    };
    try {
      const [first, second] = await Promise.all([panels.snapshot(), panels.snapshot()]);
      const sharedReads = reads;
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { nodes: [{ id: "root" }], refreshes: 0 } }]);
      expect(first).toMatchObject([{ data: { nodes: [{ id: "root" }] } }]);
      expect(second).toMatchObject([{ data: { nodes: [{ id: "root" }] } }]);
      expect(sharedReads).toBeGreaterThan(0);
      expect(reads).toBe(sharedReads);
    } finally {
      prototype.read = originalRead;
    }
  });

  test("counts synapse_session_map invocations rather than expired panel polls", async () => {
    const fixture = await persistedSession();
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: fixture.cwd, agentDir: fixture.cwd, args: [], requestExit() {} });
    context.provide("piSession", { manager: fixture.manager } as never);
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
    await tool.execute("map", {}, undefined, undefined, {} as never);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { refreshes: 1 } }]);
  });
});

test("keeps maps tied to active native managers and returns detached model-visible results", async () => {
  const root = await persistedSession("launch", "Launch");
  const active = await persistedSession("native", "当前工作区");
  const second = await persistedSession("second", "Second");
  const runtime = { session: { sessionManager: active.manager } };
  const context = new Context();
  contexts.push(context);
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root.cwd, agentDir: root.cwd, args: [], requestExit() {} });
  context.provide("piSession", { manager: root.manager } as never);
  context.provide("piRuntime", runtime as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(synapsePlugin, {});
  const tool = tools.snapshot().customTools.find((item) => item.name === "synapse_session_map")!;
  const result = await tool.execute("map", {}, undefined, undefined, {} as never);
  expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ cwd: active.cwd, nodes: [{ label: "当前工作区" }] });
  (result.details as { nodes: unknown[] }).nodes.length = 0;
  expect((await panels.snapshot())[0]?.data).toMatchObject({ nodes: [{ id: "native" }] });
  runtime.session.sessionManager = second.manager;
  await expect(panels.snapshot()).resolves.toMatchObject([{ data: { cwd: second.cwd, nodes: [{ id: "second", label: "Second" }] } }]);
  const abort = new AbortController();
  abort.abort();
  await expect(tool.execute("abort", {}, abort.signal, undefined, {} as never)).rejects.toThrow(/cancel/i);
  await expect(tool.execute("invalid", { extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/parameter/i);
});

test("rejects scans that outlive their native session and does not commit cancelled work", async () => {
  const fixture = await persistedSession();
  let sessionId = fixture.manager.getSessionId();
  const manager = { ...fixture.manager, getSessionId: () => sessionId };
  const context = new Context();
  contexts.push(context);
  const tools = new PiToolRegistry();
  provideLaunchContext(context, { cwd: fixture.cwd, agentDir: fixture.cwd, args: [], requestExit() {} });
  context.provide("piSession", { manager } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", new PiPluginUiRegistry());
  await context.plugin(synapsePlugin, {});
  const tool = tools.snapshot().customTools[0]!;
  const handle = await open(fixture.path);
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const originalRead = Object.getOwnPropertyDescriptor(prototype, "read")?.value as FileHandle["read"];
  let gate: { entered: Promise<void>; release: () => void } = { entered: Promise.resolve(), release() {} };
  let enter: (() => void) | undefined;
  let release: (() => void) | undefined;
  const arm = () => {
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const wait = new Promise<void>((resolve) => (release = resolve));
    gate = { entered, release: () => release?.() };
    return wait;
  };
  let wait = arm();
  prototype.read = async function (...args: Parameters<FileHandle["read"]>) {
    const activeWait = wait;
    wait = Promise.resolve();
    enter?.();
    await activeWait;
    return originalRead.apply(this, args);
  };
  try {
    const pending = tool.execute("map", {}, undefined, undefined, {} as never);
    const panel = context.piPluginUi.snapshot();
    await gate.entered;
    gate.release();
    await expect(pending).resolves.toMatchObject({ details: { nodes: [{ id: "root" }] } });
    await expect(panel).resolves.toMatchObject([{ data: { nodes: [{ id: "root" }] } }]);

    wait = arm();
    const stale = tool.execute("stale", {}, undefined, undefined, {} as never);
    await gate.entered;
    sessionId = "changed";
    gate.release();
    await expect(stale).rejects.toThrow(/context changed/i);

    sessionId = fixture.manager.getSessionId();
    wait = arm();
    const abort = new AbortController();
    const cancelled = tool.execute("map", {}, abort.signal, undefined, {} as never);
    await gate.entered;
    abort.abort();
    gate.release();
    await expect(cancelled).rejects.toThrow(/cancel/i);
  } finally {
    gate.release();
    prototype.read = originalRead;
  }
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

test("does not fully read an unrelated journal beyond the configured map limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "synapse-bounded-inventory-"));
  const sessionDir = join(root, "sessions");
  const context = new Context();
  try {
    await mkdir(sessionDir);
    const header = (id: string) => ({ type: "session", version: 3, id, timestamp: "2026-09-12T00:00:00.000Z", cwd: root });
    const message = (id: string, text: string) => ({
      type: "message",
      id: `${id}-message`,
      parentId: null,
      timestamp: "2026-09-12T00:01:00.000Z",
      message: { role: "user", content: text },
    });
    const oldPath = join(sessionDir, "old.jsonl");
    const recentPath = join(sessionDir, "recent.jsonl");
    await writeFile(oldPath, `${JSON.stringify(header("old"))}\n${"x".repeat(8 * 1024 * 1024)}`, "utf8");
    await writeFile(recentPath, `${JSON.stringify(header("recent"))}\n${JSON.stringify(message("recent", "Recent session"))}\n`, "utf8");
    await utimes(oldPath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piSession", {
      manager: {
        getCwd: () => root,
        getSessionId: () => "active",
        getSessionDir: () => sessionDir,
        getSessionFile: () => recentPath,
        usesDefaultSessionDir: () => false,
      },
    } as never);
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(synapsePlugin, { maxSessions: 1 });
    const tool = tools.snapshot().customTools.find((item) => item.name === "synapse_session_map");
    if (tool === undefined) throw new Error("synapse_session_map was not registered");

    const originalRead = Object.getOwnPropertyDescriptor(ReadStream.prototype, "_read")?.value as (this: ReadStream, size: number) => void;
    let fullJournalRequestedBytes = 0;
    ReadStream.prototype._read = function (size: number): void {
      if (size >= 64 * 1024) fullJournalRequestedBytes += size;
      originalRead.call(this, size);
    };
    try {
      await expect(tool.execute("bounded", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { total: 2, truncated: true, nodes: [{ id: "recent", label: "Recent session" }] },
      });
      expect(fullJournalRequestedBytes).toBe(0);
    } finally {
      ReadStream.prototype._read = originalRead;
    }
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("reserves the active persisted session when newer journals fill the map limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "synapse-active-session-"));
  const sessionDir = join(root, "sessions");
  const context = new Context();
  try {
    await mkdir(sessionDir);
    const journal = (id: string, text: string) =>
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-12T00:00:00.000Z", cwd: root })}\n${JSON.stringify({
        type: "message",
        id: `${id}-message`,
        parentId: null,
        timestamp: "2026-09-12T00:01:00.000Z",
        message: { role: "user", content: text },
      })}\n`;
    const activePath = join(sessionDir, "active.jsonl");
    const recentPath = join(sessionDir, "recent.jsonl");
    await writeFile(activePath, journal("active", "Active"), "utf8");
    await writeFile(recentPath, journal("recent", "Recent"), "utf8");
    await utimes(activePath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piSession", {
      manager: {
        getCwd: () => root,
        getSessionId: () => "active",
        getSessionDir: () => sessionDir,
        getSessionFile: () => activePath,
        usesDefaultSessionDir: () => false,
      },
    } as never);
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(synapsePlugin, { maxSessions: 1 });

    await expect(tools.snapshot().customTools[0]!.execute("active", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { total: 2, truncated: true, activeSessionId: "active", nodes: [{ id: "active", active: true }] },
    });
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps oversized selected journals as explicit header-only nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "synapse-oversized-"));
  const sessionDir = join(root, "sessions");
  const path = join(sessionDir, "large.jsonl");
  const context = new Context();
  try {
    await mkdir(sessionDir);
    await writeFile(
      path,
      `${JSON.stringify({ type: "session", version: 3, id: "large", timestamp: "2026-09-12T00:00:00.000Z", cwd: root })}\n${"x".repeat(4 * 1024 * 1024)}`,
      "utf8",
    );
    provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
    context.provide("piSession", {
      manager: {
        getCwd: () => root,
        getSessionId: () => "large",
        getSessionDir: () => sessionDir,
        getSessionFile: () => path,
        usesDefaultSessionDir: () => false,
      },
    } as never);
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(synapsePlugin, {});

    await expect(tools.snapshot().customTools[0]!.execute("large", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { total: 1, truncated: false, metadataTruncated: 1, nodes: [{ id: "large", messagesTruncated: true }] },
    });
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("does not publish stale identity when a selected journal becomes oversized after discovery", async () => {
  const fixture = await persistedSession();
  const movedPath = `${fixture.path}.moved`;
  const handle = await open(fixture.path);
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const originalRead = Object.getOwnPropertyDescriptor(prototype, "read")?.value as FileHandle["read"];
  let replaced = false;
  prototype.read = async function (...args: Parameters<FileHandle["read"]>) {
    const result = await originalRead.apply(this, args);
    if (!replaced) {
      replaced = true;
      await rename(fixture.path, movedPath);
      await writeFile(
        fixture.path,
        `${JSON.stringify({ type: "session", version: 3, id: "replacement", timestamp: "2026-09-12T00:00:00.000Z", cwd: fixture.cwd })}\n${"x".repeat(
          4 * 1024 * 1024,
        )}`,
        "utf8",
      );
    }
    return result;
  };
  const context = new Context();
  contexts.push(context);
  try {
    provideLaunchContext(context, { cwd: fixture.cwd, agentDir: fixture.cwd, args: [], requestExit() {} });
    context.provide("piSession", { manager: fixture.manager } as never);
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(synapsePlugin, {});

    await expect(tools.snapshot().customTools[0]!.execute("replacement", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { total: 1, truncated: false, metadataTruncated: 0, metadataUnavailable: 1, nodes: [] },
    });
  } finally {
    prototype.read = originalRead;
  }
});

test("counts malformed journal headers as unavailable inventory without calling the map truncated", async () => {
  const fixture = await persistedSession();
  await writeFile(join(fixture.sessionDir, "malformed.jsonl"), "not-json\n", "utf8");
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd: fixture.cwd, agentDir: fixture.cwd, args: [], requestExit() {} });
  context.provide("piSession", { manager: fixture.manager } as never);
  const tools = new PiToolRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", new PiPluginUiRegistry());
  await context.plugin(synapsePlugin, {});

  await expect(tools.snapshot().customTools[0]!.execute("malformed", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
    details: { total: 2, truncated: false, metadataUnavailable: 1, nodes: [{ id: "root" }] },
  });
});

test("does not attribute cwd-less legacy journals from a shared custom directory to the active workspace", async () => {
  const fixture = await persistedSession("matching", "Matching");
  const legacyPath = join(fixture.sessionDir, "legacy.jsonl");
  await writeFile(legacyPath, `${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: "2026-09-12T00:00:00.000Z" })}\n`, "utf8");
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd: fixture.cwd, agentDir: fixture.cwd, args: [], requestExit() {} });
  context.provide("piSession", { manager: fixture.manager } as never);
  const tools = new PiToolRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", new PiPluginUiRegistry());
  await context.plugin(synapsePlugin, {});

  await expect(tools.snapshot().customTools[0]!.execute("custom", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
    details: { total: 1, metadataUnavailable: 0, nodes: [{ id: "matching" }] },
  });
});

test("preserves stored cwd values without filtering a default per-workspace directory", async () => {
  const fixture = await persistedSession("matching", "Matching");
  await writeFile(
    join(fixture.sessionDir, "legacy.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: "legacy", timestamp: "2026-09-12T00:00:00.000Z" })}\n`,
    "utf8",
  );
  await writeFile(
    join(fixture.sessionDir, "stale-cwd.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: "stale", timestamp: "2026-09-12T00:00:00.000Z", cwd: "/old/workspace" })}\n`,
    "utf8",
  );
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd: fixture.cwd, agentDir: fixture.cwd, args: [], requestExit() {} });
  context.provide("piSession", { manager: { ...fixture.manager, usesDefaultSessionDir: () => true } } as never);
  const tools = new PiToolRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", new PiPluginUiRegistry());
  await context.plugin(synapsePlugin, {});

  const result = await tools.snapshot().customTools[0]!.execute("default", {}, undefined, undefined, {} as never);
  expect(result.details).toMatchObject({ total: 3, metadataUnavailable: 0 });
  expect((result.details as { nodes: Array<{ id: string; cwd: string }> }).nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "legacy", cwd: "" }), expect.objectContaining({ id: "stale", cwd: "/old/workspace" })]),
  );
});

test("counts structurally invalid cwd metadata as unavailable rather than another workspace", async () => {
  const fixture = await persistedSession();
  await writeFile(
    join(fixture.sessionDir, "invalid-cwd.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: "invalid", timestamp: "2026-09-12T00:00:00.000Z", cwd: "x".repeat(4_097) })}\n`,
    "utf8",
  );
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd: fixture.cwd, agentDir: fixture.cwd, args: [], requestExit() {} });
  context.provide("piSession", { manager: fixture.manager } as never);
  const tools = new PiToolRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", new PiPluginUiRegistry());
  await context.plugin(synapsePlugin, {});

  await expect(tools.snapshot().customTools[0]!.execute("invalid", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
    details: { total: 2, metadataUnavailable: 1, nodes: [{ id: "root" }] },
  });
});

test("keeps hydrated labels surrogate-safe and visibly truncated", async () => {
  const fixture = await persistedSession();
  const longName = `${"x".repeat(119)}😀suffix`;
  await writeFile(
    fixture.path,
    `${JSON.stringify({ type: "session", version: 3, id: "root", timestamp: "2026-09-12T00:00:00.000Z", cwd: fixture.cwd })}\n${JSON.stringify({
      type: "session_info",
      id: "info",
      parentId: null,
      timestamp: "2026-09-12T00:00:01.000Z",
      name: longName,
    })}\n`,
    "utf8",
  );
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd: fixture.cwd, agentDir: fixture.cwd, args: [], requestExit() {} });
  context.provide("piSession", { manager: fixture.manager } as never);
  const tools = new PiToolRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", new PiPluginUiRegistry());
  await context.plugin(synapsePlugin, {});

  const result = await tools.snapshot().customTools[0]!.execute("label", {}, undefined, undefined, {} as never);
  expect(result.details).toMatchObject({ nodes: [{ label: `${"x".repeat(119)}…` }] });
  expect(JSON.stringify(result.details)).not.toContain("�");
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
