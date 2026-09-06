import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import historyCompressorPlugin from "../src/plugins/history-compressor.js";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];

async function fixture(usagePercent = 90) {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  const compact = vi.fn().mockResolvedValue(undefined);
  context.provide("piRuntime", { session: { getContextUsage: () => ({ percent: usagePercent }), compact } } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(historyCompressorPlugin, { enabled: true, thresholdPercent: 85 });
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "compress_history");
  if (tool === undefined) throw new Error("compress_history was not registered");
  return { context, tools, panels, tool, compact };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("history compressor", () => {
  test("compacts explicitly and automatically at the configured threshold", async () => {
    const { context, tool, compact, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    await expect(tool.execute("manual", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { compacted: true, automatic: false },
    });
    context.emit("pi/session-event", { type: "agent_end" } as never);
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(2));
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { compactions: 2, lastUsagePercent: 90 } }]);
  });

  test("requires explicit confirmation and removes registrations on disposal", async () => {
    const { context, tool, tools, panels } = await fixture(10);
    await expect(tool.execute("manual", { confirm: false }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
});
