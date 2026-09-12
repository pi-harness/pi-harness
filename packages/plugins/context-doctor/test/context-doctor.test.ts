import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test, vi } from "vitest";
import contextDoctorPlugin, { inspectMessages } from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, tryAcquireSessionCompaction } from "@pi-harness/plugin-api";

async function createDoctor(session: unknown, config = { warnPercent: 75, maxMessageBytes: 64 * 1024 }) {
  if (session !== null && typeof session === "object") {
    if (!("sessionId" in session)) Object.defineProperty(session, "sessionId", { configurable: true, value: "session-1", writable: true });
    if (!("subscribe" in session)) Object.defineProperty(session, "subscribe", { value: () => () => undefined });
  }
  const context = new Context();
  const panels = new PiPluginUiRegistry();
  const tools = new PiToolRegistry();
  context.provide("piRuntime", { session } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(contextDoctorPlugin, config);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "context_doctor");
  if (tool === undefined) throw new Error("context_doctor was not registered");
  return { context, panels, tool, tools };
}

describe("context doctor", () => {
  test("reports pressure, oversized messages, and tool errors", () => {
    const report = inspectMessages(
      [
        { role: "user", content: "ok" },
        { role: "user", content: "x".repeat(200) },
        { role: "toolResult", isError: true },
      ],
      { percent: 82, tokens: 820, contextWindow: 1000 },
      75,
      100,
    );
    expect(report).toMatchObject({
      status: "warning",
      usagePercent: 82,
      tokens: 820,
      contextWindow: 1000,
      messageCount: 3,
      oversizedMessages: 1,
      toolErrors: 1,
    });
    expect(report.recommendations).toHaveLength(3);
  });

  test("stays healthy when usage and messages are within limits", () => {
    const report = inspectMessages([{ role: "user", content: "short" }], { percent: 20, tokens: 20, contextWindow: 1000 }, 75, 1024);
    expect(report).toMatchObject({ status: "ok", usagePercent: 20, messageCount: 1, oversizedMessages: 0, toolErrors: 0, recommendations: [] });
  });

  test("warns when context usage exceeds one hundred percent", () => {
    expect(inspectMessages([], { percent: 125, tokens: 10_000, contextWindow: 8_000 }, 75, 1_024)).toMatchObject({
      status: "warning",
      usagePercent: 125,
      tokens: 10_000,
      contextWindow: 8_000,
    });
  });

  test("keeps audits available when upstream context estimation throws", async () => {
    const fixture = await createDoctor({
      messages: [{ role: "user", content: "safe" }],
      getContextUsage() {
        throw new TypeError("invalid assistant usage");
      },
      isIdle: true,
      compact: () => Promise.resolve(),
    });
    try {
      await expect(fixture.tool.execute("audit", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { usagePercent: null, tokens: null, contextWindow: null, messageCount: 1 },
      });
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { messageCount: 1 } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("measures exact JSON byte boundaries and fails closed for uninspectable values", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(inspectMessages(["x".repeat(1_022)], undefined, 75, 1_024)).toMatchObject({ oversizedMessages: 0 });
    expect(inspectMessages(["x".repeat(1_023), cyclic], undefined, 75, 1_024)).toMatchObject({ oversizedMessages: 2, uninspectableMessages: 1 });
  });

  test("does not execute message, array-index, toJSON, or usage accessors while auditing", () => {
    let accesses = 0;
    const accessorMessage = { role: "user" };
    Object.defineProperty(accessorMessage, "content", {
      enumerable: true,
      get() {
        accesses += 1;
        throw new Error("message getter executed");
      },
    });
    const toJsonMessage = {
      role: "user",
      toJSON() {
        accesses += 1;
        throw new Error("message toJSON executed");
      },
    };
    const messages = [accessorMessage, toJsonMessage, { role: "toolResult", isError: true }, undefined] as unknown[];
    Object.defineProperty(messages, "3", {
      enumerable: true,
      get() {
        accesses += 1;
        throw new Error("message array getter executed");
      },
    });
    const usage = {} as { percent?: number; tokens?: number; contextWindow?: number };
    for (const key of ["percent", "tokens", "contextWindow"] as const) {
      Object.defineProperty(usage, key, {
        enumerable: true,
        get() {
          accesses += 1;
          throw new Error(`usage ${key} getter executed`);
        },
      });
    }

    expect(() => inspectMessages(messages, usage, 75, 1_024)).not.toThrow();
    expect(inspectMessages(messages, usage, 75, 1_024)).toMatchObject({
      usagePercent: null,
      tokens: null,
      contextWindow: null,
      messageCount: 4,
      oversizedMessages: 3,
      uninspectableMessages: 3,
      toolErrors: 1,
    });
    expect(accesses).toBe(0);
  });

  test("audits proxied message arrays without invoking property reads", () => {
    let propertyRead = false;
    const messages = new Proxy([{ role: "user", content: "safe" }], {
      get() {
        propertyRead = true;
        throw new Error("message array property read executed");
      },
    });

    expect(() => inspectMessages(messages, undefined, 75, 1_024)).not.toThrow();
    expect(inspectMessages(messages, undefined, 75, 1_024)).toMatchObject({
      messageCount: 1,
      scannedMessages: 1,
      oversizedMessages: 0,
      uninspectableMessages: 0,
    });
    expect(propertyRead).toBe(false);
  });

  test("fails closed without invoking inherited custom array serialization", () => {
    let accessed = false;
    const message = ["safe"];
    Object.setPrototypeOf(message, {
      toJSON() {
        accessed = true;
        throw new Error("inherited array toJSON executed");
      },
    });

    expect(inspectMessages([message], undefined, 75, 1_024)).toMatchObject({ oversizedMessages: 1, uninspectableMessages: 1 });
    expect(accessed).toBe(false);
  });

  test("fails closed when a message exceeds structural depth or node limits", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 65; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const tooManyNodes = Array.from({ length: 10_001 }, () => null);

    expect(inspectMessages([deep, tooManyNodes], undefined, 75, 1024 * 1024)).toMatchObject({
      oversizedMessages: 2,
      uninspectableMessages: 2,
    });
  });

  test("bounds total structural work across one audit", () => {
    const messages = Array.from({ length: 101 }, () => Array.from({ length: 1_000 }, () => null));
    expect(inspectMessages(messages, undefined, 75, 1024 * 1024)).toMatchObject({
      scannedMessages: 101,
      oversizedMessages: 2,
      uninspectableMessages: 2,
    });
  });

  test("bounds message scanning and normalizes invalid usage metrics", () => {
    const messages = [
      { role: "toolResult", isError: true, content: "x".repeat(2_000) },
      ...Array.from({ length: 10_000 }, () => ({ role: "user", content: "ok" })),
    ];
    expect(inspectMessages(messages, { percent: Number.NaN, tokens: -1, contextWindow: Number.POSITIVE_INFINITY }, 75, 1_024)).toMatchObject({
      status: "ok",
      usagePercent: null,
      tokens: null,
      contextWindow: null,
      messageCount: 10_001,
      scannedMessages: 10_000,
      messagesTruncated: true,
      oversizedMessages: 0,
      toolErrors: 0,
    });
  });

  test("accepts exact scan and config boundaries", async () => {
    const messages = Array.from({ length: 10_000 }, () => ({ role: "user", content: "ok" }));
    const fixture = await createDoctor(
      { messages, getContextUsage: () => ({ percent: 1, tokens: 0, contextWindow: 1 }), compact: () => Promise.resolve() },
      { warnPercent: 1, maxMessageBytes: 1_024 },
    );
    try {
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        {
          data: {
            messageCount: 10_000,
            scannedMessages: 10_000,
            messagesTruncated: false,
            warnPercent: 1,
            maxMessageBytes: 1_024,
            limits: { scannedMessages: 10_000, jsonDepth: 64, jsonNodesPerMessage: 10_000, jsonNodesPerAudit: 100_000, errorCharacters: 2_000 },
          },
        },
      ]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("audits at startup and serves repeated panel reads from a refreshed cache", async () => {
    let messageReads = 0;
    let usageReads = 0;
    const session = {
      get messages() {
        messageReads += 1;
        return [{ role: "user", content: "cached" }];
      },
      getContextUsage: () => {
        usageReads += 1;
        return { percent: 20, tokens: 20, contextWindow: 100 };
      },
      compact: () => Promise.resolve(),
      abortCompaction: () => undefined,
    };
    const fixture = await createDoctor(session);
    try {
      expect(messageReads).toBe(1);
      expect(usageReads).toBe(1);
      await fixture.panels.snapshot();
      await fixture.panels.snapshot();
      expect(messageReads).toBe(1);
      expect(usageReads).toBe(1);

      fixture.context.emit("pi/session-event", { type: "message_end" } as never);
      expect(messageReads).toBe(2);
      expect(usageReads).toBe(2);
      await fixture.panels.snapshot();
      expect(messageReads).toBe(2);
      expect(usageReads).toBe(2);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("ignores malformed session event type accessors without executing them", async () => {
    let accessed = false;
    const event = {};
    Object.defineProperty(event, "type", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("event type getter executed");
      },
    });
    const fixture = await createDoctor({ messages: [], getContextUsage: () => undefined, compact: () => Promise.resolve() });
    try {
      expect(() => fixture.context.emit("pi/session-event", event as never)).not.toThrow();
      expect(accessed).toBe(false);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("validates raw tool parameters before compacting", async () => {
    let compacted = 0;
    let accessed = false;
    const fixture = await createDoctor({
      messages: [],
      getContextUsage: () => undefined,
      compact: () => {
        compacted += 1;
        return Promise.resolve();
      },
    });
    const accessor = {} as { compact?: boolean };
    Object.defineProperty(accessor, "compact", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("compact getter executed");
      },
    });
    const symbolProperty = {} as Record<PropertyKey, unknown>;
    symbolProperty[Symbol("unexpected")] = true;
    try {
      expect(fixture.tool.parameters).toMatchObject({ additionalProperties: false });
      expect(fixture.tool.description).toMatch(/queued.*agent.*settled/iu);
      expect(fixture.tool.promptGuidelines?.join(" ")).toMatch(/confirm.*model.*cost/iu);
      await expect(fixture.tool.execute("null", null, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*object/iu);
      await expect(fixture.tool.execute("array", [], undefined, undefined, {} as never)).rejects.toThrow(/parameters.*object/iu);
      await expect(fixture.tool.execute("date", new Date(), undefined, undefined, {} as never)).rejects.toThrow(/parameters.*plain object/iu);
      await expect(fixture.tool.execute("accessor", accessor, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      await expect(fixture.tool.execute("unknown", { unexpected: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
      await expect(fixture.tool.execute("symbol", symbolProperty, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
      await expect(fixture.tool.execute("compact", { compact: "yes" }, undefined, undefined, {} as never)).rejects.toThrow(/compact must be a boolean/iu);
      await expect(fixture.tool.execute("confirm", { confirm: 1 }, undefined, undefined, {} as never)).rejects.toThrow(/confirm must be a boolean/iu);
      await expect(fixture.tool.execute("missing", { compact: true }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
      expect(accessed).toBe(false);
      expect(compacted).toBe(0);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("queues compaction requested by an active agent run until the agent settles", async () => {
    let compactions = 0;
    const fixture = await createDoctor({
      isIdle: false,
      messages: [],
      getContextUsage: () => undefined,
      compact: () => {
        compactions += 1;
        return Promise.resolve();
      },
      abortCompaction: () => undefined,
    });
    try {
      await expect(fixture.tool.execute("queued", { compact: true, confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { compacted: false, compaction: { status: "queued" } },
      });
      expect(compactions).toBe(0);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { compaction: { status: "queued" } } }]);

      fixture.context.emit("pi/session-event", { type: "agent_settled" });
      await expect.poll(() => compactions).toBe(1);
      await expect.poll(async () => (await fixture.panels.snapshot())[0]?.data).toMatchObject({ compaction: { status: "completed" } });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels a queued compaction when its caller aborts before the agent settles", async () => {
    let compactions = 0;
    const fixture = await createDoctor({
      isIdle: false,
      messages: [],
      getContextUsage: () => undefined,
      compact: () => {
        compactions += 1;
        return Promise.resolve();
      },
      abortCompaction: () => undefined,
    });
    const controller = new AbortController();
    try {
      await expect(fixture.tool.execute("queued", { compact: true, confirm: true }, controller.signal, undefined, {} as never)).resolves.toMatchObject({
        details: { compaction: { status: "queued" } },
      });
      controller.abort(new Error("caller stopped queued compaction"));
      await expect.poll(async () => (await fixture.panels.snapshot())[0]?.data).toMatchObject({ compaction: { status: "cancelled" } });

      fixture.context.emit("pi/session-event", { type: "agent_settled" });
      await Promise.resolve();
      expect(compactions).toBe(0);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels a queued compaction instead of applying it to a replacement session", async () => {
    let oldCompactions = 0;
    let replacementCompactions = 0;
    const fixture = await createDoctor({
      isIdle: false,
      messages: [],
      getContextUsage: () => undefined,
      compact: () => {
        oldCompactions += 1;
        return Promise.resolve();
      },
      abortCompaction: () => undefined,
    });
    try {
      await fixture.tool.execute("queued", { compact: true, confirm: true }, undefined, undefined, {} as never);
      fixture.context.reflect.set("piRuntime", {
        session: {
          sessionId: "session-2",
          isIdle: true,
          messages: [],
          getContextUsage: () => undefined,
          compact: () => {
            replacementCompactions += 1;
            return Promise.resolve();
          },
          abortCompaction: () => undefined,
        },
      });
      let panel = (await fixture.panels.snapshot())[0]?.data as { compaction: { status: string; error: string } };
      expect(panel.compaction.status).toBe("idle");
      fixture.context.emit("pi/session-event", { type: "agent_settled" });
      await expect.poll(async () => ((await fixture.panels.snapshot())[0]?.data as { compaction: { status: string } }).compaction.status).toBe("idle");
      panel = (await fixture.panels.snapshot())[0]?.data as { compaction: { status: string; error: string } };
      expect(panel.compaction.error).toBeUndefined();
      expect(oldCompactions).toBe(0);
      expect(replacementCompactions).toBe(0);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("keeps audit and compaction state scoped to the active session", async () => {
    const first = {
      sessionId: "session-1",
      isIdle: true,
      messages: [{ role: "user", content: "first" }],
      getContextUsage: () => ({ percent: 80, tokens: 80, contextWindow: 100 }),
      compact: () => Promise.resolve(),
      abortCompaction: () => undefined,
    };
    const fixture = await createDoctor(first);
    try {
      await fixture.tool.execute("compact-first", { compact: true, confirm: true }, undefined, undefined, {} as never);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        { data: { sessionId: "session-1", messageCount: 1, compaction: { status: "completed" } } },
      ]);

      const second = {
        sessionId: "session-2",
        isIdle: true,
        messages: [],
        getContextUsage: () => ({ percent: 0, tokens: 0, contextWindow: 100 }),
        compact: () => Promise.resolve(),
        abortCompaction: () => undefined,
        subscribe: () => () => undefined,
      };
      fixture.context.reflect.set("piRuntime", { session: second });

      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { sessionId: "session-2", messageCount: 0, compaction: { status: "idle" } } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels queued compaction when one runtime object receives a new session ID", async () => {
    let compactions = 0;
    const session = {
      sessionId: "session-1",
      isIdle: false,
      messages: [],
      getContextUsage: () => undefined,
      compact: () => {
        compactions += 1;
        return Promise.resolve();
      },
      abortCompaction: () => undefined,
    };
    const fixture = await createDoctor(session);
    try {
      await fixture.tool.execute("queued", { compact: true, confirm: true }, undefined, undefined, {} as never);
      session.sessionId = "session-2";
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { sessionId: "session-2", messageCount: 0, compaction: { status: "idle" } } }]);
      session.isIdle = true;
      fixture.context.emit("pi/session-event", { type: "agent_settled" });
      await Promise.resolve();
      expect(compactions).toBe(0);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels an old in-flight compaction without contaminating the replacement session", async () => {
    let rejectOld!: (error: Error) => void;
    const oldAbort = vi.fn(() => rejectOld(new Error("old session compaction aborted")));
    const first = {
      sessionId: "session-1",
      isIdle: true,
      messages: [{ role: "user", content: "first" }],
      getContextUsage: () => ({ percent: 80 }),
      compact: () =>
        new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        }),
      abortCompaction: oldAbort,
    };
    const fixture = await createDoctor(first);
    const execution = fixture.tool.execute("compact-old", { compact: true, confirm: true }, undefined, undefined, {} as never);
    try {
      await vi.waitFor(() => expect(rejectOld).toBeDefined());
      fixture.context.reflect.set("piRuntime", {
        session: {
          sessionId: "session-2",
          isIdle: true,
          messages: [],
          getContextUsage: () => ({ percent: 0 }),
          compact: () => Promise.resolve(),
          abortCompaction: () => undefined,
          subscribe: () => () => undefined,
        },
      });

      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { sessionId: "session-2", messageCount: 0, compaction: { status: "idle" } } }]);
      await expect(execution).rejects.toThrow(/session changed/iu);
      expect(oldAbort).toHaveBeenCalledTimes(1);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { sessionId: "session-2", messageCount: 0, compaction: { status: "idle" } } }]);
    } finally {
      rejectOld?.(new Error("test cleanup"));
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects late success when the session changes without an intermediate panel read", async () => {
    let resolveOld!: () => void;
    const first = {
      sessionId: "session-1",
      isIdle: true,
      messages: [],
      getContextUsage: () => undefined,
      compact: () =>
        new Promise<void>((resolve) => {
          resolveOld = resolve;
        }),
      abortCompaction: () => undefined,
    };
    const fixture = await createDoctor(first);
    const execution = fixture.tool.execute("compact-old", { compact: true, confirm: true }, undefined, undefined, {} as never);
    try {
      await vi.waitFor(() => expect(resolveOld).toBeDefined());
      fixture.context.reflect.set("piRuntime", {
        session: {
          sessionId: "session-2",
          isIdle: true,
          messages: [],
          getContextUsage: () => undefined,
          compact: () => Promise.resolve(),
          abortCompaction: () => undefined,
          subscribe: () => () => undefined,
        },
      });
      resolveOld();

      await expect(execution).rejects.toThrow(/session changed/iu);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { sessionId: "session-2", compaction: { status: "idle" } } }]);
    } finally {
      resolveOld?.();
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels an in-flight compaction and invalidates retained tools on disposal", async () => {
    let compactionAborts = 0;
    let agentAborts = 0;
    let rejectCompact: ((error: Error) => void) | undefined;
    const fixture = await createDoctor({
      messages: [],
      getContextUsage: () => undefined,
      compact: () =>
        new Promise((_resolve, reject) => {
          rejectCompact = reject;
        }),
      abortCompaction: () => {
        compactionAborts += 1;
        rejectCompact?.(new Error("session compaction aborted"));
      },
      abort: () => {
        agentAborts += 1;
        return Promise.resolve();
      },
    });
    const controller = new AbortController();
    try {
      const execution = fixture.tool.execute("compact", { compact: true, confirm: true }, controller.signal, undefined, {} as never);
      await vi.waitFor(() => expect(rejectCompact).toBeDefined());
      controller.abort(new Error("caller cancelled compaction"));
      await expect(execution).rejects.toThrow(/caller cancelled compaction/iu);
      expect(compactionAborts).toBe(1);
      expect(agentAborts).toBe(0);
      await expect.poll(async () => (await fixture.panels.snapshot())[0]?.data).toMatchObject({ compaction: { status: "cancelled" } });

      const retained = fixture.tool;
      await fixture.context.fiber.dispose();
      expect(fixture.tools.snapshot().customTools).toEqual([]);
      await expect(fixture.panels.snapshot()).resolves.toEqual([]);
      await expect(retained.execute("stale", {}, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
    } finally {
      rejectCompact?.(new Error("test cleanup"));
      await fixture.context.fiber.dispose();
    }
  });

  test("reapplies cancellation after the SDK initializes its compaction controller", async () => {
    let listener: ((event: { type: string }) => void) | undefined;
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    let compactStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      compactStarted = resolve;
    });
    let ready = false;
    let aborted = false;
    let completed = 0;
    const unsubscribe = vi.fn();
    const abortCompaction = vi.fn(() => {
      if (ready) aborted = true;
    });
    const fixture = await createDoctor({
      messages: [],
      getContextUsage: () => undefined,
      isIdle: true,
      subscribe: (callback: typeof listener) => {
        listener = callback;
        return unsubscribe;
      },
      compact: async () => {
        compactStarted();
        await initializationGate;
        ready = true;
        listener?.({ type: "compaction_start" });
        if (aborted) throw new Error("native compaction cancelled");
        completed += 1;
      },
      abortCompaction,
    });
    const controller = new AbortController();
    const execution = fixture.tool.execute("late-controller", { compact: true, confirm: true }, controller.signal, undefined, {} as never);
    try {
      await started;
      controller.abort(new Error("caller cancelled during initialization"));
      await expect(execution).rejects.toThrow("caller cancelled during initialization");
      releaseInitialization();
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
      expect(abortCompaction).toHaveBeenCalledTimes(2);
      expect(completed).toBe(0);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { compaction: { status: "cancelled" } } }]);
    } finally {
      releaseInitialization();
      await fixture.context.fiber.dispose();
    }
  });

  test("rolls back the tool when panel registration fails", async () => {
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    context.provide("piRuntime", {
      session: { sessionId: "session-1", messages: [], getContextUsage: () => undefined, isIdle: true, compact: () => Promise.resolve() },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    const disposeDuplicate = panels.register({
      id: "context-doctor-panel",
      pluginId: "duplicate",
      title: "Duplicate",
      read: () => ({}),
    });
    try {
      await expect(context.plugin(contextDoctorPlugin)).rejects.toThrow(/already registered/iu);
      expect(tools.snapshot().customTools).toEqual([]);
    } finally {
      disposeDuplicate();
      await context.fiber.dispose();
    }
  });

  test("rejects unknown configuration keys before registration", async () => {
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    context.provide("piRuntime", {
      session: { sessionId: "session-1", messages: [], getContextUsage: () => undefined, isIdle: true, compact: () => Promise.resolve() },
    } as never);
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    try {
      await expect(context.plugin(contextDoctorPlugin, { unexpected: true } as never)).rejects.toThrow(/unknown/iu);
      expect(tools.snapshot().customTools).toEqual([]);
      await expect(panels.snapshot()).resolves.toEqual([]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("records bounded compaction failures without invoking hostile error accessors", async () => {
    let accessed = false;
    const hostile = new Error();
    Object.defineProperty(hostile, "message", {
      get() {
        accessed = true;
        throw new Error("error message getter executed");
      },
    });
    let attempt = 0;
    const fixture = await createDoctor({
      messages: [],
      getContextUsage: () => undefined,
      compact: () => Promise.reject(++attempt === 1 ? new Error("x".repeat(3_000)) : hostile),
      abortCompaction: () => undefined,
    });
    try {
      await expect(fixture.tool.execute("long", { compact: true, confirm: true }, undefined, undefined, {} as never)).rejects.toThrow();
      let panel = (await fixture.panels.snapshot())[0]?.data as { compaction: { status: string; error: string } };
      expect(panel.compaction.status).toBe("failed");
      expect(panel.compaction.error).toHaveLength(2_000);

      await expect.poll(async () => (await fixture.panels.snapshot())[0]?.data).toMatchObject({ compaction: { status: "failed" } });
      await expect(fixture.tool.execute("hostile", { compact: true, confirm: true }, undefined, undefined, {} as never)).rejects.toBe(hostile);
      panel = (await fixture.panels.snapshot())[0]?.data as { compaction: { status: string; error: string } };
      expect(panel.compaction).toMatchObject({ status: "failed", error: "Unknown context compaction error" });
      expect(accessed).toBe(false);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("publishes request, start, and finish timestamps for completed compactions", async () => {
    const fixture = await createDoctor({
      messages: [],
      getContextUsage: () => undefined,
      compact: () => Promise.resolve(),
      abortCompaction: () => undefined,
    });
    try {
      const result = await fixture.tool.execute("timed", { compact: true, confirm: true }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ compacted: true, compaction: { status: "completed" } });
      const state = (result.details as { compaction: { requestedAt: string; startedAt: string; finishedAt: string } }).compaction;
      expect(new Date(state.requestedAt).toISOString()).toBe(state.requestedAt);
      expect(new Date(state.startedAt).toISOString()).toBe(state.startedAt);
      expect(new Date(state.finishedAt).toISOString()).toBe(state.finishedAt);
      expect(Date.parse(state.requestedAt)).toBeLessThanOrEqual(Date.parse(state.startedAt));
      expect(Date.parse(state.startedAt)).toBeLessThanOrEqual(Date.parse(state.finishedAt));
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not expose mutable audit or compaction state through tool and panel snapshots", async () => {
    const fixture = await createDoctor({
      messages: [{ role: "toolResult", isError: true }],
      getContextUsage: () => ({ percent: 90, tokens: 90, contextWindow: 100 }),
      compact: () => Promise.resolve(),
      abortCompaction: () => undefined,
    });
    try {
      const result = await fixture.tool.execute("audit", {}, undefined, undefined, {} as never);
      const toolDetails = result.details as { recommendations: string[]; compaction: { status: string } };
      toolDetails.recommendations[0] = "mutated tool recommendation";
      toolDetails.compaction.status = "failed";

      const first = (await fixture.panels.snapshot())[0]?.data as { recommendations: string[]; compaction: { status: string } };
      expect(first.recommendations[0]).not.toBe("mutated tool recommendation");
      expect(first.compaction.status).toBe("idle");
      first.recommendations[0] = "mutated panel recommendation";
      first.compaction.status = "failed";

      const second = (await fixture.panels.snapshot())[0]?.data as { recommendations: string[]; compaction: { status: string } };
      expect(second.recommendations[0]).not.toMatch(/mutated/iu);
      expect(second.compaction.status).toBe("idle");
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("lets a caller stop waiting without claiming a late successful compaction was cancelled", async () => {
    let resolveCompact: (() => void) | undefined;
    let abortRequests = 0;
    const fixture = await createDoctor({
      messages: [],
      getContextUsage: () => undefined,
      compact: () =>
        new Promise<void>((resolve) => {
          resolveCompact = resolve;
        }),
      abortCompaction: () => {
        abortRequests += 1;
      },
    });
    const controller = new AbortController();
    const execution = fixture.tool.execute("compact", { compact: true, confirm: true }, controller.signal, undefined, {} as never);
    try {
      await vi.waitFor(() => expect(resolveCompact).toBeDefined());
      controller.abort(new Error("caller stopped waiting"));
      await expect(execution).rejects.toThrow(/caller stopped waiting/iu);
      expect(abortRequests).toBe(1);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { compaction: { status: "running" } } }]);

      resolveCompact?.();
      await expect.poll(async () => (await fixture.panels.snapshot())[0]?.data).toMatchObject({ compaction: { status: "completed" } });
    } finally {
      resolveCompact?.();
      await execution.catch(() => undefined);
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects overlapping compactions instead of building an implicit promise queue", async () => {
    const resolvers: Array<() => void> = [];
    const fixture = await createDoctor({
      messages: [],
      getContextUsage: () => undefined,
      compact: () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
      abort: () => Promise.resolve(),
    });
    const controller = new AbortController();
    const first = fixture.tool.execute("first", { compact: true, confirm: true }, undefined, undefined, {} as never);
    try {
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));
      const second = fixture.tool.execute("second", { compact: true, confirm: true }, controller.signal, undefined, {} as never);
      controller.abort(new Error("overlap test cleanup"));
      await expect(second).rejects.toThrow(/compaction.*already.*progress/iu);
      expect(resolvers).toHaveLength(1);
      resolvers[0]?.();
      await first;
    } finally {
      resolvers.forEach((resolve) => resolve());
      await first.catch(() => undefined);
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects a compaction already owned by another plugin", async () => {
    const compact = vi.fn().mockResolvedValue(undefined);
    const session = { messages: [], getContextUsage: () => undefined, isIdle: true, isCompacting: false, compact };
    const fixture = await createDoctor(session);
    const release = tryAcquireSessionCompaction(session);
    expect(release).toEqual(expect.any(Function));
    try {
      await expect(fixture.tool.execute("shared-lock", { compact: true, confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
        /already.*progress/iu,
      );
      expect(compact).not.toHaveBeenCalled();
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        { data: { compaction: { status: "failed", error: "A context compaction is already in progress" } } },
      ]);
    } finally {
      release?.();
    }
    try {
      await expect(fixture.tool.execute("after-shared-lock", { compact: true, confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { compaction: { status: "completed" } },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });
});
