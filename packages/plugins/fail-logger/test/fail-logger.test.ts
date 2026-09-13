import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import failLoggerPlugin from "../src/index.js";
import { PiPluginUiRegistry } from "@pi-harness/plugin-api";

interface FailurePanelData {
  total: number;
  observed: number;
  dropped: number;
  capacity: number;
  failures: Array<{ time: string; source: string; message: string; occurrences: number }>;
}

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function setup(): Promise<{ context: Context; panels: PiPluginUiRegistry }> {
  const context = new Context();
  contexts.push(context);
  const panels = new PiPluginUiRegistry();
  context.provide("piPluginUi", panels);
  await context.plugin(failLoggerPlugin);
  return { context, panels };
}

async function panel(panels: PiPluginUiRegistry): Promise<FailurePanelData> {
  const snapshot = await panels.snapshot();
  return snapshot[0]?.data as FailurePanelData;
}

describe("failure logger plugin", () => {
  test("deduplicates matching failures across intervening events and counts occurrences", async () => {
    const { context, panels } = await setup();
    context.emit("pi/extension-error", { extensionPath: "a.ts", event: "load", error: "same failure" });
    context.emit("pi/extension-error", { extensionPath: "b.ts", event: "load", error: "other failure" });
    context.emit("pi/extension-error", { extensionPath: "a.ts", event: "tool", error: "same failure" });

    const data = await panel(panels);
    expect(data).toMatchObject({ total: 2, observed: 3, dropped: 0, capacity: 50 });
    expect(data.failures).toMatchObject([
      { source: "extension", message: "a.ts: same failure", occurrences: 2 },
      { source: "extension", message: "b.ts: other failure", occurrences: 1 },
    ]);
    expect(data.failures.every((failure) => Number.isFinite(Date.parse(failure.time)))).toBe(true);
  });

  test("saturates occurrence counts at the largest safe integer", async () => {
    const { context, panels } = await setup();
    context.emit("pi/extension-error", { extensionPath: "repeat.ts", event: "load", error: "same failure" });
    const originalGet = Reflect.get(Map.prototype, "get") as (this: Map<unknown, unknown>, key: unknown) => unknown;
    const get = vi.spyOn(Map.prototype, "get").mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
      const value = originalGet.call(this, key);
      if (key === "extension:repeat.ts: same failure" && typeof value === "object" && value !== null && "occurrences" in value) {
        (value as { occurrences: number }).occurrences = Number.MAX_SAFE_INTEGER;
      }
      return value;
    } as never);
    try {
      context.emit("pi/extension-error", { extensionPath: "repeat.ts", event: "load", error: "same failure" });
    } finally {
      get.mockRestore();
    }

    expect((await panel(panels)).failures[0]?.occurrences).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("summarizes hostile and oversized failures without running accessors or throwing", async () => {
    const { context, panels } = await setup();
    let accessed = false;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "error", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("getter executed");
      },
    });
    expect(() => context.emit("pi/extension-error", accessor as never)).not.toThrow();
    expect(accessed).toBe(false);

    const cyclic: Record<string, unknown> = { code: "E_FAIL", attempt: 42n };
    cyclic.self = cyclic;
    expect(() => context.emit("pi/extension-error", { extensionPath: "cycle.ts", event: "load", error: cyclic } as never)).not.toThrow();
    let enumerated = false;
    const nonEnumerated = new Proxy(
      { code: "E_PROXY" },
      {
        ownKeys() {
          enumerated = true;
          throw new Error("failure payload was enumerated");
        },
      },
    );
    expect(() => context.emit("pi/extension-error", { extensionPath: "proxy.ts", event: "load", error: nonEnumerated } as never)).not.toThrow();
    expect(enumerated).toBe(false);
    let constructorAccessed = false;
    const nestedError = new Error("nested failure");
    Object.defineProperty(nestedError, "constructor", {
      get() {
        constructorAccessed = true;
        throw new Error("constructor getter executed");
      },
    });
    expect(() =>
      context.emit("pi/extension-error", { extensionPath: "nested.ts", event: "load", error: { code: "E_NESTED", cause: nestedError } } as never),
    ).not.toThrow();
    expect(constructorAccessed).toBe(false);
    expect(() =>
      context.emit("pi/extension-error", {
        extensionPath: "p".repeat(2_000),
        event: "load",
        error: "m".repeat(10_000),
      }),
    ).not.toThrow();

    const data = await panel(panels);
    expect(data.failures).toHaveLength(5);
    expect(data.failures.some((failure) => failure.message.includes("[Accessor]"))).toBe(true);
    expect(data.failures.some((failure) => failure.message.includes("E_FAIL") && failure.message.includes("42"))).toBe(true);
    expect(data.failures.some((failure) => failure.message.includes("E_PROXY"))).toBe(true);
    expect(data.failures.some((failure) => failure.message.includes("nested failure"))).toBe(true);
    expect(data.failures.every((failure) => failure.message.length <= 2_048)).toBe(true);
  });

  test("previews proxy arrays without property reads", async () => {
    const { context, panels } = await setup();
    const propertyReads: PropertyKey[] = [];
    const payload = new Proxy([{ code: "E_ARRAY" }], {
      get(_target, key) {
        propertyReads.push(key);
        throw new Error(`array property read: ${String(key)}`);
      },
    });

    expect(() => context.emit("pi/extension-error", { extensionPath: "array.ts", event: "load", error: payload } as never)).not.toThrow();
    expect(propertyReads).toEqual([]);
    expect((await panel(panels)).failures[0]?.message).toContain("E_ARRAY");
  });

  test("previews proxied errors without prototype inspection", async () => {
    const { context, panels } = await setup();
    let prototypeInspections = 0;
    const payload = new Proxy(new Error("proxied failure"), {
      getPrototypeOf(target) {
        prototypeInspections += 1;
        return Reflect.getPrototypeOf(target);
      },
    });

    expect(() => context.emit("pi/extension-error", { extensionPath: "proxy-error.ts", event: "load", error: payload } as never)).not.toThrow();
    expect(prototypeInspections).toBe(0);
    expect((await panel(panels)).failures[0]?.message).toBe("proxy-error.ts: proxied failure");
  });

  test("sanitizes NUL characters from failure paths and messages", async () => {
    const { context, panels } = await setup();
    context.emit("pi/extension-error", { extensionPath: "bad\0path.ts", event: "load", error: "bad\0message" });

    const message = (await panel(panels)).failures[0]?.message;
    expect(message).toBe("bad�path.ts: bad�message");
    expect(message).not.toContain("\0");
  });

  test("keeps the newest 50 unique records and reports capacity eviction", async () => {
    const { context, panels } = await setup();
    for (let index = 0; index < 60; index += 1) {
      context.emit("pi/extension-error", { extensionPath: "capacity.ts", event: "load", error: `failure-${index}` });
    }

    const data = await panel(panels);
    expect(data).toMatchObject({ total: 50, observed: 60, dropped: 10, capacity: 50 });
    expect(data.failures[0]?.message).toBe("capacity.ts: failure-59");
    expect(data.failures.at(-1)?.message).toBe("capacity.ts: failure-10");
  });

  test("records agent and compaction failures with their actual event sources", async () => {
    const { context, panels } = await setup();
    context.emit("pi/session-event", {
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "agent failed" }],
    } as never);
    context.emit("pi/session-event", { type: "compaction_end", errorMessage: "compaction failed" } as never);

    expect((await panel(panels)).failures).toMatchObject([
      { source: "compaction", message: "compaction failed", occurrences: 1 },
      { source: "agent", message: "agent failed", occurrences: 1 },
    ]);
  });

  test("does not report an aborted compaction as a failure", async () => {
    const { context, panels } = await setup();
    context.emit("pi/session-event", {
      type: "compaction_end",
      reason: "manual",
      result: undefined,
      aborted: true,
      willRetry: false,
      errorMessage: "Operation was cancelled",
    } as never);

    expect(await panel(panels)).toMatchObject({ total: 0, observed: 0, failures: [] });
  });

  test("finds the most recent failed assistant before trailing non-assistant messages", async () => {
    const { context, panels } = await setup();
    context.emit("pi/session-event", {
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "assistant", stopReason: "error", errorMessage: "older failure" },
        { role: "assistant", stopReason: "error", errorMessage: "latest failure" },
        { role: "toolResult", content: [{ type: "text", text: "tool failed too" }] },
        { role: "custom", customType: "diagnostic" },
      ],
    } as never);

    expect((await panel(panels)).failures).toMatchObject([{ source: "agent", message: "latest failure", occurrences: 1 }]);
  });

  test("bounds reverse message inspection without proxy property reads", async () => {
    const { context, panels } = await setup();
    const rawMessages = new Array<unknown>(10_001);
    rawMessages[0] = { role: "assistant", stopReason: "error", errorMessage: "outside scan window" };
    const propertyReads: PropertyKey[] = [];
    let descriptorInspections = 0;
    const messages = new Proxy(rawMessages, {
      get(_target, key) {
        propertyReads.push(key);
        throw new Error(`messages property read: ${String(key)}`);
      },
      getOwnPropertyDescriptor(target, key) {
        descriptorInspections += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    context.emit("pi/session-event", { type: "agent_end", willRetry: false, messages } as never);
    expect(propertyReads).toEqual([]);
    expect(descriptorInspections).toBe(10_001);
    expect(await panel(panels)).toMatchObject({ total: 0, observed: 0, failures: [] });
  });

  test("uses a stable fallback for an empty assistant error message", async () => {
    const { context, panels } = await setup();
    context.emit("pi/session-event", {
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "   " }],
    } as never);

    expect((await panel(panels)).failures).toMatchObject([{ source: "agent", message: "Agent turn failed", occurrences: 1 }]);
  });

  test("ignores hostile session events without invoking accessors", async () => {
    const { context, panels } = await setup();
    const accessed: string[] = [];
    const hostileEvent: Record<string, unknown> = {};
    for (const key of ["type", "messages", "errorMessage"]) {
      Object.defineProperty(hostileEvent, key, {
        get() {
          accessed.push(key);
          throw new Error(`${key} getter executed`);
        },
      });
    }

    expect(() => context.emit("pi/session-event", hostileEvent as never)).not.toThrow();
    expect(accessed).toEqual([]);

    const hostileMessages = { type: "agent_end" };
    Object.defineProperty(hostileMessages, "messages", {
      get() {
        accessed.push("messages");
        throw new Error("messages getter executed");
      },
    });
    const hostileCompaction = { type: "compaction_end" };
    Object.defineProperty(hostileCompaction, "errorMessage", {
      get() {
        accessed.push("errorMessage");
        throw new Error("errorMessage getter executed");
      },
    });
    const hostileMessage = { role: "assistant" };
    Object.defineProperty(hostileMessage, "stopReason", {
      get() {
        accessed.push("stopReason");
        throw new Error("stopReason getter executed");
      },
    });

    expect(() => context.emit("pi/session-event", hostileMessages as never)).not.toThrow();
    expect(() => context.emit("pi/session-event", { type: "agent_end", messages: [hostileMessage] } as never)).not.toThrow();
    expect(() => context.emit("pi/session-event", hostileCompaction as never)).not.toThrow();
    expect(accessed).toEqual([]);
    expect(await panel(panels)).toMatchObject({ total: 0, observed: 0, dropped: 0, failures: [] });
  });

  test("rolls back event listeners when panel registration fails", async () => {
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    context.provide("piPluginUi", panels);
    const disposeDuplicate = panels.register({
      id: "fail-logger-panel",
      pluginId: "duplicate",
      title: "Duplicate",
      read: () => ({}),
    });
    let inspections = 0;
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          inspections += 1;
          return undefined;
        },
      },
    );
    try {
      await expect(context.plugin(failLoggerPlugin)).rejects.toThrow(/already registered/iu);
      context.emit("pi/extension-error", hostile as never);
      context.emit("pi/session-event", hostile as never);
      expect(inspections).toBe(0);
    } finally {
      disposeDuplicate();
      await context.fiber.dispose();
    }
  });

  test("removes its panel and listeners on disposal", async () => {
    const { context, panels } = await setup();
    await context.fiber.dispose();
    let inspections = 0;
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          inspections += 1;
          return undefined;
        },
      },
    );

    context.emit("pi/extension-error", hostile as never);
    context.emit("pi/session-event", hostile as never);
    expect(inspections).toBe(0);
    await expect(panels.snapshot()).resolves.toEqual([]);
  });

  test("returns detached failure objects from every panel snapshot", async () => {
    const { context, panels } = await setup();
    context.emit("pi/extension-error", { extensionPath: "isolation.ts", event: "load", error: "original" });
    const first = await panel(panels);
    first.failures[0]!.message = "mutated";

    const second = await panel(panels);
    expect(second.failures[0]?.message).toBe("isolation.ts: original");
  });
});
