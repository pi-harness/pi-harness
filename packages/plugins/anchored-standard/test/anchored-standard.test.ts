import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";
import anchoredStandardPlugin from "../src/index.js";

const contexts: Context[] = [];

async function fixture() {
  const context = new Context();
  context.provide("piTools", new PiToolRegistry());
  context.provide("piPluginUi", new PiPluginUiRegistry());
  await context.plugin(anchoredStandardPlugin, { maxToolCalls: 2, allowedTools: ["read"] });
  contexts.push(context);
  const tool = context.piTools.snapshot().customTools.find((item) => item.name === "trajectory_anchor_check");
  if (tool === undefined) throw new Error("trajectory_anchor_check was not registered");
  return { context, tool, tools: context.get("piTools"), panels: context.get("piPluginUi") };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("anchored standard", () => {
  test("registers a strict sequential audit tool and reports a valid run", async () => {
    const { context, tool } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });

    context.emit("pi/session-event", { type: "agent_start" } as never);
    context.emit("pi/session-event", { type: "tool_execution_start", toolName: "read" } as never);
    context.emit("pi/session-event", { type: "agent_end" } as never);
    await expect(tool.execute("check", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { status: "idle", events: 3, toolCalls: 1, violations: [] },
    });
  });

  test("records budget and disallowed-tool violations and removes registrations on disposal", async () => {
    const { context, tool, tools, panels } = await fixture();
    context.emit("pi/session-event", { type: "agent_start" } as never);
    context.emit("pi/session-event", { type: "tool_execution_start", toolName: "bash" } as never);
    context.emit("pi/session-event", { type: "tool_execution_start", toolName: "bash" } as never);
    context.emit("pi/session-event", { type: "tool_execution_start", toolName: "bash" } as never);
    const result = await tool.execute("check", {}, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ status: "violated", toolCalls: 3 });
    expect((result.details as { violations: Array<{ code: string }> }).violations.map((item) => item.code)).toEqual(
      expect.arrayContaining(["tool_budget", "disallowed_tool"]),
    );

    await context.fiber.dispose();
    expect(tools?.snapshot().customTools).toHaveLength(0);
    await expect(panels?.snapshot()).resolves.toHaveLength(0);
  });

  test("rejects unknown configuration keys before activation", async () => {
    const context = new Context();
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await expect(context.plugin(anchoredStandardPlugin, { unexpected: true } as never)).rejects.toThrow(/unknown.*config/iu);
  });
});
