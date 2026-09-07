import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import pluginRadarPlugin from "../src/plugins/plugin-radar.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

async function fixture() {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(pluginRadarPlugin, { apiUrl: "https://api.github.com", limit: 5, timeoutMs: 2_000 });
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "plugin_radar_search");
  if (tool === undefined) throw new Error("plugin_radar_search was not registered");
  return { context, tools, panels, tool };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("plugin radar", () => {
  test("searches both curated topics, deduplicates, and exposes strict metadata", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            total_count: 2,
            items: [
              { full_name: "acme/one", name: "one", html_url: "https://github.com/acme/one", stargazers_count: 7, updated_at: "2026-01-01", topics: ["dsh"] },
              { full_name: "acme/one", name: "one", html_url: "https://github.com/acme/one", stargazers_count: 9, updated_at: "2026-01-02", topics: ["dsh"] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const { tool, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    const result = await tool.execute("search", { query: "memory" }, undefined, undefined, {} as never);
    expect(calls).toHaveLength(2);
    expect(result.details).toMatchObject({ query: "memory", total: 1, results: [{ fullName: "acme/one", stars: 9 }] });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { total: 1, results: [{ fullName: "acme/one" }] } }]);
  });

  test("surfaces bounded upstream failures and disposes registrations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("upstream unavailable")));
    const { context, tools, panels, tool } = await fixture();
    await expect(tool.execute("search", { query: "x" }, undefined, undefined, {} as never)).rejects.toThrow(/upstream unavailable/iu);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });

  test("rejects invalid UTF-8 upstream payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }))),
    );
    const { tool } = await fixture();
    await expect(tool.execute("search", { query: "x" }, undefined, undefined, {} as never)).rejects.toThrow(/valid UTF-8/iu);
  });

  test("rejects accessor and unknown search parameters before networking", async () => {
    let accessed = false;
    const params = {};
    Object.defineProperty(params, "query", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("query getter executed");
      },
    });
    const { tool } = await fixture();
    await expect(tool.execute("search-accessor", params, undefined, undefined, {} as never)).rejects.toThrow(/data properties|plain object/iu);
    await expect(tool.execute("search-unknown", { query: "x", extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown/iu);
    expect(accessed).toBe(false);
  });
});
