import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import telemetryBlockerPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

async function fixture() {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(telemetryBlockerPlugin);
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "telemetry_status");
  if (tool === undefined) throw new Error("telemetry_status was not registered");
  return { context, tools, panels, tool };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("telemetry blocker", () => {
  test("blocks telemetry and reports only bounded event names", async () => {
    const { context, tool, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    context.emit("pi/telemetry", { name: "usage", properties: { secret: "should-not-retain" } });
    const long = "x".repeat(200);
    context.emit("pi/telemetry", { name: long });
    await expect(tool.execute("status", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { discarded: 0, observed: 2, names: ["usage", long.slice(0, 80)] },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { enabled: false, discarded: 0, observed: 2, names: ["usage", long.slice(0, 80)] } }]);
  });

  test("rejects empty event names and cleans up registrations", async () => {
    const { context, tools, panels } = await fixture();
    expect(() => context.emit("pi/telemetry", { name: "   " })).not.toThrow();
    expect(() => context.piTelemetry.send({ name: "   " })).toThrow(/nonempty/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });

  test("rejects unknown plugin configuration before activation", async () => {
    const context = new Context();
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", new PiPluginUiRegistry());
    let error: unknown;
    try {
      await context.plugin(telemetryBlockerPlugin, { unexpected: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/config keys: unexpected/iu);
    await context.fiber.dispose();
  });
});

test("bounds retained names and never invokes event getters", async () => {
  const { context } = await fixture();
  const service = context.piTelemetry;
  for (let i = 0; i < 150; i++) service.send({ name: `event-${i}` });
  expect(service.snapshot().names).toHaveLength(100);
  const getter = vi.fn(() => "private");
  expect(() => service.send(Object.defineProperty({}, "name", { get: getter }) as never)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() => context.emit("pi/telemetry", null as never)).not.toThrow();
});

test("rejects cancelled or disposed status calls and strict parameters", async () => {
  const { context, tool } = await fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(tool.execute("cancel", {}, abort.signal, undefined, {} as never)).rejects.toThrow(/cancel/i);
  await expect(tool.execute("params", { extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/parameter/i);
  await context.fiber.dispose();
  await expect(tool.execute("disposed", {}, undefined, undefined, {} as never)).rejects.toThrow(/disposed|cancel/i);
});

test("keeps later bus listeners running when event name inspection throws", async () => {
  const { context } = await fixture();
  const later = vi.fn();
  context.on("pi/telemetry", later);
  const throwing = new Proxy(
    {},
    {
      getOwnPropertyDescriptor(target, key) {
        if (key === "name") throw new Error("malformed event");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  expect(() => context.emit("pi/telemetry", throwing as never)).not.toThrow();
  expect(later).toHaveBeenCalledTimes(1);
  expect(context.piTelemetry.snapshot()).toMatchObject({ discarded: 0, observed: 0 });
});
