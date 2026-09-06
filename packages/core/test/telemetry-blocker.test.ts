import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import telemetryBlockerPlugin from "../src/plugins/telemetry-blocker.js";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

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
      details: { blocked: 2, names: ["usage", long.slice(0, 80)] },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { enabled: false, blocked: 2, names: ["usage", long.slice(0, 80)] } }]);
  });

  test("rejects empty event names and cleans up registrations", async () => {
    const { context, tools, panels } = await fixture();
    expect(() => context.emit("pi/telemetry", { name: "   " })).toThrow(/must not be empty/iu);
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
