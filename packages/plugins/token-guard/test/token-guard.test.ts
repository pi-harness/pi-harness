import { Context } from "@deepseek-ai/cordis";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, test, vi } from "vitest";
import { PiPluginUiRegistry } from "@pi-harness/plugin-api";
import tokenGuardPlugin from "../src/index.js";
import { createTestRuntimeContext } from "@pi-harness/core/test-harness";

describe("token guard absolute run budget", () => {
  test("rejects out-of-range, fractional, and unknown configuration", async () => {
    const invalid = [
      { maxPercent: 0 },
      { maxPercent: 101 },
      { maxRunTokens: -1 },
      { maxRunTokens: 1.5 },
      { maxRunTokens: 10_000_001 },
      { maxPercent: 90, surprise: true },
    ];
    for (const config of invalid) {
      const context = new Context();
      const panels = new PiPluginUiRegistry();
      context.provide("piRuntime", {
        session: { isStreaming: false, getContextUsage: () => undefined, getSessionStats: () => undefined },
        abort: () => Promise.resolve(),
      } as never);
      context.provide("piPluginUi", panels);
      try {
        let failure: unknown;
        try {
          await context.plugin(tokenGuardPlugin, config);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/token guard|maxPercent|maxRunTokens|unknown|invalid config/iu);
        await expect(panels.snapshot()).resolves.toEqual([]);
      } finally {
        await context.fiber.dispose();
      }
    }
  });

  test("does not execute usage, statistics, or event accessors", async () => {
    let accessed = false;
    let aborts = 0;
    const usage = { tokens: 10, contextWindow: 100 };
    Object.defineProperty(usage, "percent", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("usage percent getter executed");
      },
    });
    const tokens = {};
    Object.defineProperty(tokens, "total", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("session total getter executed");
      },
    });
    const event = {};
    Object.defineProperty(event, "type", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("event type getter executed");
      },
    });
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    context.provide("piRuntime", {
      session: { isStreaming: true, getContextUsage: () => usage, getSessionStats: () => ({ tokens }) },
      abort: () => {
        aborts += 1;
        return Promise.resolve();
      },
    } as never);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(tokenGuardPlugin, { maxPercent: 50, maxRunTokens: 50 });
      expect(() => context.emit("pi/session-event", event as never)).not.toThrow();
      const snapshot = await panels.snapshot();
      expect(snapshot).toMatchObject([
        {
          data: {
            percent: null,
            tokens: null,
            contextWindow: 0,
            runTokens: null,
            exceeded: false,
            aborts: 0,
          },
        },
      ]);
      const lastError = (snapshot[0]?.data as { lastError?: unknown }).lastError;
      expect(typeof lastError).toBe("string");
      expect(lastError).toMatch(/context usage.*invalid|session statistics.*invalid/iu);
      expect(accessed).toBe(false);
      expect(aborts).toBe(0);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("does not read session statistics when the absolute run budget is disabled", async () => {
    let accessed = false;
    const session = {
      isStreaming: false,
      getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
    };
    Object.defineProperty(session, "getSessionStats", {
      get() {
        accessed = true;
        throw new Error("session statistics getter executed");
      },
    });
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    context.provide("piRuntime", { session, abort: () => Promise.resolve() } as never);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(tokenGuardPlugin, { maxPercent: 90, maxRunTokens: 0 });
      context.emit("pi/session-event", { type: "message_end" } as never);
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { percent: 10, runTokens: null, lastError: null } }]);
      expect(accessed).toBe(false);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("contains and reports asynchronous abort failures safely", async () => {
    let accessed = false;
    const hostile = new Error();
    Object.defineProperty(hostile, "message", {
      get() {
        accessed = true;
        throw new Error("abort error getter executed");
      },
    });
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    context.provide("piRuntime", {
      session: {
        isStreaming: true,
        getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 90 }),
      },
      abort: () => Promise.reject(hostile),
    } as never);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(tokenGuardPlugin, { maxPercent: 80, maxRunTokens: 0 });
      await vi.waitFor(async () => {
        await expect(panels.snapshot()).resolves.toMatchObject([
          { data: { exceeded: true, aborts: 1, lastError: "Token Guard could not abort the active run: unknown error" } },
        ]);
      });
      expect(accessed).toBe(false);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("issues at most one abort per run and keeps panel polling side-effect free", async () => {
    let percent = 10;
    let inspections = 0;
    let aborts = 0;
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    context.provide("piRuntime", {
      session: {
        isStreaming: true,
        getContextUsage() {
          inspections += 1;
          return { tokens: percent, contextWindow: 100, percent };
        },
      },
      abort: () => {
        aborts += 1;
        return Promise.resolve();
      },
    } as never);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(tokenGuardPlugin, { maxPercent: 80, maxRunTokens: 0 });
      context.emit("pi/session-event", { type: "agent_start" } as never);
      percent = 90;
      context.emit("pi/session-event", { type: "message_update" } as never);
      percent = 10;
      context.emit("pi/session-event", { type: "message_end" } as never);
      percent = 90;
      context.emit("pi/session-event", { type: "message_end" } as never);
      expect(aborts).toBe(1);
      expect(inspections).toBe(5);

      await panels.snapshot();
      await panels.snapshot();
      expect(inspections).toBe(5);
      expect(aborts).toBe(1);

      context.emit("pi/session-event", { type: "agent_start" } as never);
      expect(aborts).toBe(2);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("resets counters and the run baseline when the active session changes", async () => {
    let replacementTotal = 500;
    let aborts = 0;
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    context.provide("piRuntime", {
      session: {
        isStreaming: true,
        getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 90 }),
        getSessionStats: () => ({ tokens: { total: 100 } }),
      },
      abort: () => {
        aborts += 1;
        return Promise.resolve();
      },
    } as never);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(tokenGuardPlugin, { maxPercent: 80, maxRunTokens: 50 });
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { aborts: 1, exceeded: true } }]);

      context.reflect.set("piRuntime", {
        session: {
          isStreaming: true,
          getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
          getSessionStats: () => ({ tokens: { total: replacementTotal } }),
        },
        abort: () => {
          aborts += 1;
          return Promise.resolve();
        },
      });
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { percent: 10, aborts: 0, exceeded: false, runTokens: null, runExceeded: false } }]);

      context.emit("pi/session-event", { type: "agent_start" } as never);
      replacementTotal = 551;
      context.emit("pi/session-event", { type: "message_update" } as never);
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { aborts: 1, runTokens: 51, runExceeded: true, exceeded: true } }]);
      expect(aborts).toBe(2);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("removes its event listener when panel registration fails", async () => {
    let inspections = 0;
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    context.provide("piRuntime", {
      session: {
        isStreaming: false,
        getContextUsage() {
          inspections += 1;
          return undefined;
        },
      },
      abort: () => Promise.resolve(),
    } as never);
    context.provide("piPluginUi", panels);
    const disposeDuplicate = panels.register({
      id: "token-guard-panel",
      pluginId: "duplicate",
      title: "Duplicate",
      read: () => ({}),
    });
    try {
      await expect(context.plugin(tokenGuardPlugin)).rejects.toThrow(/already registered/iu);
      expect(inspections).toBe(0);
      context.emit("pi/session-event", { type: "message_end" } as never);
      expect(inspections).toBe(0);
    } finally {
      disposeDuplicate();
      await context.fiber.dispose();
    }
  });

  test("enforces an absolute budget against a real AgentSession run", async () => {
    const { context } = await createTestRuntimeContext([fauxAssistantMessage("deterministic response")]);
    const panels = context.piPluginUi;
    try {
      await context.plugin(tokenGuardPlugin, { maxPercent: 100, maxRunTokens: 1 });
      await context.piRuntime.prompt("respond once");
      const snapshot = await panels.snapshot();
      expect(snapshot).toMatchObject([
        {
          data: {
            maxRunTokens: 1,
            runExceeded: true,
            exceeded: true,
            aborts: 1,
            lastError: null,
          },
        },
      ]);
      const runTokens = (snapshot[0]?.data as { runTokens?: unknown }).runTokens;
      expect(typeof runTokens).toBe("number");
      expect(runTokens as number).toBeGreaterThanOrEqual(1);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("bounds inspection work during high-volume streaming updates", async () => {
    let inspections = 0;
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    context.provide("piRuntime", {
      session: {
        isStreaming: true,
        getContextUsage() {
          inspections += 1;
          return { tokens: 10, contextWindow: 100, percent: 10 };
        },
      },
      abort: () => Promise.resolve(),
    } as never);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(tokenGuardPlugin, { maxPercent: 90, maxRunTokens: 0 });
      context.emit("pi/session-event", { type: "agent_start" } as never);
      for (let index = 0; index < 100; index += 1)
        context.emit("pi/session-event", { type: "tool_execution_update", toolCallId: "call", toolName: "tool", args: {}, partialResult: {} } as never);
      for (let index = 0; index < 64; index += 1) context.emit("pi/session-event", { type: "message_update" } as never);
      context.emit("pi/session-event", { type: "message_end" } as never);

      expect(inspections).toBe(5);
      await expect(panels.snapshot()).resolves.toMatchObject([{ data: { limits: { streamingUpdateInterval: 32 } } }]);
      expect(inspections).toBe(5);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("removes the panel and stops inspecting after disposal", async () => {
    let inspections = 0;
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    context.provide("piRuntime", {
      session: {
        isStreaming: false,
        getContextUsage() {
          inspections += 1;
          return undefined;
        },
      },
      abort: () => Promise.resolve(),
    } as never);
    context.provide("piPluginUi", panels);
    try {
      await context.plugin(tokenGuardPlugin);
      expect(inspections).toBe(1);

      await context.fiber.dispose();
      await expect(panels.snapshot()).resolves.toEqual([]);
      context.emit("pi/session-event", { type: "message_end" } as never);
      expect(inspections).toBe(1);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("aborts a streaming run when run tokens exceed the configured limit", async () => {
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    let totalTokens = 100;
    let aborts = 0;
    context.provide("piRuntime", {
      session: {
        isStreaming: true,
        getContextUsage: () => ({ tokens: totalTokens, contextWindow: 8_000, percent: (totalTokens / 8_000) * 100 }),
        getSessionStats: () => ({ tokens: { total: totalTokens } }),
      },
      abort: () => {
        aborts += 1;
        return Promise.resolve();
      },
    } as never);
    context.provide("piPluginUi", panels);
    await context.plugin(tokenGuardPlugin, { maxPercent: 100, maxRunTokens: 50 });
    context.emit("pi/session-event", { type: "agent_start" } as never);
    totalTokens = 151;
    context.emit("pi/session-event", { type: "message_update" } as never);
    await expect(panels.snapshot()).resolves.toMatchObject([
      { id: "token-guard-panel", data: { maxRunTokens: 50, runTokens: 51, runExceeded: true, exceeded: true, aborts: 1 } },
    ]);
    expect(aborts).toBe(1);
    await context.fiber.dispose();
  });
});

test("stops a budget-exhausting assistant response before its real write tool executes", async () => {
  const { context } = await createTestRuntimeContext(
    [fauxAssistantMessage(fauxToolCall("write", { path: "budget-marker.txt", content: "should not run" })), fauxAssistantMessage("finished")],
    ["write"],
  );
  const root = context.piHarnessLaunch.cwd,
    agentDir = context.piHarnessLaunch.agentDir;
  try {
    await context.plugin(tokenGuardPlugin, { maxPercent: 100, maxRunTokens: 1 });
    await context.piRuntime.prompt("write the marker");
    await expect(access(join(root, "budget-marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(context.piPluginUi.snapshot()).resolves.toMatchObject([{ data: { runExceeded: true, aborts: 1 } }]);
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("does not attach an old abort rejection to a new run", async () => {
  const context = new Context(),
    panels = new PiPluginUiRegistry();
  let rejectAbort: (reason: unknown) => void = () => {};
  let percent = 90;
  context.provide("piRuntime", {
    session: { sessionId: "a", isStreaming: true, getContextUsage: () => ({ tokens: percent, contextWindow: 100, percent }) },
    abort: () =>
      new Promise<void>((_resolve, reject) => {
        rejectAbort = reject;
      }),
  } as never);
  context.provide("piPluginUi", panels);
  try {
    await context.plugin(tokenGuardPlugin, { maxPercent: 80 });
    percent = 10;
    context.emit("pi/session-event", { type: "agent_start" } as never);
    rejectAbort(new Error("old run failure"));
    await Promise.resolve();
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { lastError: null, exceeded: false } }]);
  } finally {
    await context.fiber.dispose();
  }
});

test("resets on a native session ID change without aborting from panel polling", async () => {
  const context = new Context(),
    panels = new PiPluginUiRegistry();
  let sessionId = "first",
    aborts = 0;
  const session = {
    get sessionId() {
      return sessionId;
    },
    isStreaming: true,
    getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 90 }),
    getSessionStats: () => ({ tokens: { total: 500 } }),
  };
  context.provide("piRuntime", {
    session,
    abort: () => {
      aborts++;
      return Promise.resolve();
    },
  } as never);
  context.provide("piPluginUi", panels);
  try {
    await context.plugin(tokenGuardPlugin, { maxPercent: 80, maxRunTokens: 50 });
    expect(aborts).toBe(1);
    sessionId = "second";
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { aborts: 0, runTokens: null, exceeded: true } }]);
    expect(aborts).toBe(1);
    context.emit("pi/session-event", { type: "message_update" } as never);
    expect(aborts).toBe(2);
  } finally {
    await context.fiber.dispose();
  }
});

test("counts finalized usage once before and after native persistence", async () => {
  const context = new Context(),
    panels = new PiPluginUiRegistry();
  let total = 100;
  context.provide("piRuntime", {
    session: { isStreaming: true, getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }), getSessionStats: () => ({ tokens: { total } }) },
    abort: () => Promise.resolve(),
  } as never);
  context.provide("piPluginUi", panels);
  try {
    await context.plugin(tokenGuardPlugin, { maxPercent: 100, maxRunTokens: 100 });
    context.emit("pi/session-event", { type: "agent_start" } as never);
    context.emit("pi/session-event", {
      type: "message_end",
      message: { role: "assistant", usage: { input: 5, output: 15, cacheRead: 20, cacheWrite: 20 } },
    } as never);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { runTokens: 60, aborts: 0 } }]);
    total = 160;
    context.emit("pi/session-event", { type: "turn_end" } as never);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { runTokens: 60, aborts: 0 } }]);
  } finally {
    await context.fiber.dispose();
  }
});
