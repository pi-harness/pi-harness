import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import webResearchPlugin from "../src/plugins/web-research.js";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];

async function fixture() {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(webResearchPlugin, { baseUrl: "https://api.firecrawl.dev", apiKey: "", maxResults: 5, timeoutMs: 2_000 });
  contexts.push(context);
  const find = (name: string) => {
    const tool = tools.snapshot().customTools.find((item) => item.name === name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  };
  return { context, tools, panels, search: find("web_search"), read: find("read_page") };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("web research", () => {
  test("returns bounded structured web evidence and strict metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { web: [{ title: "Docs", url: "https://docs.example.test/a", description: "Useful" }] } }), {
          status: 200,
        }),
      ),
    );
    const { search, panels } = await fixture();
    for (const tool of [search]) {
      expect(tool.executionMode).toBe("sequential");
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
    await expect(search.execute("search", { query: "pi harness" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { status: "ok", items: [{ title: "Docs", source: "docs.example.test" }] },
    });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { latest: { status: "ok" }, readPageAvailable: false } }]);
  });

  test("fails clearly without Browser Fetch and cleans up", async () => {
    const { context, tools, panels, read } = await fixture();
    await expect(read.execute("read", { url: "https://docs.example.test" }, undefined, undefined, {} as never)).rejects.toThrow(/Browser Fetch/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });

  test("rejects invalid UTF-8 provider responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([0xc3, 0x28]), { status: 200 })));
    const { search } = await fixture();
    await expect(search.execute("search", { query: "pi" }, undefined, undefined, {} as never)).rejects.toThrow(/valid UTF-8/iu);
  });
});
