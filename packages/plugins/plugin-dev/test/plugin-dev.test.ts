import { Context } from "@deepseek-ai/cordis";
import { describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import pluginDevPlugin from "../src/index.js";

type RuntimeFixture = {
  readonly context: Context;
  readonly tool: ReturnType<PiToolRegistry["snapshot"]>["customTools"][number];
  readonly panels: PiPluginUiRegistry;
  readonly reloads: () => number;
};

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void; readonly reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function createPluginDev(options: { idle?: boolean; reload?: () => Promise<void> } = {}): Promise<RuntimeFixture> {
  const context = new Context();
  const panels = new PiPluginUiRegistry();
  const tools = new PiToolRegistry();
  let reloads = 0;
  context.provide("piRuntime", {
    session: {
      isIdle: options.idle ?? true,
      reload: async () => {
        reloads += 1;
        await options.reload?.();
      },
    },
  } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(pluginDevPlugin);
  const tool = tools.snapshot().customTools.find((candidate) => candidate.name === "plugin_dev_reload");
  if (tool === undefined) throw new Error("Plugin Dev reload tool was not registered");
  return { context, tool, panels, reloads: () => reloads };
}

describe("plugin dev reload boundaries", () => {
  test("declares a bounded reason and validates descriptor-only parameters before reloading", async () => {
    const fixture = await createPluginDev();
    let accessed = false;
    const accessor = {} as { reason?: string };
    Object.defineProperty(accessor, "reason", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("reason getter executed");
      },
    });
    const symbolProperty = { reason: "fixture" } as Record<PropertyKey, unknown>;
    symbolProperty[Symbol("unexpected")] = true;
    try {
      expect(fixture.tool.parameters).toMatchObject({ properties: { reason: { type: "string", maxLength: 1_000 } } });
      expect(fixture.tool.label).toBe("Reload Pi session resources");
      expect(fixture.tool.description).toMatch(/extensions.*skills.*prompts.*themes.*context files/iu);
      await expect(fixture.tool.execute("accessor", accessor, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*data properties/iu);
      expect(accessed).toBe(false);
      await expect(fixture.tool.execute("unknown", { reason: "fixture", unknown: true }, undefined, undefined, {} as never)).rejects.toThrow(
        /unknown property/iu,
      );
      await expect(fixture.tool.execute("symbol", symbolProperty, undefined, undefined, {} as never)).rejects.toThrow(/unknown property/iu);
      await expect(fixture.tool.execute("null", null, undefined, undefined, {} as never)).rejects.toThrow(/parameters.*object/iu);
      await expect(fixture.tool.execute("array", [], undefined, undefined, {} as never)).rejects.toThrow(/parameters.*object/iu);
      await expect(fixture.tool.execute("date", new Date(), undefined, undefined, {} as never)).rejects.toThrow(/parameters.*plain object/iu);
      await expect(fixture.tool.execute("type", { reason: 42 }, undefined, undefined, {} as never)).rejects.toThrow(/reason must be a string/iu);
      await expect(fixture.tool.execute("long", { reason: "x".repeat(1_001) }, undefined, undefined, {} as never)).rejects.toThrow(
        /reason.*0-1000 characters/iu,
      );
      await expect(fixture.tool.execute("nul", { reason: "reload\0now" }, undefined, undefined, {} as never)).rejects.toThrow(/reason.*NUL/iu);
      expect(fixture.reloads()).toBe(0);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("queues reload until the active agent run settles", async () => {
    const reload = deferred();
    const fixture = await createPluginDev({ idle: false, reload: () => reload.promise });
    const result = fixture.tool.execute("queued", { reason: "reload after this turn" }, undefined, undefined, {} as never);
    try {
      await Promise.resolve();
      expect(fixture.reloads()).toBe(0);
      await expect(result).resolves.toMatchObject({
        details: { status: "queued", reason: "reload after this turn" },
      });
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { status: "queued", reason: "reload after this turn" } }]);

      fixture.context.emit("pi/session-event", { type: "agent_settled" });
      await expect.poll(fixture.reloads).toBe(1);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { status: "running" } }]);
      reload.resolve();
      await expect.poll(async () => (await fixture.panels.snapshot())[0]?.data).toMatchObject({ status: "reloaded" });
    } finally {
      reload.resolve();
      await Promise.allSettled([result]);
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects overlapping reloads instead of invoking AgentSession.reload concurrently", async () => {
    const reload = deferred();
    const fixture = await createPluginDev({ reload: () => reload.promise });
    let second: ReturnType<(typeof fixture.tool)["execute"]> | undefined;
    try {
      const first = fixture.tool.execute("first", { reason: "first" }, undefined, undefined, {} as never);
      await expect.poll(fixture.reloads).toBe(1);
      second = fixture.tool.execute("second", { reason: "second" }, undefined, undefined, {} as never);
      let secondOutcome = "pending";
      void second.then(
        () => {
          secondOutcome = "resolved";
        },
        () => {
          secondOutcome = "rejected";
        },
      );
      await expect.poll(() => secondOutcome).toBe("rejected");
      await expect(second).rejects.toThrow(/reload.*already.*progress/iu);
      expect(fixture.reloads()).toBe(1);
      reload.resolve();
      await expect(first).resolves.toMatchObject({ details: { status: "reloaded", reason: "first" } });
    } finally {
      reload.resolve();
      if (second !== undefined) await Promise.allSettled([second]);
      await fixture.context.fiber.dispose();
    }
  });

  test("does not start an already-cancelled reload request", async () => {
    const fixture = await createPluginDev();
    const caller = new AbortController();
    caller.abort(new Error("cancel request"));
    try {
      await expect(fixture.tool.execute("cancelled", {}, caller.signal, undefined, {} as never)).rejects.toThrow(/reload.*cancelled/iu);
      expect(fixture.reloads()).toBe(0);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { status: "cancelled" } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("lets a caller stop waiting without pretending the underlying reload was cancelled", async () => {
    const reload = deferred();
    const fixture = await createPluginDev({ reload: () => reload.promise });
    const caller = new AbortController();
    try {
      const result = fixture.tool.execute("cancel-wait", { reason: "slow reload" }, caller.signal, undefined, {} as never);
      await expect.poll(fixture.reloads).toBe(1);
      caller.abort(new Error("caller stopped"));
      let outcome = "pending";
      void result.then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );
      await expect.poll(() => outcome).toBe("rejected");
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { status: "running" } }]);

      reload.resolve();
      await expect.poll(async () => (await fixture.panels.snapshot())[0]?.data).toMatchObject({ status: "reloaded", reason: "slow reload" });
    } finally {
      reload.resolve();
      await fixture.context.fiber.dispose();
    }
  });

  test("bounds reload failures without invoking hostile error coercion", async () => {
    let coerced = false;
    const hostileError = new Error();
    Object.defineProperty(hostileError, "message", {
      get() {
        coerced = true;
        throw new Error("hostile error coercion executed");
      },
    });
    let attempt = 0;
    const fixture = await createPluginDev({
      reload: () => {
        attempt += 1;
        return Promise.reject(attempt === 1 ? new Error("x".repeat(3_000)) : hostileError);
      },
    });
    try {
      await expect(fixture.tool.execute("long-error", {}, undefined, undefined, {} as never)).rejects.toThrow();
      let panel = (await fixture.panels.snapshot())[0];
      expect((panel?.data as { error: string }).error).toHaveLength(2_000);
      expect(panel?.data).toMatchObject({ limits: { reasonCharacters: 1_000, errorCharacters: 2_000 } });

      await expect(fixture.tool.execute("hostile-error", {}, undefined, undefined, {} as never)).rejects.toBe(hostileError);
      expect(coerced).toBe(false);
      panel = (await fixture.panels.snapshot())[0];
      expect(panel?.data).toMatchObject({ status: "failed", error: "Unknown plugin reload error" });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not expose mutable reload state through tool results or panel snapshots", async () => {
    const fixture = await createPluginDev();
    try {
      const result = await fixture.tool.execute("reload", { reason: "original" }, undefined, undefined, {} as never);
      (result.details as { reason: string }).reason = "mutated tool result";

      const firstPanel = (await fixture.panels.snapshot())[0];
      expect(firstPanel?.data).toMatchObject({ status: "reloaded", reason: "original" });
      (firstPanel?.data as { reason: string }).reason = "mutated panel";

      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { status: "reloaded", reason: "original" } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("stops waiting for an active reload when the plugin is disposed", async () => {
    const reload = deferred();
    const fixture = await createPluginDev({ reload: () => reload.promise });
    const result = fixture.tool.execute("dispose", {}, undefined, undefined, {} as never);
    let outcome = "pending";
    void result.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    try {
      await expect.poll(fixture.reloads).toBe(1);
      await fixture.context.fiber.dispose();
      await expect.poll(() => outcome).toBe("rejected");
    } finally {
      reload.resolve();
      await Promise.allSettled([result]);
    }
  });
});
