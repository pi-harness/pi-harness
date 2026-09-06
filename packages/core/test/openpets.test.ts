import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";
import openPetsPlugin from "../src/plugins/openpets.js";

type OpenPetsFixture = {
  readonly context: Context;
  readonly tool: ReturnType<PiToolRegistry["snapshot"]>["customTools"][number];
  readonly panels: PiPluginUiRegistry;
  readonly entries: unknown[];
};

async function createOpenPets(
  options: { entries?: unknown[]; config?: Record<string, unknown>; append?: (customType: string, data: unknown) => string } = {},
): Promise<OpenPetsFixture> {
  const context = new Context();
  const panels = new PiPluginUiRegistry();
  const tools = new PiToolRegistry();
  const entries = options.entries ?? [];
  context.provide("piSession", {
    manager: {
      getEntries: () => entries,
      appendCustomEntry:
        options.append ??
        ((customType: string, data: unknown) => {
          entries.push({ type: "custom", customType, data });
          return String(entries.length);
        }),
    },
  } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(openPetsPlugin, options.config);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "pet_react");
  if (tool === undefined) throw new Error("OpenPets tool was not registered");
  return { context, tool, panels, entries };
}

describe("OpenPets boundaries", () => {
  test("declares and enforces a bounded companion name configuration", async () => {
    expect(openPetsPlugin.Config.dict?.name?.meta).toMatchObject({ min: 1, max: 128 });

    for (const config of [{ name: "" }, { name: "x".repeat(129) }, { name: "pet\0name" }, { unknown: true }]) {
      await expect(createOpenPets({ config })).rejects.toThrow(/(?:OpenPets.*(?:name|config)|invalid config)/iu);
    }
  });

  test("declares strict actions and validates descriptor-only parameters before persisting", async () => {
    const fixture = await createOpenPets();
    let accessed = false;
    const accessor = {} as { action?: string };
    Object.defineProperty(accessor, "action", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("OpenPets action getter executed");
      },
    });
    try {
      expect(fixture.tool.parameters).toMatchObject({
        properties: {
          action: { anyOf: [{ const: "status" }, { const: "feed" }, { const: "play" }, { const: "set_mood" }] },
          mood: { anyOf: [{ const: "idle" }, { const: "focused" }, { const: "happy" }, { const: "concerned" }] },
        },
      });
      await expect(fixture.tool.execute("accessor", accessor, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(fixture.tool.execute("unknown", { action: "status", unknown: true }, undefined, undefined, {} as never)).rejects.toThrow(
        /unknown property/iu,
      );
      await expect(fixture.tool.execute("null", null, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*object/iu);
      await expect(fixture.tool.execute("date", new Date(), undefined, undefined, {} as never)).rejects.toThrow(/parameters.*plain object/iu);
      await expect(fixture.tool.execute("action", { action: "dance" }, undefined, undefined, {} as never)).rejects.toThrow(/action must be/iu);
      await expect(fixture.tool.execute("mood", { action: "set_mood", mood: "sleepy" }, undefined, undefined, {} as never)).rejects.toThrow(/mood must be/iu);
      await expect(fixture.tool.execute("ignored", { action: "feed", mood: "happy" }, undefined, undefined, {} as never)).rejects.toThrow(
        /mood.*only.*set_mood/iu,
      );
      const caller = new AbortController();
      caller.abort(new Error("cancel pet action"));
      await expect(fixture.tool.execute("cancelled", { action: "feed" }, caller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
      expect(fixture.entries).toHaveLength(0);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("restores a valid recent state while keeping the configured companion name", async () => {
    const entries = [
      {
        type: "custom",
        customType: "pi-harness/openpets",
        data: {
          name: "old name",
          mood: "happy",
          energy: 73,
          interactions: 9,
          lastEvent: "play",
          updatedAt: "2026-09-05T10:00:00.000Z",
        },
      },
    ];
    const fixture = await createOpenPets({ entries, config: { name: "Configured Pet" } });
    try {
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        {
          data: {
            name: "Configured Pet",
            mood: "happy",
            energy: 73,
            interactions: 9,
            lastEvent: "play",
            updatedAt: "2026-09-05T10:00:00.000Z",
            recovery: { sessionEntries: 1, scanned: 1, truncated: false, restored: true },
            limits: { nameCharacters: 128, recoveryEntries: 10_000 },
          },
        },
      ]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not invoke accessors while recovering malformed persisted state", async () => {
    let accessed = false;
    const data = {} as Record<string, unknown>;
    Object.defineProperty(data, "mood", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("persisted OpenPets getter executed");
      },
    });
    const fixture = await createOpenPets({ entries: [{ type: "custom", customType: "pi-harness/openpets", data }] });
    try {
      expect(accessed).toBe(false);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        { data: { name: "Pi", mood: "idle", energy: 80, interactions: 0, lastEvent: "session_start", recovery: { restored: false } } },
      ]);
      expect(accessed).toBe(false);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not recover stale companion state outside the bounded entry window", async () => {
    const entries = [
      {
        type: "custom",
        customType: "pi-harness/openpets",
        data: { name: "stale", mood: "concerned", energy: 1, interactions: 99, lastEvent: "feed", updatedAt: "2026-01-01T00:00:00.000Z" },
      },
      ...Array.from({ length: 10_000 }, () => ({ type: "message" })),
    ];
    const fixture = await createOpenPets({ entries });
    try {
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        {
          data: {
            name: "Pi",
            mood: "idle",
            energy: 80,
            interactions: 0,
            recovery: { sessionEntries: 10_001, scanned: 10_000, truncated: true, restored: false },
          },
        },
      ]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("saturates interaction counts and publishes immutable tool, persistence, and panel snapshots", async () => {
    const entries: unknown[] = [
      {
        type: "custom",
        customType: "pi-harness/openpets",
        data: {
          name: "Pi",
          mood: "idle",
          energy: 80,
          interactions: Number.MAX_SAFE_INTEGER,
          lastEvent: "session_start",
          updatedAt: "2026-09-05T10:00:00.000Z",
        },
      },
    ];
    const fixture = await createOpenPets({ entries });
    try {
      const result = await fixture.tool.execute("feed", { action: "feed" }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ name: "Pi", mood: "happy", energy: 100, interactions: Number.MAX_SAFE_INTEGER, lastEvent: "feed" });
      const persisted = (entries.at(-1) as { data: { mood: string; interactions: number } }).data;
      expect(persisted).toMatchObject({ mood: "happy", interactions: Number.MAX_SAFE_INTEGER });

      (result.details as { name: string; mood: string; interactions: number }).name = "mutated";
      (result.details as { name: string; mood: string; interactions: number }).mood = "concerned";
      (result.details as { name: string; mood: string; interactions: number }).interactions = 0;
      expect(persisted).toMatchObject({ mood: "happy", interactions: Number.MAX_SAFE_INTEGER });

      const firstPanel = (await fixture.panels.snapshot())[0];
      expect(firstPanel?.data).toMatchObject({ name: "Pi", mood: "happy", interactions: Number.MAX_SAFE_INTEGER });
      (firstPanel?.data as { mood: string }).mood = "concerned";
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { name: "Pi", mood: "happy", interactions: Number.MAX_SAFE_INTEGER } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("reads session events without accessors and deduplicates repeated tool failures", async () => {
    const fixture = await createOpenPets();
    let typeAccessed = false;
    let errorAccessed = false;
    const typeAccessor = {} as { type?: string };
    Object.defineProperty(typeAccessor, "type", {
      enumerable: true,
      get() {
        typeAccessed = true;
        throw new Error("session event type getter executed");
      },
    });
    const errorAccessor = { type: "tool_execution_end" } as { type: string; isError?: boolean };
    Object.defineProperty(errorAccessor, "isError", {
      enumerable: true,
      get() {
        errorAccessed = true;
        throw new Error("session event error getter executed");
      },
    });
    try {
      expect(() => fixture.context.emit("pi/session-event", typeAccessor as never)).not.toThrow();
      expect(() => fixture.context.emit("pi/session-event", errorAccessor as never)).not.toThrow();
      expect(typeAccessed).toBe(false);
      expect(errorAccessed).toBe(false);
      expect(fixture.entries).toHaveLength(0);

      fixture.context.emit("pi/session-event", { type: "agent_start" } as never);
      fixture.context.emit("pi/session-event", { type: "tool_execution_end", isError: false } as never);
      fixture.context.emit("pi/session-event", { type: "tool_execution_end", isError: true } as never);
      fixture.context.emit("pi/session-event", { type: "tool_execution_end", isError: true } as never);
      fixture.context.emit("pi/session-event", { type: "agent_end", messages: [], willRetry: false } as never);

      expect(fixture.entries).toHaveLength(3);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { mood: "happy", energy: 80, lastEvent: "agent_end" } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("isolates event persistence failures and exposes bounded failure status", async () => {
    const failure = new Error("x".repeat(3_000));
    const fixture = await createOpenPets({
      append() {
        throw failure;
      },
    });
    try {
      expect(() => fixture.context.emit("pi/session-event", { type: "agent_start" } as never)).not.toThrow();
      let panel = (await fixture.panels.snapshot())[0];
      expect(panel?.data).toMatchObject({
        mood: "focused",
        energy: 75,
        persistence: { attempts: 1, failures: 1 },
        limits: { persistenceErrorCharacters: 2_000 },
      });
      expect((panel?.data as { persistence: { lastError: string } }).persistence.lastError).toHaveLength(2_000);

      await expect(fixture.tool.execute("feed", { action: "feed" }, undefined, undefined, {} as never)).rejects.toBe(failure);
      panel = (await fixture.panels.snapshot())[0];
      expect(panel?.data).toMatchObject({ mood: "happy", energy: 100, interactions: 1, persistence: { attempts: 2, failures: 2 } });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });
});
