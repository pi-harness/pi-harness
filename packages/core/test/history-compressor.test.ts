import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import historyCompressorPlugin from "../src/plugins/history-compressor.js";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];

async function fixture(usagePercent = 90, isIdle?: boolean) {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  const compact = vi.fn().mockResolvedValue(undefined);
  const usage = { percent: usagePercent };
  const session = { getContextUsage: () => ({ percent: usage.percent }), compact, isIdle };
  context.provide("piRuntime", { session } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(historyCompressorPlugin, { enabled: true, thresholdPercent: 85 });
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "compress_history");
  if (tool === undefined) throw new Error("compress_history was not registered");
  return { context, tools, panels, tool, compact, session, usage };
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

  test("queues a confirmed compaction until the busy agent run settles", async () => {
    const { context, tool, compact, panels, session } = await fixture(10, false);
    await expect(tool.execute("manual", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({
      content: [{ type: "text", text: "Session compaction queued until the current agent run settles." }],
      details: { compacted: false, queued: true },
    });
    expect(compact).not.toHaveBeenCalled();
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { queued: true, compactions: 0 } }]);
    session.isIdle = true;
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { queued: false, compactions: 1 } }]);
  });

  test("defers automatic compaction from agent_end until the session reports it is idle", async () => {
    const { context, compact, session } = await fixture(90, false);
    context.emit("pi/session-event", { type: "agent_end" } as never);
    await Promise.resolve();
    expect(compact).not.toHaveBeenCalled();
    session.isIdle = true;
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
  });

  test("drops a queued automatic compaction when usage fell back below the threshold", async () => {
    const { context, compact, session, panels, usage } = await fixture(90, false);
    context.emit("pi/session-event", { type: "agent_end" } as never);
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { queued: true, lastUsagePercent: 90 } }]);
    usage.percent = 12;
    session.isIdle = true;
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    await Promise.resolve();
    expect(compact).not.toHaveBeenCalled();
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { queued: false, compactions: 0, lastUsagePercent: 12 } }]);
  });

  test("still runs a queued explicit compaction after usage fell below the threshold", async () => {
    const { context, tool, compact, session, usage } = await fixture(90, false);
    await expect(tool.execute("manual", { confirm: true }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { queued: true } });
    usage.percent = 12;
    session.isIdle = true;
    context.emit("pi/session-event", { type: "agent_settled" } as never);
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
  });

  test("requires explicit confirmation and removes registrations on disposal", async () => {
    const { context, tool, tools, panels } = await fixture(10);
    await expect(tool.execute("manual", { confirm: false }, undefined, undefined, {} as never)).rejects.toThrow(/confirm=true/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
});
