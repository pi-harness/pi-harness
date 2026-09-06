import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import annotationPlugin from "../src/plugins/annotation.js";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];

async function fixture() {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(annotationPlugin);
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "annotation_manage");
  if (tool === undefined) throw new Error("annotation_manage was not registered");
  return { context, tools, panels, tool };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("annotation", () => {
  test("collects, lists, renders, removes, and clears annotations", async () => {
    const { tool, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    await expect(
      tool.execute("add", { action: "add", quote: "A quoted passage", note: "Important" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      details: { id: 1, quote: "A quoted passage", note: "Important" },
    });
    const prompt = await tool.execute("prompt", { action: "prompt", question: "What does this imply?" }, undefined, undefined, {} as never);
    expect(prompt.content[0]).toMatchObject({ type: "text" });
    expect((prompt.content[0] as { text: string }).text).toContain("A quoted passage");
    await expect(tool.execute("remove", { action: "remove", id: 1 }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { count: 0, annotations: [] },
    });
    await expect(tool.execute("clear", { action: "clear" }, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { count: 0 } });
    await expect(panels.snapshot()).resolves.toMatchObject([{ id: "annotation-panel", data: { count: 0, annotations: [] } }]);
  });

  test("rejects missing fields and disposes its registrations", async () => {
    const { context, tools, panels, tool } = await fixture();
    await expect(tool.execute("prompt", { action: "prompt", question: "missing annotations" }, undefined, undefined, {} as never)).rejects.toThrow(
      /at least one annotation/iu,
    );
    await expect(tool.execute("add", { action: "add", quote: "   " }, undefined, undefined, {} as never)).rejects.toThrow(/quote/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });

  test("rejects unknown configuration before activation", async () => {
    const context = new Context();
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", new PiPluginUiRegistry());
    let rejected = false;
    try {
      await context.plugin(annotationPlugin, { unexpected: true });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    await context.fiber.dispose();
  });
});
