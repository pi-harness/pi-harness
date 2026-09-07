import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import planExecutePlugin from "../src/plugins/plan-execute.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

async function fixture() {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(planExecutePlugin);
  contexts.push(context);
  const find = (name: string) => {
    const tool = tools.snapshot().customTools.find((item) => item.name === name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  };
  return { context, tools, panels, create: find("plan_create"), advance: find("plan_advance") };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("plan execute", () => {
  test("creates and advances a bounded plan with strict sequential tools", async () => {
    const { create, advance, panels } = await fixture();
    for (const tool of [create, advance]) {
      expect(tool.executionMode).toBe("sequential");
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
    await expect(create.execute("create", { title: "Release", steps: ["Test", "Ship"] }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: {
        title: "Release",
        steps: [
          { id: 1, status: "pending" },
          { id: 2, status: "pending" },
        ],
      },
    });
    const inProgress = await advance.execute("advance", { step: 1, status: "in_progress" }, undefined, undefined, {} as never);
    expect((inProgress.details as { steps: Array<{ id: number; status: string }> }).steps[0]).toMatchObject({ id: 1, status: "in_progress" });
    const done = await advance.execute("advance", { step: 1, status: "done" }, undefined, undefined, {} as never);
    expect((done.details as { steps: Array<{ id: number; status: string }> }).steps[0]).toMatchObject({ id: 1, status: "done" });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { title: "Release", completed: 1, total: 2 } }]);
  });

  test("rejects invalid plans and cleans up both tools and panel", async () => {
    const { context, create, tools, panels } = await fixture();
    await expect(create.execute("create", { title: "", steps: ["x"] }, undefined, undefined, {} as never)).rejects.toThrow(/title/iu);
    await expect(create.execute("create", { title: "x", steps: [] }, undefined, undefined, {} as never)).rejects.toThrow(/1-50/iu);
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
      await context.plugin(planExecutePlugin, { unexpected: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/config keys: unexpected/iu);
    await context.fiber.dispose();
  });

  test("does not expose mutable plan state through tool results or panel snapshots", async () => {
    const { create, advance, panels } = await fixture();
    const result = await create.execute("create", { title: "Protected", steps: ["One"] }, undefined, undefined, {} as never);
    (result.details as { title: string }).title = "mutated";
    await expect(advance.execute("advance", { step: 1, status: "done" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { title: "Protected", steps: [{ title: "One", status: "done" }] },
    });
    const panel = (await panels.snapshot())[0];
    (panel?.data as { title: string }).title = "panel-mutated";
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { title: "Protected" } }]);
  });
});
