import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import contextPlugin from "../src/plugins/context.js";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

async function createInsights(runtime?: unknown): Promise<{
  context: Context;
  panels: PiPluginUiRegistry;
  tool: ReturnType<PiToolRegistry["snapshot"]>["customTools"][number];
  tools: PiToolRegistry;
}> {
  const context = new Context();
  const panels = new PiPluginUiRegistry();
  const tools = new PiToolRegistry();
  if (runtime !== undefined) context.provide("piRuntime", runtime as never);
  context.provide("piPluginUi", panels);
  context.provide("piTools", tools);
  await context.plugin(contextPlugin);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "context_inspect");
  if (tool === undefined) throw new Error("context_inspect was not registered");
  return { context, panels, tool, tools };
}

describe("context insights", () => {
  test("bounds and normalizes untrusted event types", async () => {
    const fixture = await createInsights();
    try {
      expect(() => fixture.context.emit("pi/session-event", { type: 7 } as never)).not.toThrow();
      fixture.context.emit("pi/session-event", { type: "x".repeat(129) } as never);
      fixture.context.emit("pi/session-event", { type: "bad\0type" } as never);
      for (let index = 0; index < 70; index += 1) fixture.context.emit("pi/session-event", { type: `event-${index}` } as never);

      const result = await fixture.tool.execute("inspect", {}, undefined, undefined, {} as never);
      const details = result.details as { eventTypes: Record<string, number>; events: number; recentEvents: unknown[] };
      expect(details.events).toBe(73);
      expect(Object.keys(details.eventTypes).length).toBeLessThanOrEqual(64);
      expect(Object.values(details.eventTypes).reduce((sum, count) => sum + count, 0)).toBe(73);
      expect(details.recentEvents).toHaveLength(50);
      expect(Object.keys(details.eventTypes).every((type) => type.length <= 128)).toBe(true);
      expect(Object.keys(details.eventTypes).every((type) => !type.includes("\0"))).toBe(true);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("counts one compaction per start event", async () => {
    const fixture = await createInsights();
    try {
      fixture.context.emit("pi/session-event", { type: "compaction_start" } as never);
      fixture.context.emit("pi/session-event", { type: "compaction_end" } as never);
      fixture.context.emit("pi/session-event", { type: "compaction_start" } as never);
      fixture.context.emit("pi/session-event", { type: "compaction_error" } as never);

      await expect(fixture.tool.execute("inspect", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { events: 4, compactions: 2 },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not execute event or message role accessors", async () => {
    let accessed = false;
    const event = {};
    Object.defineProperty(event, "type", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("event type getter executed");
      },
    });
    const message = {};
    Object.defineProperty(message, "role", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("message role getter executed");
      },
    });
    const fixture = await createInsights({
      session: {
        messages: [message],
        getContextUsage: () => undefined,
      },
    });
    try {
      expect(() => fixture.context.emit("pi/session-event", event as never)).not.toThrow();
      await expect(fixture.tool.execute("inspect", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: {
          composition: { other: 1 },
          eventTypes: { unknown: 1 },
        },
      });
      expect(accessed).toBe(false);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("keeps message insights available when upstream usage estimation fails", async () => {
    const fixture = await createInsights({
      session: {
        messages: [{ role: "user" }],
        getContextUsage() {
          throw new TypeError("invalid assistant usage");
        },
      },
    });
    try {
      await expect(fixture.tool.execute("inspect", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: {
          tokens: null,
          contextWindow: null,
          percent: null,
          messages: 1,
          composition: { user: 1 },
        },
      });
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { messages: 1, composition: { user: 1 } } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("strictly validates the empty tool parameter object without invoking accessors", async () => {
    let accessed = false;
    const accessor = {};
    Object.defineProperty(accessor, "surprise", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("parameter getter executed");
      },
    });
    const fixture = await createInsights();
    try {
      await expect(fixture.tool.execute("unknown", { surprise: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
      await expect(fixture.tool.execute("array", [] as never, undefined, undefined, {} as never)).rejects.toThrow(/object/iu);
      await expect(fixture.tool.execute("accessor", accessor, undefined, undefined, {} as never)).rejects.toThrow(/unknown property|data properties/iu);
      expect(accessed).toBe(false);
      expect((fixture.tool.parameters as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not execute message array or usage metric accessors", async () => {
    let accessed = false;
    const messages = [{ role: "user" }, { role: "assistant" }];
    Object.defineProperty(messages, "1", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("message index getter executed");
      },
    });
    const usage = { contextWindow: 8_000 };
    Object.defineProperty(usage, "tokens", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("usage getter executed");
      },
    });
    const fixture = await createInsights({ session: { messages, getContextUsage: () => usage } });
    try {
      await expect(fixture.tool.execute("inspect", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: {
          tokens: null,
          contextWindow: 8_000,
          messages: 2,
          composition: { user: 1, other: 1 },
        },
      });
      expect(accessed).toBe(false);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("serves panel polls from cache and refreshes after relevant lifecycle events", async () => {
    let usageCalls = 0;
    const messages: { role: string }[] = [{ role: "user" }];
    const fixture = await createInsights({
      session: {
        messages,
        getContextUsage() {
          usageCalls += 1;
          return { tokens: messages.length, contextWindow: 8_000, percent: 1 };
        },
      },
    });
    try {
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { messages: 1 } }]);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { messages: 1 } }]);
      expect(usageCalls).toBe(1);

      messages.push({ role: "assistant" });
      fixture.context.emit("pi/session-event", { type: "message_end" } as never);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { messages: 2, events: 1 } }]);
      expect(usageCalls).toBe(2);

      await expect(fixture.tool.execute("refresh", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { messages: 2 } });
      expect(usageCalls).toBe(3);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("resets cached composition and event history when the active session changes", async () => {
    const fixture = await createInsights({
      session: {
        messages: [{ role: "user" }],
        getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      },
    });
    try {
      fixture.context.emit("pi/session-event", { type: "message_start" } as never);
      fixture.context.emit("pi/session-event", { type: "compaction_start" } as never);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { events: 2, compactions: 1, composition: { user: 1 } } }]);

      fixture.context.reflect.set("piRuntime", {
        session: {
          messages: [{ role: "system" }, { role: "assistant" }],
          getContextUsage: () => ({ tokens: 250, contextWindow: 2_000, percent: 12.5 }),
        },
      });
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        {
          data: {
            tokens: 250,
            contextWindow: 2_000,
            percent: 12.5,
            messages: 2,
            events: 0,
            compactions: 0,
            composition: { user: 0, assistant: 1, system: 1 },
            eventTypes: {},
            recentEvents: [],
          },
        },
      ]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("inspects proxied message arrays through descriptors without invoking property reads", async () => {
    let propertyRead = false;
    const messages = new Proxy([{ role: "user" }, { role: "toolResult" }], {
      get() {
        propertyRead = true;
        throw new Error("message array property read executed");
      },
    });
    const fixture = await createInsights({ session: { messages, getContextUsage: () => undefined } });
    try {
      await expect(fixture.tool.execute("inspect", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { messages: 2, scannedMessages: 2, composition: { user: 1, toolResult: 1 } },
      });
      expect(propertyRead).toBe(false);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("isolates cached state from tool and panel snapshot mutation", async () => {
    const fixture = await createInsights({
      session: {
        messages: [{ role: "user" }],
        getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
      },
    });
    try {
      fixture.context.emit("pi/session-event", { type: "message_start" } as never);
      const toolDetails = (await fixture.tool.execute("inspect", {}, undefined, undefined, {} as never)).details as {
        composition: { user: number };
        recentEvents: { type: string }[];
      };
      toolDetails.composition.user = 99;
      toolDetails.recentEvents[0]!.type = "mutated";

      const firstPanel = (await fixture.panels.snapshot())[0]!.data as {
        composition: { user: number };
        recentEvents: { type: string }[];
      };
      expect(firstPanel).toMatchObject({ composition: { user: 1 }, recentEvents: [{ type: "message_start" }] });
      firstPanel.composition.user = 88;
      firstPanel.recentEvents[0]!.type = "also-mutated";

      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { composition: { user: 1 }, recentEvents: [{ type: "message_start" }] } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rolls back the tool when panel registration fails", async () => {
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    const tools = new PiToolRegistry();
    context.provide("piPluginUi", panels);
    context.provide("piTools", tools);
    const disposeDuplicate = panels.register({
      id: "context-insight-panel",
      pluginId: "duplicate",
      title: "Duplicate",
      read: () => ({}),
    });
    try {
      await expect(context.plugin(contextPlugin)).rejects.toThrow(/already registered/iu);
      expect(tools.snapshot().customTools).toEqual([]);
    } finally {
      disposeDuplicate();
      await context.fiber.dispose();
    }
  });

  test("bounds message scanning and rejects invalid usage metrics", async () => {
    const messages = Array.from({ length: 10_001 }, (_, index) => ({ role: index === 0 ? "system" : index % 2 === 0 ? "user" : "assistant" }));
    const fixture = await createInsights({
      session: {
        messages,
        getContextUsage: () => ({ tokens: Number.NaN, contextWindow: -1, percent: Number.POSITIVE_INFINITY }),
      },
    });
    try {
      const result = await fixture.tool.execute("inspect", {}, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({
        tokens: null,
        contextWindow: null,
        percent: null,
        messages: 10_001,
        scannedMessages: 10_000,
        messagesTruncated: true,
        composition: { system: 0, user: 5_000, assistant: 5_000 },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("reports exact message and recent-event boundaries", async () => {
    const messages = Array.from({ length: 10_000 }, () => ({ role: "toolResult" }));
    const fixture = await createInsights({ session: { messages, getContextUsage: () => ({ tokens: 0, contextWindow: 1, percent: 0 }) } });
    try {
      for (let index = 0; index < 50; index += 1) fixture.context.emit("pi/session-event", { type: "message_start" } as never);
      await expect(fixture.tool.execute("inspect", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: {
          tokens: 0,
          contextWindow: 1,
          percent: 0,
          messages: 10_000,
          scannedMessages: 10_000,
          messagesTruncated: false,
          composition: { toolResult: 10_000 },
        },
      });
      const details = (await fixture.tool.execute("again", {}, undefined, undefined, {} as never)).details as { recentEvents: unknown[] };
      expect(details.recentEvents).toHaveLength(50);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("preserves meaningful context usage above one hundred percent", async () => {
    const fixture = await createInsights({
      session: {
        messages: [],
        getContextUsage: () => ({ tokens: 10_000, contextWindow: 8_000, percent: 125 }),
      },
    });
    try {
      await expect(fixture.tool.execute("inspect", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
        details: { tokens: 10_000, contextWindow: 8_000, percent: 125 },
      });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("honors cancellation and invalidates retained tools on disposal", async () => {
    const fixture = await createInsights();
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled inspection"));
    try {
      await expect(fixture.tool.execute("cancel", {}, controller.signal, undefined, {} as never)).rejects.toThrow(/caller cancelled inspection/iu);
      const retained = fixture.tool;
      await fixture.context.fiber.dispose();
      expect(fixture.tools.snapshot().customTools).toEqual([]);
      await expect(fixture.panels.snapshot()).resolves.toEqual([]);
      await expect(retained.execute("stale", {}, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });
});
