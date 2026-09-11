import { Context } from "@deepseek-ai/cordis";
import assert from "node:assert/strict";
import { afterEach, describe, expect, test } from "vitest";
import annotationPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

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
  test("lists readable annotation bodies and notes with continuation metadata", async () => {
    const { tool } = await fixture();
    for (const quote of ["First passage", "Second passage"])
      await tool.execute("add", { action: "add", quote, note: "Keep the detail" }, undefined, undefined, {} as never);
    const result = await tool.execute("list", { action: "list", offset: 1, limit: 1 }, undefined, undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Second passage");
    expect(JSON.parse(text)).toMatchObject({
      count: 2,
      offset: 1,
      returned: 1,
      nextOffset: null,
      truncated: false,
      annotations: [{ id: 2, note: "Keep the detail" }],
    });
    expect(result.details).toMatchObject({ count: 2, annotations: [{ id: 1 }, { id: 2 }] });
  });

  test("keeps model-visible pages within 64 KiB without losing any full annotation", async () => {
    const { tool } = await fixture();
    const quote = "\u0001".repeat(4_000),
      note = "\u0002".repeat(1_000);
    for (let n = 0; n < 5; n++) await tool.execute("add", { action: "add", quote, note }, undefined, undefined, {} as never);
    const ids: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await tool.execute("page", { action: "list", offset, limit: 5 }, undefined, undefined, {} as never);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('"annotations":');
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
      const page: unknown = JSON.parse(text);
      assert(page !== null && typeof page === "object");
      assert("returned" in page && typeof page.returned === "number");
      assert("annotations" in page && Array.isArray(page.annotations));
      assert("nextOffset" in page && (page.nextOffset === null || typeof page.nextOffset === "number"));
      expect(page.returned).toBeGreaterThan(0);
      expect(page.returned).toBe(page.annotations.length);
      for (const item of page.annotations as unknown[]) {
        assert(item !== null && typeof item === "object" && "quote" in item && "note" in item && "id" in item);
        assert(typeof item.id === "number" && Number.isInteger(item.id));
        expect(item.quote).toBe(quote);
        expect(item.note).toBe(note);
        ids.push(item.id);
      }
      expect(page.nextOffset === null || page.nextOffset > offset).toBe(true);
      offset = page.nextOffset;
    }
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  test.each([{ offset: -1 }, { offset: null }, { limit: 0 }, { limit: 1.5 }, { offset: 51 }])("rejects invalid list pagination %#", async (pagination) => {
    const { tool } = await fixture();
    await expect(tool.execute("bad", { action: "list", ...pagination }, undefined, undefined, {} as never)).rejects.toThrow(/offset|limit/iu);
  });

  test("does not mutate annotations after cancellation or disposal", async () => {
    const { context, tool, panels } = await fixture();
    const controller = new AbortController();
    const pending = tool.execute("cancel", { action: "add", quote: "must not appear" }, controller.signal, undefined, {} as never);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancel/iu);
    expect((await panels.snapshot())[0]?.data).toMatchObject({ count: 0 });
    await context.fiber.dispose();
    await expect(tool.execute("stale", { action: "add", quote: "stale" }, undefined, undefined, {} as never)).rejects.toThrow(/cancel|disposed/iu);
  });

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
