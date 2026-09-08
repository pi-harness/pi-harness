import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import pluginRadarPlugin from "../src/index.js";
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
  test("searches only Pi Harness topics, deduplicates, and exposes strict metadata", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            total_count: 2,
            items: [
              {
                full_name: "acme/one",
                name: "one",
                html_url: "https://github.com/acme/one",
                stargazers_count: 7,
                updated_at: "2026-01-01",
                topics: ["pi-harness"],
              },
              {
                full_name: "acme/one",
                name: "one",
                html_url: "https://github.com/acme/one",
                stargazers_count: 9,
                updated_at: "2026-01-02",
                topics: ["pi-harness"],
              },
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
    expect(calls.every((url) => !/dsh|deepseek/u.test(url))).toBe(true);
    expect(calls.some((url) => decodeURIComponent(url).includes("topic:pi-harness"))).toBe(true);
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
  test("rejects malformed response structures instead of reporting no repositories", async () => {
    const { tool } = await fixture();
    for (const payload of [null, {}, { items: {}, total_count: 0 }, { items: [], total_count: -1 }]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(Response.json(payload))),
      );
      await expect(tool.execute("bad", {}, undefined, undefined, {} as never)).rejects.toThrow(/structure/iu);
    }
  });

  test("detaches nested results and aborts network activity on disposal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ total_count: 1, items: [{ full_name: "acme/one", name: "one", html_url: "https://github.com/acme/one", topics: ["pi-harness"] }] }),
        ),
      ),
    );
    const { context, tool, panels } = await fixture();
    const result = await tool.execute("first", {}, undefined, undefined, {} as never);
    (result.details as { results: { topics: string[] }[] }).results[0]!.topics[0] = "changed";
    expect(JSON.stringify(await panels.snapshot())).not.toContain("changed");
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal!;
            signals.push(signal);
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          }),
      ),
    );
    const pending = tool.execute("active", {}, undefined, undefined, {} as never);
    const rejection = expect(pending).rejects.toThrow(/cancelled/iu);
    await context.fiber.dispose();
    await rejection;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await expect(tool.execute("retained", {}, undefined, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
  });
  test("marks incomplete and limited searches and deduplicates repository casing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            total_count: 30,
            incomplete_results: true,
            items: [
              { full_name: "Acme/One", name: "One", html_url: "https://github.com/Acme/One", stargazers_count: 1 },
              { full_name: "acme/one", name: "one", html_url: "https://github.com/acme/one", stargazers_count: 2 },
            ],
          }),
        ),
      ),
    );
    const { tool } = await fixture();
    const result = await tool.execute("partial", {}, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ total: 1, truncated: true, results: [{ fullName: "acme/one", stars: 2 }] });
  });

  test("preserves the latest search when cancellation arrives while reading JSON", async () => {
    const { tool, panels } = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ total_count: 0, items: [] }))),
    );
    await tool.execute("before", { query: "before" }, undefined, undefined, {} as never);
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(new TextEncoder().encode('{"total_count":0,"items":[]}'));
                controller.abort();
                stream.close();
              },
            }),
          ),
        ),
      ),
    );
    await expect(tool.execute("cancel", { query: "after" }, controller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
    expect((await panels.snapshot())[0]?.data).toMatchObject({ query: "before" });
  });
});
