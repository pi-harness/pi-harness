import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import sessionInsightsPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, tryAcquireSessionCompaction } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

function stats(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionFile: undefined,
    sessionId: "session-1",
    userMessages: 2,
    assistantMessages: 2,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 5,
    tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, total: 35 },
    cost: 0.012_345,
    contextUsage: { tokens: 250, contextWindow: 1_000, percent: 25 },
    ...overrides,
  };
}

async function fixture(session: unknown = { isIdle: true, getSessionStats: () => stats(), compact: () => Promise.resolve() }) {
  if (session !== null && typeof session === "object" && !("subscribe" in session))
    Object.defineProperty(session, "subscribe", { value: () => () => undefined });
  const context = new Context();
  contexts.push(context);
  const panels = new PiPluginUiRegistry();
  const tools = new PiToolRegistry();
  context.provide("piRuntime", { session } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(sessionInsightsPlugin);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_report");
  if (tool === undefined) throw new Error("session_report was not registered");
  return { context, panels, tool, tools };
}

describe("session-insights", () => {
  test("declares a strict sequential report and confirmed-compaction contract", async () => {
    const { tool } = await fixture();

    expect(sessionInsightsPlugin).toHaveProperty("Config");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { compact: { type: "boolean" }, confirm: { type: "boolean" } },
    });
    expect(tool.promptGuidelines?.join(" ")).toMatch(/confirm.*model.*usage.*cost/iu);
  });

  test("rejects malformed raw parameters without invoking accessors", async () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "compact", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    const withSymbol = { [Symbol("extra")]: true };
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const hostile = new Error();
    Object.defineProperty(hostile, "message", {
      get() {
        getterCalls += 1;
        throw new Error("error message getter executed");
      },
    });
    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw hostile;
        },
      },
    );
    const { tool } = await fixture();

    for (const parameters of [null, [], new Date(), { compact: "yes" }, { confirm: 1 }, { extra: true }, withSymbol, accessor]) {
      await expect(tool.execute("invalid", parameters as never, undefined, undefined, {} as never)).rejects.toThrow(/session report parameters/iu);
    }
    await expect(tool.execute("proxy", revocable.proxy, undefined, undefined, {} as never)).rejects.toThrow(/inspected safely/iu);
    await expect(tool.execute("throwing-proxy", throwingProxy, undefined, undefined, {} as never)).rejects.toThrow(/inspected safely/iu);
    await expect(tool.execute("unconfirmed", { compact: true }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    expect(getterCalls).toBe(0);
  });

  test("rejects unknown configuration before registering any surface", async () => {
    const context = new Context();
    contexts.push(context);
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);

    await expect(context.plugin(sessionInsightsPlugin, { unexpected: true })).rejects.toThrow(/unknown.*session-insights.*config/iu);
    expect(() => sessionInsightsPlugin.apply(context, { [Symbol("unexpected")]: true })).toThrow(/unknown.*session-insights.*config/iu);
    let getterCalls = 0;
    const hostile = new Error();
    Object.defineProperty(hostile, "message", {
      get() {
        getterCalls += 1;
        throw new Error("config error message getter executed");
      },
    });
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw hostile;
        },
      },
    );
    expect(() => sessionInsightsPlugin.apply(context, throwingProxy)).toThrow(/config could not be inspected safely/iu);
    expect(getterCalls).toBe(0);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("validates and detaches complete session statistics", async () => {
    const source = stats();
    const { panels, tool } = await fixture({ isIdle: true, getSessionStats: () => source, compact: () => Promise.resolve() });

    const result = await tool.execute("report", {}, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({
      sessionFile: null,
      sessionId: "session-1",
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 5,
      tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, total: 35 },
      cost: 0.012_345,
      contextUsage: { tokens: 250, contextWindow: 1_000, percent: 25 },
      compaction: { status: "idle" },
    });
    const details = result.details as { tokens: { total: number }; contextUsage: { tokens: number }; compaction: { status: string } };
    details.tokens.total = 999;
    details.contextUsage.tokens = 999;
    details.compaction.status = "failed";
    (source.tokens as { total: number }).total = 777;

    await expect(panels.snapshot()).resolves.toMatchObject([
      {
        id: "session-insights-panel",
        data: {
          tokens: { total: 35 },
          contextUsage: { tokens: 250 },
          compaction: { status: "idle" },
        },
      },
    ]);
  });

  test("fails closed for malformed or inconsistent session statistics", async () => {
    const malformed = [
      null,
      [],
      stats({ sessionId: "" }),
      stats({ userMessages: -1 }),
      stats({ cost: Number.NaN }),
      stats({ totalMessages: 4 }),
      stats({ tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, total: 34 } }),
      stats({ contextUsage: { tokens: null, contextWindow: 1_000, percent: 25 } }),
      stats({ contextUsage: { tokens: 250, contextWindow: 1_000, percent: 24 } }),
    ];
    for (const report of malformed) {
      const { panels, tool } = await fixture({ isIdle: true, getSessionStats: () => report, compact: () => Promise.resolve() });
      await expect(tool.execute("malformed", {}, undefined, undefined, {} as never)).rejects.toThrow(/session statistics.*invalid/iu);
      const panelError = (await panels.snapshot())[0]?.error;
      expect(panelError).toMatch(/session statistics.*invalid/iu);
    }
  });

  test("does not invoke accessors while inspecting session statistics", async () => {
    let accesses = 0;
    const source = stats();
    Object.defineProperty(source, "cost", {
      enumerable: true,
      get() {
        accesses += 1;
        throw new Error("cost getter executed");
      },
    });
    const nested = stats();
    Object.defineProperty(nested.tokens, "total", {
      enumerable: true,
      get() {
        accesses += 1;
        throw new Error("token getter executed");
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    for (const report of [source, nested, revocable.proxy]) {
      const { tool } = await fixture({ isIdle: true, getSessionStats: () => report, compact: () => Promise.resolve() });
      await expect(tool.execute("hostile", {}, undefined, undefined, {} as never)).rejects.toThrow(/session statistics.*invalid/iu);
    }
    expect(accesses).toBe(0);
  });

  test("bounds upstream statistics failures without invoking error accessors", async () => {
    let accesses = 0;
    const hostile = new Error();
    Object.defineProperty(hostile, "message", {
      get() {
        accesses += 1;
        throw new Error("statistics error getter executed");
      },
    });
    let attempt = 0;
    const { panels, tool } = await fixture({
      isIdle: true,
      getSessionStats() {
        throw ++attempt === 1 ? new Error("x".repeat(3_000)) : hostile;
      },
      compact: () => Promise.resolve(),
    });

    await expect(tool.execute("long", {}, undefined, undefined, {} as never)).rejects.toThrow(/session statistics inspection failed/iu);
    let error = (await panels.snapshot())[0]?.error;
    expect(error).toHaveLength(2_000);
    await expect(tool.execute("hostile", {}, undefined, undefined, {} as never)).rejects.toThrow(/session statistics inspection failed.*unknown error/iu);
    error = (await panels.snapshot())[0]?.error;
    expect(error).toBe("Session statistics inspection failed: unknown error");
    expect(accesses).toBe(0);
  });

  test("serves panel polls from cache and refreshes on tools, lifecycle events, and session changes", async () => {
    let calls = 0;
    let current = stats();
    const firstSession = {
      isIdle: true,
      getSessionStats() {
        calls += 1;
        return current;
      },
      compact: () => Promise.resolve(),
    };
    const { context, panels, tool } = await fixture(firstSession);

    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { totalMessages: 5 } }]);
    current = stats({ totalMessages: 6 });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { totalMessages: 5 } }]);
    expect(calls).toBe(1);

    await expect(tool.execute("refresh", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { totalMessages: 6 } });
    expect(calls).toBe(2);
    current = stats({ totalMessages: 7 });
    context.emit("pi/session-event", { type: "message_end" } as never);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { totalMessages: 7 } }]);
    expect(calls).toBe(3);

    context.reflect.set("piRuntime", {
      session: {
        isIdle: true,
        getSessionStats: () => stats({ sessionId: "session-2", userMessages: 1, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 1 }),
        compact: () => Promise.resolve(),
      },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { sessionId: "session-2", totalMessages: 1 } }]);
  });

  test("runs confirmed compaction only while idle and refreshes its completed report", async () => {
    let current = stats();
    let compactions = 0;
    const { tool } = await fixture({
      isIdle: true,
      getSessionStats: () => current,
      compact: () => {
        compactions += 1;
        current = stats({
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 1,
          totalMessages: 3,
          contextUsage: { tokens: null, contextWindow: 1_000, percent: null },
        });
        return Promise.resolve();
      },
      abortCompaction: () => undefined,
    });

    await expect(tool.execute("compact", { compact: true, confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { totalMessages: 3, compaction: { status: "completed" } },
    });
    expect(compactions).toBe(1);
  });

  test("queues confirmed compaction until an active agent run settles and enforces single flight", async () => {
    let compactions = 0;
    const { context, panels, tool } = await fixture({
      isIdle: false,
      getSessionStats: () => stats(),
      compact: () => {
        compactions += 1;
        return Promise.resolve();
      },
      abortCompaction: () => undefined,
    });

    await expect(tool.execute("queued", { compact: true, confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { compaction: { status: "queued" } },
    });
    expect(compactions).toBe(0);
    await expect(tool.execute("duplicate", { compact: true, confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(/already.*progress/iu);

    context.emit("pi/session-event", { type: "agent_settled" } as never);
    await vi.waitFor(() => expect(compactions).toBe(1));
    await expect.poll(async () => (await panels.snapshot())[0]?.data).toMatchObject({ compaction: { status: "completed" } });
  });

  test("rejects a compaction already owned by another plugin", async () => {
    const compact = vi.fn().mockResolvedValue(undefined);
    const session = { sessionId: "shared", isIdle: true, isCompacting: false, getSessionStats: () => stats(), compact, abortCompaction() {} };
    const { tool, panels } = await fixture(session);
    const release = tryAcquireSessionCompaction(session);
    expect(release).toEqual(expect.any(Function));
    try {
      await expect(tool.execute("shared-lock", { compact: true, confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(/already.*progress/iu);
      expect(compact).not.toHaveBeenCalled();
      await expect(panels.snapshot()).resolves.toMatchObject([
        { data: { compaction: { status: "failed", error: "A session compaction is already in progress" } } },
      ]);
    } finally {
      release?.();
    }
    await expect(tool.execute("after-shared-lock", { compact: true, confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { compaction: { status: "completed" } },
    });
  });

  test("cancels queued compaction when its caller aborts or the session changes", async () => {
    let compactions = 0;
    const controller = new AbortController();
    const { context, panels, tool } = await fixture({
      isIdle: false,
      getSessionStats: () => stats(),
      compact: () => {
        compactions += 1;
        return Promise.resolve();
      },
      abortCompaction: () => undefined,
    });
    await tool.execute("queued", { compact: true, confirm: true }, controller.signal, undefined, {} as never);
    controller.abort(new Error("caller cancelled queued compaction"));
    await expect.poll(async () => (await panels.snapshot())[0]?.data).toMatchObject({ compaction: { status: "cancelled" } });
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    expect(compactions).toBe(0);

    await tool.execute("queued-again", { compact: true, confirm: true }, undefined, undefined, {} as never);
    context.reflect.set("piRuntime", {
      session: { isIdle: true, getSessionStats: () => stats({ sessionId: "replacement" }), compact: () => Promise.resolve() },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { sessionId: "replacement", compaction: { status: "cancelled" } } }]);
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    expect(compactions).toBe(0);
  });

  test("uses dedicated compaction cancellation for caller abort and plugin disposal", async () => {
    let aborts = 0;
    let resolveCompact: (() => void) | undefined;
    const first = await fixture({
      isIdle: true,
      getSessionStats: () => stats(),
      compact: () =>
        new Promise<void>((resolve) => {
          resolveCompact = resolve;
        }),
      abortCompaction: () => {
        aborts += 1;
      },
    });
    const controller = new AbortController();
    const execution = first.tool.execute("active", { compact: true, confirm: true }, controller.signal, undefined, {} as never);
    await vi.waitFor(() => expect(resolveCompact).toBeDefined());
    controller.abort(new Error("caller cancelled active compaction"));
    resolveCompact?.();
    await expect(execution).rejects.toThrow(/caller cancelled active compaction/iu);
    expect(aborts).toBe(1);

    let resolveDisposed: (() => void) | undefined;
    const second = await fixture({
      isIdle: true,
      getSessionStats: () => stats(),
      compact: () =>
        new Promise<void>((resolve) => {
          resolveDisposed = resolve;
        }),
      abortCompaction: () => {
        aborts += 1;
      },
    });
    const disposedExecution = second.tool.execute("dispose", { compact: true, confirm: true }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(resolveDisposed).toBeDefined());
    await second.context.fiber.dispose();
    resolveDisposed?.();
    await expect(disposedExecution).rejects.toThrow(/disposed/iu);
    expect(aborts).toBe(2);
    await expect(second.tool.execute("stale", {}, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
  });

  test("cancels in-flight compaction when the active session is replaced", async () => {
    let aborts = 0;
    let resolveCompact: (() => void) | undefined;
    const oldSession = {
      isIdle: true,
      getSessionStats: () => stats(),
      compact: () =>
        new Promise<void>((resolve) => {
          resolveCompact = resolve;
        }),
      abortCompaction: () => {
        aborts += 1;
      },
    };
    const { context, panels, tool } = await fixture(oldSession);
    const execution = tool.execute("replace", { compact: true, confirm: true }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(resolveCompact).toBeDefined());

    context.reflect.set("piRuntime", {
      session: {
        isIdle: true,
        getSessionStats: () => stats({ sessionId: "replacement" }),
        compact: () => Promise.resolve(),
        abortCompaction: () => undefined,
      },
    });
    await panels.snapshot();
    await expect(execution).rejects.toThrow(/session changed/iu);
    expect(aborts).toBe(1);
    await expect
      .poll(async () => ((await panels.snapshot())[0]?.data as { compaction?: { status?: unknown } } | undefined)?.compaction?.status)
      .toBe("cancelled");
    const replacement = (await panels.snapshot())[0]?.data as { sessionId: string; compaction: { error: string } };
    expect(replacement.sessionId).toBe("replacement");
    expect(replacement.compaction.error).toMatch(/session changed/iu);
    resolveCompact?.();
  });

  test("records bounded descriptor-safe compaction failures", async () => {
    let accesses = 0;
    const hostile = new Error();
    Object.defineProperty(hostile, "message", {
      get() {
        accesses += 1;
        throw new Error("error getter executed");
      },
    });
    let attempt = 0;
    const { panels, tool } = await fixture({
      isIdle: true,
      getSessionStats: () => stats(),
      compact: () => Promise.reject(++attempt === 1 ? new Error("x".repeat(3_000)) : hostile),
      abortCompaction: () => undefined,
    });

    await expect(tool.execute("long", { compact: true, confirm: true }, undefined, undefined, {} as never)).rejects.toThrow();
    let state = ((await panels.snapshot())[0]?.data as { compaction: { error: string; status: string } }).compaction;
    expect(state).toMatchObject({ status: "failed" });
    expect(state.error).toHaveLength(2_000);
    await expect(tool.execute("hostile", { compact: true, confirm: true }, undefined, undefined, {} as never)).rejects.toBe(hostile);
    state = ((await panels.snapshot())[0]?.data as { compaction: { error: string; status: string } }).compaction;
    expect(state).toEqual(expect.objectContaining({ status: "failed", error: "Unknown session compaction error" }));
    expect(accesses).toBe(0);
  });

  test("rolls back every registration when the panel id is unavailable", async () => {
    const context = new Context();
    contexts.push(context);
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    panels.register({ id: "session-insights-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);

    await expect(context.plugin(sessionInsightsPlugin)).rejects.toThrow(/panel is already registered/iu);
    expect(tools.snapshot().customTools).toEqual([]);
    await expect(panels.snapshot()).resolves.toMatchObject([{ pluginId: "fixture" }]);
  });

  test("reports a stable unavailable-runtime error and recovers after runtime activation", async () => {
    const context = new Context();
    contexts.push(context);
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    await context.plugin(sessionInsightsPlugin);
    const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "session_report")!;

    await expect(tool.execute("missing", {}, undefined, undefined, {} as never)).rejects.toThrow(/^Pi runtime is not ready$/u);
    await expect(panels.snapshot()).resolves.toMatchObject([{ error: "Pi runtime is not ready" }]);
    context.provide("piRuntime", { session: { isIdle: true, getSessionStats: () => stats(), compact: () => Promise.resolve() } } as never);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { sessionId: "session-1" } }]);
  });
});

test("refreshes statistics and cancels queued compaction when the same runtime changes session IDs", async () => {
  let id = "old-session";
  let compactions = 0;
  const session = {
    get sessionId() {
      return id;
    },
    isIdle: false,
    getSessionStats: () => stats({ sessionId: id }),
    compact: () => {
      compactions += 1;
      return Promise.resolve();
    },
    abortCompaction() {},
  };
  const { tool, context, panels } = await fixture(session);
  await tool.execute("queue", { compact: true, confirm: true }, undefined, undefined, {} as never);
  id = "new-session";
  await expect(panels.snapshot()).resolves.toMatchObject([{ data: { sessionId: id, compaction: { status: "cancelled" } } }]);
  context.emit("pi/session-event", { type: "agent_settled" } as never);
  await Promise.resolve();
  expect(compactions).toBe(0);
});

test("keeps the native compaction lock and re-aborts when its controller initializes late", async () => {
  let listener: ((event: { type: string }) => void) | undefined;
  let finish: (() => void) | undefined;
  let starts = 0;
  let aborts = 0;
  const { tool } = await fixture({
    sessionId: "late",
    isIdle: true,
    getSessionStats: () => stats(),
    subscribe: (callback: typeof listener) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    compact: () => {
      starts += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    abortCompaction: () => {
      aborts += 1;
    },
  });
  const controller = new AbortController();
  const pending = tool.execute("late", { compact: true, confirm: true }, controller.signal, undefined, {} as never);
  await vi.waitFor(() => expect(starts).toBe(1));
  controller.abort(new Error("cancel late initialization"));
  await expect(pending).rejects.toThrow(/cancel late/);
  await expect(tool.execute("second", { compact: true, confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(/already/);
  listener?.({ type: "compaction_start" });
  expect(aborts).toBe(2);
  finish?.();
  await vi.waitFor(() => expect(listener).toBeUndefined());
});

test("immediate cancellation reaches cancelled state without starting native compaction", async () => {
  let starts = 0;
  const { tool, panels } = await fixture({
    isIdle: true,
    getSessionStats: () => stats(),
    compact: () => {
      starts += 1;
      return Promise.resolve();
    },
    abortCompaction() {},
  });
  const controller = new AbortController();
  const pending = tool.execute("immediate", { compact: true, confirm: true }, controller.signal, undefined, {} as never);
  controller.abort(new Error("immediately cancelled"));
  await expect(pending).rejects.toThrow(/immediately cancelled/);
  expect(starts).toBe(0);
  await expect(panels.snapshot()).resolves.toMatchObject([{ data: { compaction: { status: "cancelled" } } }]);
});
