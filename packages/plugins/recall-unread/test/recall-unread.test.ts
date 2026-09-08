import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import recallUnread, { Config as RecallUnreadConfig, unreadUserMessage } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeSession(
  path: string,
  id: string,
  messages: Array<{ role: "user" | "assistant"; text: string }>,
  name?: string,
  cwd = "/workspace",
): Promise<void> {
  const entries: unknown[] = [
    { type: "session", version: 3, id, timestamp: "2026-09-05T00:00:00.000Z", cwd },
    ...(name === undefined ? [] : [{ type: "session_info", id: `${id}-name`, parentId: null, timestamp: "2026-09-05T00:00:01.000Z", name }]),
    ...messages.map((message, index) => ({
      type: "message",
      id: `${id}-${index}`,
      parentId: index === 0 ? null : `${id}-${index - 1}`,
      timestamp: `2026-09-05T00:00:${String(index + 2).padStart(2, "0")}.000Z`,
      message: { role: message.role, content: [{ type: "text", text: message.text }], timestamp: Date.UTC(2026, 8, 5, 0, 0, index + 2) },
    })),
  ];
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

async function loadPlugin(sessionDir: string, active: { id: string; path?: string }, maxSessions = 100, bypassConfigValidation = false) {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: "/workspace", agentDir: sessionDir, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  context.provide("piSession", {
    manager: {
      getSessionDir: () => sessionDir,
      getSessionId: () => active.id,
      getSessionFile: () => active.path,
      getCwd: () => "/workspace",
    },
  } as never);
  if (bypassConfigValidation) await recallUnread.apply(context, { maxSessions });
  else await context.plugin(recallUnread, { maxSessions });
  return { context, tools, panels };
}

async function waitForCondition(condition: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("recall unread", () => {
  test("returns the latest user message only when no later assistant message exists", () => {
    expect(
      unreadUserMessage([
        { type: "message", message: { role: "user", content: [{ type: "text", text: "先前的问题" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "已回答" }] } },
      ]),
    ).toBeUndefined();
    expect(unreadUserMessage([{ type: "message", message: { role: "user", content: [{ type: "text", text: "请帮我找出未完成的任务" }] } }])).toBe(
      "请帮我找出未完成的任务",
    );
  });

  test("joins text parts and ignores non-message entries", () => {
    expect(
      unreadUserMessage([
        { type: "session_info", name: "demo" },
        {
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "第一段" },
              { type: "image", mimeType: "image/png" },
              { type: "text", text: "第二段" },
            ],
          },
        },
      ]),
    ).toBe("第一段\n第二段");
  });

  test("does not invoke entry or content accessors beyond bounded text parts", () => {
    let entryAccessed = false;
    let partAccessed = false;
    const hostileEntry = {};
    Object.defineProperty(hostileEntry, "type", {
      enumerable: true,
      get() {
        entryAccessed = true;
        throw new Error("entry type getter executed");
      },
    });
    const hostilePart = {};
    Object.defineProperty(hostilePart, "type", {
      enumerable: true,
      get() {
        partAccessed = true;
        throw new Error("content type getter executed");
      },
    });
    const parts = [...Array.from({ length: 1_000 }, () => ({ type: "text", text: "x" })), hostilePart];

    expect(unreadUserMessage([hostileEntry, { type: "message", message: { role: "user", content: parts } }])).toHaveLength(500);
    expect(entryAccessed).toBe(false);
    expect(partAccessed).toBe(false);
  });

  test("ignores accessor-backed message fields and bounds text before joining parts", () => {
    const accessed: string[] = [];
    const accessor = (label: string) => ({
      enumerable: true,
      get() {
        accessed.push(label);
        throw new Error(`${label} getter executed`);
      },
    });
    const trailingEntry = {};
    Object.defineProperty(trailingEntry, "type", accessor("entry type"));
    const accessorMessage = { type: "message" };
    Object.defineProperty(accessorMessage, "message", accessor("entry message"));
    const accessorRole = { content: "ignored" };
    Object.defineProperty(accessorRole, "role", accessor("message role"));
    const accessorContent = { role: "user" };
    Object.defineProperty(accessorContent, "content", accessor("message content"));
    const accessorPart = {};
    Object.defineProperty(accessorPart, "type", accessor("part type"));

    expect(
      unreadUserMessage([
        { type: "message", message: { role: "user", content: [{ type: "text", text: "z".repeat(5_000) }, accessorPart] } },
        { type: "message", message: accessorContent },
        { type: "message", message: accessorRole },
        accessorMessage,
        trailingEntry,
      ]),
    ).toBe("z".repeat(500));
    expect(accessed).toEqual([]);
  });

  test("publishes cached startup inventory without the active session", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-"));
    temporaryDirectories.push(sessionDir);
    const activePath = join(sessionDir, "active.jsonl");
    await writeSession(activePath, "active", [{ role: "user", text: "current question" }], "Current");
    await writeSession(join(sessionDir, "unread.jsonl"), "unread", [{ role: "user", text: "older question" }], "Needs reply");
    await writeSession(
      join(sessionDir, "answered.jsonl"),
      "answered",
      [
        { role: "user", text: "done?" },
        { role: "assistant", text: "done" },
      ],
      "Answered",
    );

    const { context, panels } = await loadPlugin(sessionDir, { id: "active", path: activePath });
    try {
      const first = (await panels.snapshot())[0]?.data;
      const second = (await panels.snapshot())[0]?.data;
      expect(first).toMatchObject({ scans: 1, total: 1, items: [{ id: "unread", name: "Needs reply", message: "older question" }] });
      expect(second).toEqual(first);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("avoids the upstream unbounded session listing", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-bounded-"));
    temporaryDirectories.push(sessionDir);
    await writeSession(join(sessionDir, "unread.jsonl"), "unread", [{ role: "user", text: "bounded scan" }]);
    const upstream = vi.spyOn(SessionManager, "list").mockRejectedValue(new Error("unbounded SessionManager.list called"));

    const { context, panels } = await loadPlugin(sessionDir, { id: "active" });
    try {
      expect(upstream).not.toHaveBeenCalled();
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { total: 1, items: [{ id: "unread", message: "bounded scan" }] } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("reports bounded inventory while rejecting links and invalid UTF-8", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-files-"));
    temporaryDirectories.push(sessionDir);
    await writeSession(join(sessionDir, "unread.jsonl"), "unread", [{ role: "user", text: "safe unread" }]);
    await writeSession(join(sessionDir, "answered.jsonl"), "answered", [
      { role: "user", text: "question" },
      { role: "assistant", text: "answer" },
    ]);
    const invalidPrefix = `${JSON.stringify({ type: "session", version: 3, id: "invalid", timestamp: "2026-09-05T00:00:00.000Z", cwd: "/workspace" })}\n`;
    await writeFile(
      join(sessionDir, "invalid.jsonl"),
      Buffer.concat([
        Buffer.from(invalidPrefix + '{"type":"message","message":{"role":"user","content":"bad', "utf8"),
        Buffer.from([0xff]),
        Buffer.from('"}}\n', "utf8"),
      ]),
    );
    const linkedDirectory = join(sessionDir, "linked-source");
    await mkdir(linkedDirectory);
    const linkedTarget = join(linkedDirectory, "target.jsonl");
    await writeSession(linkedTarget, "linked", [{ role: "user", text: "must not follow" }]);
    await symlink(linkedTarget, join(sessionDir, "linked.jsonl"));

    const { context, panels } = await loadPlugin(sessionDir, { id: "active" });
    try {
      await expect(panels.snapshot()).resolves.toMatchObject([
        {
          data: {
            total: 1,
            items: [{ id: "unread", message: "safe unread" }],
            inventory: {
              available: 3,
              candidates: 3,
              scanned: 3,
              unread: 1,
              shown: 1,
              truncated: false,
              discoveryTruncated: false,
              scanTruncated: false,
              displayTruncated: false,
            },
          },
        },
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("sorts candidates before applying the configured scan limit", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-limit-"));
    temporaryDirectories.push(sessionDir);
    for (const [index, id] of ["oldest", "middle", "newest"].entries()) {
      const path = join(sessionDir, `${id}.jsonl`);
      await writeSession(path, id, [{ role: "user", text: id }]);
      await utimes(path, index + 1, index + 1);
    }

    const { context, panels } = await loadPlugin(sessionDir, { id: "active" }, 1);
    try {
      await expect(panels.snapshot()).resolves.toMatchObject([
        {
          data: {
            total: 1,
            items: [{ id: "newest" }],
            inventory: { available: 3, candidates: 3, scanned: 1, scanTruncated: true, truncated: true },
            limits: {
              directoryEntries: 4_096,
              sessionBytes: 4_194_304,
              sessions: 1,
              allowedSessions: 500,
              readConcurrency: 8,
              contentParts: 1_000,
              previewCharacters: 500,
              panelItems: 50,
              sessionIdCharacters: 256,
              sessionNameCharacters: 256,
              sessionPathCharacters: 4_096,
            },
          },
        },
      ]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("declares integer config bounds and defaults non-finite runtime values", async () => {
    expect(RecallUnreadConfig.dict?.maxSessions?.meta).toMatchObject({ default: 100, min: 1, max: 500, step: 1 });
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-config-"));
    temporaryDirectories.push(sessionDir);
    const { context, panels } = await loadPlugin(sessionDir, { id: "active" }, Number.NaN, true);
    try {
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { limits: { sessions: 100 } } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("declares and enforces a descriptor-safe bounded query", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-query-"));
    temporaryDirectories.push(sessionDir);
    const { context, tools } = await loadPlugin(sessionDir, { id: "active" });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_recall_unread");
    if (tool === undefined) throw new Error("Recall Unread tool was not registered");
    let accessed = false;
    const accessor = {} as { query?: string };
    Object.defineProperty(accessor, "query", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("query getter executed");
      },
    });
    try {
      expect(tool.parameters).toMatchObject({ properties: { query: { type: "string", maxLength: 120 } } });
      await expect(tool.execute("accessor", accessor, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(tool.execute("unknown", { extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
      await expect(tool.execute("type", { query: 1 }, undefined, undefined, {} as never)).rejects.toThrow(/query.*string/iu);
      await expect(tool.execute("long", { query: "x".repeat(121) }, undefined, undefined, {} as never)).rejects.toThrow(/query.*0-120/iu);
      await expect(tool.execute("nul", { query: "safe\0hidden" }, undefined, undefined, {} as never)).rejects.toThrow(/NUL/iu);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("filters a manual rescan without narrowing cached inventory", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-filter-"));
    temporaryDirectories.push(sessionDir);
    await writeSession(join(sessionDir, "alpha.jsonl"), "alpha", [{ role: "user", text: "alpha task" }], "Alpha");
    await writeSession(join(sessionDir, "beta.jsonl"), "beta", [{ role: "user", text: "beta task" }], "Beta");
    const { context, tools, panels } = await loadPlugin(sessionDir, { id: "active" });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_recall_unread");
    if (tool === undefined) throw new Error("Recall Unread tool was not registered");
    try {
      await writeSession(join(sessionDir, "gamma.jsonl"), "gamma", [{ role: "user", text: "gamma task" }], "Gamma");
      const result = await tool.execute("rescan", { query: "gamma" }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ total: 1, items: [{ id: "gamma" }] });
      const panel = (await panels.snapshot())[0]?.data as { scans: number; total: number; items: Array<{ id: string }>; inventory: { unread: number } };
      expect(panel).toMatchObject({ scans: 2, total: 3, inventory: { unread: 3 } });
      expect(panel.items.map((item) => item.id).sort()).toEqual(["alpha", "beta", "gamma"]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("survives startup scan failure with bounded status and recovers", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-failure-"));
    temporaryDirectories.push(sessionDir);
    await writeSession(join(sessionDir, "recovered.jsonl"), "recovered", [{ role: "user", text: "retry worked" }]);
    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    let failure: Error | undefined = new Error("x".repeat(3_000));
    provideLaunchContext(context, { cwd: "/workspace", agentDir: sessionDir, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    context.provide("piSession", {
      manager: {
        getSessionDir() {
          if (failure !== undefined) {
            const current = failure;
            failure = undefined;
            throw current;
          }
          return sessionDir;
        },
        getSessionId: () => "active",
        getSessionFile: () => undefined,
        getCwd: () => "/workspace",
      },
    } as never);

    await context.plugin(recallUnread, { maxSessions: 100 });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_recall_unread");
    if (tool === undefined) throw new Error("Recall Unread tool was not registered");
    try {
      const failed = (await panels.snapshot())[0]?.data as {
        scans: number;
        status: { state: string; error: string };
        limits: { statusErrorCharacters: number };
      };
      expect(failed).toMatchObject({ scans: 0, status: { state: "failed" }, limits: { statusErrorCharacters: 2_000 } });
      expect(failed.status.error).toHaveLength(2_000);

      await expect(tool.execute("retry", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { total: 1 } });
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { scans: 1, status: { state: "completed" }, total: 1 } }]);

      let accessed = false;
      const hostile = new Error();
      delete (hostile as { message?: string }).message;
      Object.defineProperty(hostile, "message", {
        get() {
          accessed = true;
          throw new Error("error message getter executed");
        },
      });
      failure = hostile;
      await expect(tool.execute("hostile", {}, undefined, undefined, {} as never)).rejects.toBe(hostile);
      await expect(panels.snapshot()).resolves.toMatchObject([
        { data: { scans: 1, status: { state: "failed", error: "Unknown Recall Unread error" }, total: 1 } },
      ]);
      expect(accessed).toBe(false);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("honors caller and plugin cancellation without replacing scan state", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-cancel-"));
    temporaryDirectories.push(sessionDir);
    await writeSession(join(sessionDir, "unread.jsonl"), "unread", [{ role: "user", text: "keep me" }]);
    const { context, tools, panels } = await loadPlugin(sessionDir, { id: "active" });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_recall_unread");
    if (tool === undefined) throw new Error("Recall Unread tool was not registered");
    const caller = new AbortController();
    caller.abort(new Error("cancel recall scan"));

    await expect(tool.execute("cancelled", {}, caller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { scans: 1, total: 1, items: [{ id: "unread" }], status: { state: "cancelled" } } }]);

    await context.fiber.dispose();
    await expect(tool.execute("disposed", {}, undefined, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
  });

  test("isolates tool details and panel snapshots from cached state", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-snapshot-"));
    temporaryDirectories.push(sessionDir);
    await writeSession(join(sessionDir, "unread.jsonl"), "unread", [{ role: "user", text: "original" }], "Original");
    const { context, tools, panels } = await loadPlugin(sessionDir, { id: "active" });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_recall_unread");
    if (tool === undefined) throw new Error("Recall Unread tool was not registered");
    try {
      const result = await tool.execute("scan", {}, undefined, undefined, {} as never);
      (result.details as { items: Array<{ name: string; message: string }> }).items[0]!.name = "tool-mutated";
      (result.details as { items: Array<{ name: string; message: string }> }).items[0]!.message = "tool-mutated";

      const first = (await panels.snapshot())[0]?.data as {
        items: Array<{ name: string; message: string }>;
        inventory: { unread: number };
      };
      expect(first).toMatchObject({ items: [{ name: "Original", message: "original" }], inventory: { unread: 1 } });
      first.items[0]!.name = "panel-mutated";
      first.inventory.unread = 999;

      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { items: [{ name: "Original", message: "original" }], inventory: { unread: 1 } } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("excludes sessions persisted for a different workspace", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-workspace-"));
    temporaryDirectories.push(sessionDir);
    await writeSession(join(sessionDir, "local.jsonl"), "local", [{ role: "user", text: "local task" }]);
    await writeSession(join(sessionDir, "foreign.jsonl"), "foreign", [{ role: "user", text: "foreign task" }], undefined, "/other-workspace");

    const { context, panels } = await loadPlugin(sessionDir, { id: "active" });
    try {
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { total: 1, items: [{ id: "local" }] } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("bounds tool and panel results while preserving total inventory", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-results-"));
    temporaryDirectories.push(sessionDir);
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        writeSession(join(sessionDir, `${String(index).padStart(3, "0")}.jsonl`), `session-${index}`, [{ role: "user", text: `task ${index}` }]),
      ),
    );
    const { context, tools, panels } = await loadPlugin(sessionDir, { id: "active" }, 150);
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_recall_unread");
    if (tool === undefined) throw new Error("Recall Unread tool was not registered");
    try {
      const result = await tool.execute("scan", {}, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({
        total: 101,
        inventory: { available: 101, scanned: 101, unread: 101, matched: 101, shown: 100, resultTruncated: true, truncated: true },
      });
      expect((result.details as { items: unknown[] }).items).toHaveLength(100);

      const panel = (await panels.snapshot())[0]?.data as { total: number; items: unknown[]; inventory: { shown: number; displayTruncated: boolean } };
      expect(panel).toMatchObject({ total: 101, inventory: { shown: 50, displayTruncated: true } });
      expect(panel.items).toHaveLength(50);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("excludes the active runtime manager after session replacement", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-runtime-"));
    temporaryDirectories.push(sessionDir);
    const activePath = join(sessionDir, "active.jsonl");
    await writeSession(activePath, "active", [{ role: "user", text: "current runtime question" }]);
    const { context, tools, panels } = await loadPlugin(sessionDir, { id: "stale" });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_recall_unread");
    if (tool === undefined) throw new Error("Recall Unread tool was not registered");
    context.provide("piRuntime", {
      session: {
        sessionManager: {
          getSessionDir: () => sessionDir,
          getSessionId: () => "active",
          getSessionFile: () => activePath,
          getCwd: () => "/workspace",
        },
      },
    } as never);
    try {
      await expect(tool.execute("rescan", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { total: 0, items: [] } });
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { scans: 2, total: 0, items: [] } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("follows the active runtime workspace after session replacement", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-runtime-cwd-"));
    temporaryDirectories.push(sessionDir);
    await writeSession(join(sessionDir, "original.jsonl"), "original", [{ role: "user", text: "original workspace" }]);
    await writeSession(join(sessionDir, "resumed.jsonl"), "resumed", [{ role: "user", text: "resumed workspace" }], undefined, "/resumed-workspace");
    const { context, tools } = await loadPlugin(sessionDir, { id: "stale" });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_recall_unread");
    if (tool === undefined) throw new Error("Recall Unread tool was not registered");
    context.provide("piRuntime", {
      session: {
        sessionManager: {
          getSessionDir: () => sessionDir,
          getSessionId: () => "active",
          getSessionFile: () => undefined,
          getCwd: () => "/resumed-workspace",
        },
      },
    } as never);
    try {
      await expect(tool.execute("rescan", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { total: 1, items: [{ id: "resumed", cwd: "/resumed-workspace" }] },
      });
    } finally {
      await context.fiber.dispose();
    }
  });

  test.each(["id", "path", "cwd", "manager"])("rejects a %s switch during discovery without publishing mixed inventory", async (field) => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-switch-"));
    temporaryDirectories.push(sessionDir);
    await writeSession(join(sessionDir, "unread.jsonl"), "unread", [{ role: "user", text: "keep previous scan" }]);
    const active: { id: string; path?: string } = { id: "original" };
    const { context, tools, panels } = await loadPlugin(sessionDir, active);
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_recall_unread");
    if (tool === undefined) throw new Error("Recall Unread tool was not registered");
    vi.spyOn(context.piSession.manager, "getSessionDir").mockImplementationOnce(() => {
      queueMicrotask(() => {
        if (field === "id") active.id = "replacement";
        else if (field === "path") active.path = join(sessionDir, "replacement.jsonl");
        else if (field === "cwd") vi.spyOn(context.piSession.manager, "getCwd").mockReturnValue("/replacement");
        else
          context.provide("piRuntime", {
            session: {
              sessionManager: {
                getSessionDir: () => sessionDir,
                getSessionId: () => "replacement",
                getSessionFile: () => undefined,
                getCwd: () => "/workspace",
              },
            },
          } as never);
      });
      return sessionDir;
    });
    try {
      await expect(tool.execute("switch", {}, undefined, undefined, {} as never)).rejects.toThrow(/session changed/iu);
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { scans: 1, total: 1, status: { state: "failed" } } }]);
      await expect(tool.execute("retry", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { total: field === "cwd" ? 0 : 1 } });
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { scans: 2, status: { state: "completed" } } }]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("commits concurrent rescans in invocation order", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-recall-unread-order-"));
    temporaryDirectories.push(root);
    const initialDir = join(root, "initial");
    const slowDir = join(root, "slow");
    const latestDir = join(root, "latest");
    await Promise.all([mkdir(initialDir), mkdir(slowDir), mkdir(latestDir)]);
    for (let offset = 0; offset < 4_096; offset += 256) {
      await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(join(slowDir, `${String(offset + index).padStart(4, "0")}.jsonl`), "", "utf8")));
    }
    await writeFile(join(slowDir, "overflow.jsonl"), "", "utf8");
    await writeSession(join(latestDir, "latest.jsonl"), "latest", [{ role: "user", text: "latest invocation" }]);

    const context = new Context();
    const tools = new PiToolRegistry();
    const panels = new PiPluginUiRegistry();
    const directories = [initialDir, slowDir, latestDir];
    let directoryCalls = 0;
    provideLaunchContext(context, { cwd: "/workspace", agentDir: root, args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    context.provide("piSession", {
      manager: {
        getSessionDir: () => directories[Math.min(directoryCalls++, directories.length - 1)]!,
        getSessionId: () => "active",
        getSessionFile: () => undefined,
        getCwd: () => "/workspace",
      },
    } as never);
    await context.plugin(recallUnread, { maxSessions: 1 });
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_recall_unread");
    if (tool === undefined) throw new Error("Recall Unread tool was not registered");
    try {
      const first = tool.execute("first", {}, undefined, undefined, {} as never);
      await waitForCondition(() => directoryCalls === 2, "the first rescan to enter directory discovery");
      const second = tool.execute("second", {}, undefined, undefined, {} as never);
      await waitForCondition(() => directoryCalls === 3, "the second rescan to enter directory discovery");
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.details).toMatchObject({
        total: 0,
        inventory: { available: 4_096, candidates: 4_096, discoveryTruncated: true, truncated: true },
      });
      expect(secondResult.details).toMatchObject({ total: 1, items: [{ id: "latest" }] });
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { scans: 3, total: 1, items: [{ id: "latest" }] } }]);
    } finally {
      await context.fiber.dispose();
    }
  }, 30_000);
});
