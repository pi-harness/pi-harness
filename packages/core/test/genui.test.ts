import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import genUiPlugin from "../src/plugins/genui.js";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function setup(): Promise<{ context: Context; panels: PiPluginUiRegistry; tools: PiToolRegistry }> {
  const context = new Context();
  contexts.push(context);
  const panels = new PiPluginUiRegistry();
  const tools = new PiToolRegistry();
  context.provide("piPluginUi", panels);
  context.provide("piTools", tools);
  await context.plugin(genUiPlugin);
  return { context, panels, tools };
}

function tool(tools: PiToolRegistry) {
  const registered = tools.snapshot().customTools.find((candidate) => candidate.name === "genui_render");
  if (registered === undefined) throw new Error("genui_render was not registered");
  return registered;
}

describe("GenUI plugin", () => {
  test("normalizes bounded text, badge, and decimal progress blocks", async () => {
    const { panels, tools } = await setup();
    const result = await tool(tools).execute(
      "render",
      {
        title: "  Deploy status  ",
        blocks: [
          { type: "text", label: " Detail ", value: " <script>alert(1)</script> " },
          { type: "badge", label: " State ", value: " Ready ", tone: "success" },
          { type: "progress", label: " Coverage ", value: "87.5", tone: "info" },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );

    expect(result).toMatchObject({
      details: {
        title: "Deploy status",
        blocks: [
          { type: "text", label: "Detail", value: "<script>alert(1)</script>", tone: "neutral" },
          { type: "badge", label: "State", value: "Ready", tone: "success" },
          { type: "progress", label: "Coverage", value: 87.5, tone: "info" },
        ],
      },
    });
    const data = (await panels.snapshot())[0]?.data;
    expect(data).toMatchObject({
      rendered: 1,
      limits: { blocks: 12, title: 256, label: 256, value: 4_000, totalText: 16_384 },
      latest: { title: "Deploy status" },
    });
  });

  test("does not execute parameter or block accessors", async () => {
    const { tools } = await setup();
    let parameterAccessed = false;
    const raw: Record<string, unknown> = { blocks: [{ type: "text", label: "label", value: "value" }] };
    Object.defineProperty(raw, "title", {
      enumerable: true,
      get() {
        parameterAccessed = true;
        throw new Error("title getter executed");
      },
    });
    await expect(tool(tools).execute("params", raw as never, undefined, undefined, {} as never)).rejects.toThrow(/data propert/iu);
    expect(parameterAccessed).toBe(false);

    let blockAccessed = false;
    const block: Record<string, unknown> = { type: "text", value: "value" };
    Object.defineProperty(block, "label", {
      enumerable: true,
      get() {
        blockAccessed = true;
        throw new Error("label getter executed");
      },
    });
    await expect(tool(tools).execute("block", { title: "title", blocks: [block] }, undefined, undefined, {} as never)).rejects.toThrow(/data propert/iu);
    expect(blockAccessed).toBe(false);
  });

  test("rejects invalid shapes, types, tones, progress syntax, and total text overflow", async () => {
    const { tools } = await setup();
    const render = tool(tools);
    await expect(
      render.execute("type", { title: "title", blocks: [{ type: "video", label: "x", value: "y" }] }, undefined, undefined, {} as never),
    ).rejects.toThrow(/block type/iu);
    await expect(
      render.execute("tone", { title: "title", blocks: [{ type: "badge", label: "x", value: "y", tone: "rainbow" }] }, undefined, undefined, {} as never),
    ).rejects.toThrow(/tone/iu);
    await expect(
      render.execute("progress", { title: "title", blocks: [{ type: "progress", label: "x", value: "0x10" }] }, undefined, undefined, {} as never),
    ).rejects.toThrow(/decimal.*0.*100/iu);
    await expect(
      render.execute("unknown", { title: "title", blocks: [{ type: "text", label: "x", value: "y", extra: true }] }, undefined, undefined, {} as never),
    ).rejects.toThrow(/unknown propert/iu);
    await expect(
      render.execute(
        "total",
        { title: "title", blocks: Array.from({ length: 5 }, (_, index) => ({ type: "text", label: `label-${index}`, value: "x".repeat(4_000) })) },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/total text.*16384/iu);
  });

  test("does not replace the last successful card when a later render is invalid", async () => {
    const { panels, tools } = await setup();
    const render = tool(tools);
    await render.execute("valid", { title: "valid", blocks: [{ type: "badge", label: "state", value: "ok" }] }, undefined, undefined, {} as never);
    await expect(
      render.execute("invalid", { title: "invalid", blocks: [{ type: "progress", label: "state", value: "101" }] }, undefined, undefined, {} as never),
    ).rejects.toThrow(/0.*100/iu);

    expect((await panels.snapshot())[0]?.data).toMatchObject({ rendered: 1, latest: { title: "valid" } });
  });

  test("isolates tool details and panel snapshots from consumer mutation", async () => {
    const { panels, tools } = await setup();
    const result = await tool(tools).execute(
      "isolate",
      { title: "original", blocks: [{ type: "text", label: "label", value: "value" }] },
      undefined,
      undefined,
      {} as never,
    );
    const details = result.details as { title: string; blocks: Array<{ label: string }> };
    details.title = "mutated result";
    details.blocks[0]!.label = "mutated result";
    const first = (await panels.snapshot())[0]?.data as { latest: { title: string; blocks: Array<{ label: string }> } };
    expect(first.latest).toMatchObject({ title: "original", blocks: [{ label: "label" }] });
    first.latest.title = "mutated panel";
    first.latest.blocks[0]!.label = "mutated panel";
    const second = (await panels.snapshot())[0]?.data as { latest: { title: string; blocks: Array<{ label: string }> } };
    expect(second.latest).toMatchObject({ title: "original", blocks: [{ label: "label" }] });
  });

  test("rejects stale tool calls after plugin disposal and pre-cancelled calls", async () => {
    const { context, tools } = await setup();
    const render = tool(tools);
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled GenUI"));
    await expect(
      render.execute("cancelled", { title: "x", blocks: [{ type: "text", label: "x", value: "x" }] }, controller.signal, undefined, {} as never),
    ).rejects.toThrow(/caller cancelled GenUI/iu);
    await context.fiber.dispose();
    await expect(
      render.execute("disposed", { title: "x", blocks: [{ type: "text", label: "x", value: "x" }] }, undefined, undefined, {} as never),
    ).rejects.toThrow(/disposed/iu);
  });
});
