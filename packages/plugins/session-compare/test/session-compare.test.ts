import { Dir, ReadStream } from "node:fs";
import { mkdtemp, mkdir, open, opendir, writeFile, rm, utimes } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { compareMessageEntries, type SessionCompareMessage } from "../src/index.js";
import sessionComparePlugin from "../src/index.js";

const contexts: Context[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("session compare", () => {
  test("marks per-message preview clipping even when only one message differs", () => {
    const diff = compareMessageEntries([{ role: "user", text: "left".repeat(1_001) }], [{ role: "user", text: "right".repeat(801) }]);
    expect(diff).toMatchObject({ shared: 0, addedCount: 1, removedCount: 1, addedTruncated: true, removedTruncated: true });
    expect(diff.added[0]?.text).toHaveLength(4_000);
    expect(diff.removed[0]?.text).toHaveLength(4_000);
  });

  test("does not mark complete or shared boundary-length messages as clipped", () => {
    const exact = { role: "user", text: "a".repeat(4_000) };
    expect(compareMessageEntries([], [exact])).toMatchObject({ addedTruncated: false, removedTruncated: false });
    const shared = { role: "user", text: "b".repeat(4_001) };
    expect(compareMessageEntries([shared], [shared])).toMatchObject({ shared: 1, addedTruncated: false, removedTruncated: false });
  });

  test("reports added and removed messages by conversation position", () => {
    const left: SessionCompareMessage[] = [
      { role: "user", text: "Keep the API stable" },
      { role: "assistant", text: "I will add a regression test." },
      { role: "assistant", text: "I will add a regression test." },
    ];
    const right: SessionCompareMessage[] = [
      { role: "user", text: "Keep the API stable" },
      { role: "assistant", text: "I added the regression test." },
      { role: "toolResult", text: "vitest: 1 passed" },
    ];

    expect(compareMessageEntries(left, right)).toMatchObject({
      shared: 1,
      added: [
        { role: "assistant", text: "I added the regression test." },
        { role: "toolResult", text: "vitest: 1 passed" },
      ],
      removed: [
        { role: "assistant", text: "I will add a regression test." },
        { role: "assistant", text: "I will add a regression test." },
      ],
    });
  });

  test("detects reordered messages and differences beyond the preview limit", () => {
    const first = { role: "user", text: `same-prefix-${"x".repeat(4_100)}-left` };
    const second = { role: "assistant", text: `same-prefix-${"x".repeat(4_100)}-right` };

    expect(compareMessageEntries([first, second], [second, first])).toMatchObject({ shared: 0, added: [{ role: "assistant" }, { role: "user" }] });
    expect(compareMessageEntries([first], [{ ...first, text: first.text.replace(/left$/u, "right") }])).toMatchObject({ shared: 0 });
  });

  test("compares persisted sessions through the Pi tool registry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-compare-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-compare-agent-"));
    directories.push(cwd, agentDir);
    const sessionDir = join(agentDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const header = (id: string) => ({ type: "session", version: 3, id, timestamp: "2026-09-03T00:00:00.000Z", cwd });
    const message = (id: string, parentId: string | null, role: string, text: string) => ({
      type: "message",
      id,
      parentId,
      timestamp: "2026-09-03T00:01:00.000Z",
      message: { role, content: [{ type: "text", text }] },
    });
    const name = { type: "session_info", id: "left-name", parentId: "left-1", timestamp: "2026-09-03T00:02:00.000Z", name: "Release baseline" };
    await writeFile(
      join(sessionDir, "left.jsonl"),
      `${JSON.stringify(header("left"))}\n${JSON.stringify(message("left-1", null, "user", "Ship it"))}\n${JSON.stringify(name)}\n`,
      "utf8",
    );
    await writeFile(
      join(sessionDir, "right.jsonl"),
      `${JSON.stringify(header("right"))}\n${JSON.stringify(message("right-1", null, "user", "Ship it"))}\n${JSON.stringify(message("right-2", "right-1", "assistant", "Done"))}\n`,
      "utf8",
    );
    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piSession", { manager: { getCwd: () => cwd, getSessionId: () => "active", getSessionDir: () => sessionDir } } as never);
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(sessionComparePlugin);
    const compare = tools.snapshot().customTools.find((tool) => tool.name === "session_compare");
    expect(compare).toBeDefined();
    await expect(compare!.execute("call-1", { left: "left", right: "right" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: {
        left: { id: "left", name: "Release baseline", messageCount: 1 },
        right: { id: "right", name: "Ship it", messageCount: 2 },
        shared: 1,
        added: [{ role: "assistant", text: "Done" }],
        removed: [],
        changed: true,
      },
    });
    const controller = new AbortController();
    const pending = compare!.execute("cancel", { left: "left", right: "right" }, controller.signal, undefined, {} as never);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    const result = await compare!.execute("clone", { left: "left", right: "right" }, undefined, undefined, {} as never);
    (result.details as { added: Array<{ text: string }> }).added[0]!.text = "MUTATED";
    expect(JSON.stringify(await context.piPluginUi.snapshot())).not.toContain("MUTATED");
    await writeFile(
      join(sessionDir, "right.jsonl"),
      `${JSON.stringify(header("right"))}\n${JSON.stringify(message("right-long", null, "assistant", "x".repeat(4_001)))}\n`,
      "utf8",
    );
    const clipped = await compare!.execute("clipped", { left: "left", right: "right" }, undefined, undefined, {} as never);
    expect(clipped).toMatchObject({ details: { addedTruncated: true, removedTruncated: false, addedCount: 1, removedCount: 1 } });
    expect(clipped.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("Difference previews are limited") as unknown })]);
    await expect(compare!.execute("invalid", { left: "left", right: "right", extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/Unknown/);
    await context.fiber.dispose();
    await expect(compare!.execute("disposed", { left: "left", right: "right" }, undefined, undefined, {} as never)).rejects.toThrow(/cancelled/);
  });

  test("normalizes cancellation that arrives during a bounded session read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-compare-cancel-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-compare-cancel-agent-"));
    directories.push(cwd, agentDir);
    const sessionDir = join(agentDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const header = (id: string) => ({ type: "session", version: 3, id, timestamp: "2026-09-03T00:00:00.000Z", cwd });
    const message = (id: string, text: string) => ({
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-09-03T00:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text }] },
    });
    await writeFile(join(sessionDir, "left.jsonl"), `${JSON.stringify(header("left"))}\n${JSON.stringify(message("left-1", "same"))}\n`, "utf8");
    await writeFile(
      join(sessionDir, "right.jsonl"),
      `${JSON.stringify(header("right"))}\n${JSON.stringify(message("right-1", "x".repeat(200_000)))}\n`,
      "utf8",
    );
    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piSession", { manager: { getCwd: () => cwd, getSessionId: () => "active", getSessionDir: () => sessionDir } } as never);
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(sessionComparePlugin);
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_compare");
    if (tool === undefined) throw new Error("session_compare was not registered");

    const probe = await open(join(sessionDir, "right.jsonl"), "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const originalRead = Object.getOwnPropertyDescriptor(fileHandlePrototype, "read")?.value as FileHandle["read"];
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let readCalls = 0;
    let releaseReads!: () => void;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    fileHandlePrototype.read = async function (...args: Parameters<FileHandle["read"]>): Promise<Awaited<ReturnType<FileHandle["read"]>>> {
      readCalls += 1;
      if (readCalls === 2) markReadStarted();
      await readsReleased;
      return originalRead.call(this, ...args);
    };
    try {
      const controller = new AbortController();
      const pending = tool.execute("delayed-cancel", { left: "left.jsonl", right: "right.jsonl" }, controller.signal, undefined, {} as never);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        readStarted,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error("timed out waiting for session read to start")), 5_000);
        }),
      ]);
      if (watchdog !== undefined) clearTimeout(watchdog);
      controller.abort(new Error("custom reason"));
      releaseReads();
      await expect(pending).rejects.toThrow("Session comparison was cancelled");
      expect(readCalls).toBe(2);
    } finally {
      releaseReads();
      fileHandlePrototype.read = originalRead;
    }
  });

  test("compares an explicitly requested session beyond the first 200 recent sessions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-compare-old-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-compare-old-agent-"));
    directories.push(cwd, agentDir);
    const sessionDir = join(agentDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const session = (id: string, text: string, timestamp = "2026-09-03T00:00:00.000Z") =>
      `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd })}\n${JSON.stringify({
        type: "message",
        id: `${id}-message`,
        parentId: null,
        timestamp,
        message: { role: "user", content: [{ type: "text", text }] },
      })}\n`;
    const identities = new Map<string, string>();
    await Promise.all(
      Array.from({ length: 201 }, (_, index) => {
        const id = `session-${index}`;
        const filename = `2026-09-03T00-00-${String(index).padStart(3, "0")}_${id}.jsonl`;
        identities.set(filename, id);
        return writeFile(join(sessionDir, filename), session(id, `Iteration ${index}`), "utf8");
      }),
    );
    const observedOrder: string[] = [];
    const directory = await opendir(sessionDir);
    for await (const entry of directory) if (entry.isFile() && entry.name.endsWith(".jsonl")) observedOrder.push(entry.name);
    expect(observedOrder).toHaveLength(201);
    const targetFilename = observedOrder[200]!;
    const targetId = identities.get(targetFilename)!;
    const comparisonFilename = observedOrder[0]!;
    const comparisonId = identities.get(comparisonFilename)!;
    const targetPath = join(sessionDir, targetFilename);
    await utimes(targetPath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));

    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piSession", { manager: { getCwd: () => cwd, getSessionId: () => "active", getSessionDir: () => sessionDir } } as never);
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(sessionComparePlugin);
    const compare = tools.snapshot().customTools.find((tool) => tool.name === "session_compare");
    if (compare === undefined) throw new Error("session_compare was not registered");

    const probe = await open(targetPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const originalRead = Object.getOwnPropertyDescriptor(fileHandlePrototype, "read")?.value as FileHandle["read"];
    let readCalls = 0;
    fileHandlePrototype.read = async function (...args: Parameters<FileHandle["read"]>): Promise<Awaited<ReturnType<FileHandle["read"]>>> {
      readCalls += 1;
      return originalRead.call(this, ...args);
    };
    let result: Awaited<ReturnType<typeof compare.execute>>;
    try {
      result = await compare.execute("old", { left: targetId, right: comparisonFilename }, undefined, undefined, {} as never);
    } finally {
      fileHandlePrototype.read = originalRead;
    }
    expect(readCalls).toBeGreaterThan(200);
    expect(result).toMatchObject({
      details: {
        left: { id: targetId, messageCount: 1 },
        right: { id: comparisonId, messageCount: 1 },
        changed: true,
      },
    });
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining(`Compared ${targetId} with ${comparisonId}: changed.`) as unknown }),
    ]);
    expect((await context.piPluginUi.snapshot())[0]?.data).toMatchObject({ left: { id: targetId }, right: { id: comparisonId }, changed: true });
  });

  test("does not read an unrelated oversized journal beyond its bounded header", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-compare-header-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-compare-header-agent-"));
    directories.push(cwd, agentDir);
    const sessionDir = join(agentDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const session = (id: string, text: string) =>
      `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-03T00:00:00.000Z", cwd })}\n${JSON.stringify({
        type: "message",
        id: `${id}-message`,
        parentId: null,
        timestamp: "2026-09-03T00:01:00.000Z",
        message: { role: "user", content: [{ type: "text", text }] },
      })}\n`;
    const unrelatedPath = join(sessionDir, "aa-unrelated.jsonl");
    await writeFile(
      unrelatedPath,
      `${JSON.stringify({ type: "session", version: 3, id: "unrelated", timestamp: "2026-09-03T00:00:00.000Z", cwd })}\n${"x".repeat(8 * 1024 * 1024)}`,
      "utf8",
    );
    await writeFile(join(sessionDir, "zz-left.jsonl"), session("left", "before"), "utf8");
    await writeFile(join(sessionDir, "zz-right.jsonl"), session("right", "after"), "utf8");

    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piSession", { manager: { getCwd: () => cwd, getSessionId: () => "active", getSessionDir: () => sessionDir } } as never);
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(sessionComparePlugin);
    const compare = tools.snapshot().customTools.find((tool) => tool.name === "session_compare");
    if (compare === undefined) throw new Error("session_compare was not registered");

    const originalRead = Object.getOwnPropertyDescriptor(ReadStream.prototype, "_read")?.value as (this: ReadStream, size: number) => void;
    let fullJournalRequestedBytes = 0;
    ReadStream.prototype._read = function (size: number): void {
      if (size >= 64 * 1024) fullJournalRequestedBytes += size;
      originalRead.call(this, size);
    };
    try {
      await expect(compare.execute("bounded-header", { left: "left", right: "right" }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { left: { id: "left" }, right: { id: "right" }, changed: true },
      });
      expect(fullJournalRequestedBytes).toBe(0);
    } finally {
      ReadStream.prototype._read = originalRead;
    }
  });

  test("uses the authoritative bounded read for an explicit filename with a large valid header", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-compare-direct-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-compare-direct-agent-"));
    directories.push(cwd, agentDir);
    const sessionDir = join(agentDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const largeHeader = { type: "session", version: 3, id: "large-header", timestamp: "2026-09-03T00:00:00.000Z", cwd, metadata: "x".repeat(70 * 1024) };
    const message = {
      type: "message",
      id: "large-message",
      parentId: null,
      timestamp: "2026-09-03T00:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "large header session" }] },
    };
    await writeFile(join(sessionDir, "large.jsonl"), `${JSON.stringify(largeHeader)}\n${JSON.stringify(message)}\n`, "utf8");

    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piSession", { manager: { getCwd: () => cwd, getSessionId: () => "active", getSessionDir: () => sessionDir } } as never);
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(sessionComparePlugin);
    const compare = tools.snapshot().customTools.find((tool) => tool.name === "session_compare");
    if (compare === undefined) throw new Error("session_compare was not registered");

    await expect(
      compare.execute("large-header", { left: "large.jsonl", right: join(sessionDir, "large.jsonl") }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      details: { left: { id: "large-header", messageCount: 1 }, right: { id: "large-header", messageCount: 1 }, changed: false },
    });
  });

  test("compares a legacy session whose header omits cwd and timestamp", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-compare-legacy-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-compare-legacy-agent-"));
    directories.push(cwd, agentDir);
    const sessionDir = join(agentDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const header = { type: "session", version: 1, id: "legacy" };
    const message = {
      type: "message",
      id: "legacy-message",
      parentId: null,
      timestamp: "2020-01-01T00:01:00.000Z",
      message: { role: "user", content: "legacy session" },
    };
    await writeFile(join(sessionDir, "2019-legacy.jsonl"), `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`, "utf8");

    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piSession", { manager: { getCwd: () => cwd, getSessionId: () => "active", getSessionDir: () => sessionDir } } as never);
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(sessionComparePlugin);
    const compare = tools.snapshot().customTools.find((tool) => tool.name === "session_compare");
    if (compare === undefined) throw new Error("session_compare was not registered");

    await expect(compare.execute("legacy", { left: "legacy", right: "legacy" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { left: { id: "legacy", messageCount: 1 }, right: { id: "legacy", messageCount: 1 }, changed: false },
    });
  });

  test("reports a context change after an empty directory scan instead of not-found", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-compare-empty-cwd-"));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-compare-empty-agent-"));
    directories.push(cwd, agentDir);
    const sessionDir = join(agentDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    let reads = 0;
    const manager = {
      getCwd: () => cwd,
      getSessionDir: () => sessionDir,
      getSessionId: () => (++reads < 5 ? "active" : "changed"),
    };
    const context = new Context();
    contexts.push(context);
    provideLaunchContext(context, { cwd, agentDir, args: [], requestExit() {} });
    context.provide("piSession", { manager } as never);
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await context.plugin(sessionComparePlugin);
    const compare = context.piTools.snapshot().customTools.find((tool) => tool.name === "session_compare");
    if (compare === undefined) throw new Error("session_compare was not registered");

    type CloseCallback = (error?: NodeJS.ErrnoException | null) => void;
    const originalClose = Object.getOwnPropertyDescriptor(Dir.prototype, "close")?.value as Dir["close"];
    const closeWithCallback = originalClose as (this: Dir, callback: CloseCallback) => void;
    let closeCalls = 0;
    Dir.prototype.close = function (this: Dir, callback?: CloseCallback): Promise<void> | void {
      closeCalls += 1;
      if (callback !== undefined) return closeWithCallback.call(this, callback);
      return new Promise<void>((resolve, reject) => {
        closeWithCallback.call(this, (error) => (error == null ? resolve() : reject(error)));
      });
    } as Dir["close"];
    try {
      await expect(compare.execute("empty", { left: "missing", right: "missing" }, undefined, undefined, {} as never)).rejects.toThrow(/context changed/iu);
      expect(closeCalls).toBe(1);
    } finally {
      Dir.prototype.close = originalClose;
    }
  });
});

test("retains full mismatch counts beyond display limits", () => {
  const left = Array.from({ length: 65 }, (_, index) => ({ role: "user", text: `left-${index}` }));
  const right = Array.from({ length: 70 }, (_, index) => ({ role: "user", text: `right-${index}` }));
  expect(compareMessageEntries(left, right)).toMatchObject({ shared: 0, addedCount: 70, removedCount: 65, addedTruncated: true, removedTruncated: true });
});

test("clears comparison on native session change and binds scope before parameters", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-compare-native-"));
  directories.push(cwd);
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "native transcript" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const id = manager.getSessionId();
  const context = new Context();
  contexts.push(context);
  provideLaunchContext(context, { cwd, agentDir: cwd, args: [], requestExit() {} });
  context.provide("piSession", { manager });
  context.provide("piTools", new PiToolRegistry());
  context.provide("piPluginUi", new PiPluginUiRegistry());
  await context.plugin(sessionComparePlugin);
  const tool = context.piTools.snapshot().customTools[0]!;
  await tool.execute("warm", { left: id, right: id }, undefined, undefined, {} as never);
  manager.newSession();
  expect((await context.piPluginUi.snapshot())[0]!.data).toMatchObject({ left: null, right: null });
  const params = new Proxy(
    { left: id, right: id },
    {
      ownKeys(target) {
        manager.newSession();
        return Reflect.ownKeys(target);
      },
    },
  );
  await expect(tool.execute("reentrant", params, undefined, undefined, {} as never)).rejects.toThrow(/context changed/iu);
});
