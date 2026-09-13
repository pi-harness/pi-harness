import { Context } from "@deepseek-ai/cordis";
import assert from "node:assert/strict";
import { afterEach, describe, expect, test, vi } from "vitest";
import pluginRadarPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

async function fixture(limit = 5) {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(pluginRadarPlugin, { apiUrl: "https://api.github.com", limit, timeoutMs: 2_000 });
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "plugin_radar_search");
  if (tool === undefined) throw new Error("plugin_radar_search was not registered");
  return { context, tools, panels, tool };
}

async function settleWithin<T>(promise: Promise<T>, message: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(message)), 500);
        deadline.unref();
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("plugin radar", () => {
  test("accounts for JSON escaping when limiting returned repositories", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json({
          total_count: 25,
          items: Array.from({ length: 25 }, (_, i) => ({
            name: `entry-${i}`,
            full_name: `acme/entry-${i}`,
            html_url: `https://github.com/acme/entry-${i}`,
            description: "\u0000".repeat(4_000),
            stargazers_count: 25 - i,
          })),
        }),
      ),
    );
    const { tool } = await fixture(25);
    const result = await tool.execute("escaping", {}, undefined, undefined, {} as never);
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("Missing text result");
    expect(Buffer.byteLength(content.text, "utf8")).toBeLessThanOrEqual(128 * 1024);
    const report: unknown = JSON.parse(content.text);
    assert(report !== null && typeof report === "object" && "results" in report && Array.isArray(report.results) && "total" in report);
    expect(report.total).toBe(report.results.length);
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.results.length).toBeLessThan(25);
    expect(report).toMatchObject({ metadataTruncated: true, truncated: true });
  });

  test("bounds model JSON for two large topic responses without losing repository identities", async () => {
    let request = 0;
    vi.stubGlobal("fetch", () => {
      const index = request++;
      return Promise.resolve(
        Response.json({
          total_count: 1,
          items: [
            {
              name: `large-${index}`,
              full_name: `acme/large-${index}`,
              html_url: `https://github.com/acme/large-${index}`,
              description: "界".repeat(300_000),
              stargazers_count: 10 - index,
            },
          ],
        }),
      );
    });
    const { tool } = await fixture();
    const result = await tool.execute("large", {}, undefined, undefined, {} as never);
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("Missing text result");
    expect(Buffer.byteLength(content.text, "utf8")).toBeLessThanOrEqual(128 * 1024);
    const report: unknown = JSON.parse(content.text);
    expect(report).toMatchObject({ total: 2, truncated: true, metadataTruncated: true });
    expect(report).toMatchObject({ results: [{ fullName: "acme/large-0" }, { fullName: "acme/large-1" }] });
    expect(content.text).not.toContain("�");
    expect((result.details as { results: { description: string }[] }).results[0]!.description).toBe("界".repeat(300_000));
  });

  test("exposes repository metadata and incomplete search status to the model", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json({
          total_count: 20,
          incomplete_results: true,
          items: [
            {
              name: "memory",
              full_name: "acme/memory",
              html_url: "https://github.com/acme/memory",
              description: "Persistent memory 测试😀",
              stargazers_count: 12,
              language: "TypeScript",
              updated_at: "2026-09-09T00:00:00Z",
              topics: ["pi-harness-plugin"],
            },
          ],
        }),
      ),
    );
    const { tool } = await fixture();
    const result = await tool.execute("metadata", {}, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ total: 1, truncated: true, results: [{ description: "Persistent memory 测试😀" }] });
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("Missing text result");
    expect(content.text).toBe(JSON.stringify(result.details));
  });

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

  test("returns the HTTP status when discarded-body cleanup never settles", async () => {
    let cancellations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: () => {
                cancellations += 1;
                return new Promise(() => undefined);
              },
            }),
            { status: 429 },
          ),
        ),
      ),
    );
    const { tool } = await fixture();
    await expect(
      settleWithin(tool.execute("rate-limited", {}, undefined, undefined, {} as never), "HTTP status remained pending behind cleanup"),
    ).rejects.toThrow(/HTTP 429/iu);
    expect(cancellations).toBe(2);
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

  test("rejects ambiguous or credential-bearing API URLs before networking", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    for (const apiUrl of [
      "https://user:secret@api.github.com",
      "https://api.github.com?token=secret",
      "https://api.github.com#search",
      "https://api.github.com?",
      "https://api.github.com#",
    ]) {
      const context = new Context();
      context.provide("piTools", new PiToolRegistry());
      context.provide("piPluginUi", new PiPluginUiRegistry());
      contexts.push(context);
      let failure: unknown;
      try {
        await context.plugin(pluginRadarPlugin, { apiUrl });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/credentials|query|fragment/iu);
    }
    const context = new Context();
    const panels = new PiPluginUiRegistry();
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", panels);
    contexts.push(context);
    await context.plugin(pluginRadarPlugin, { apiUrl: "https://github.enterprise.example/api/v3/" });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { apiUrl: "https://github.enterprise.example/api/v3" } }]);
    expect(request).not.toHaveBeenCalled();
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

  test("cancels stalled response body reads when the caller aborts", async () => {
    let pulls = 0;
    let cancellations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull: () => {
                pulls += 1;
                return new Promise(() => undefined);
              },
              cancel: () => {
                cancellations += 1;
              },
            }),
          ),
        ),
      ),
    );
    const { tool } = await fixture();
    const controller = new AbortController();
    const pending = tool.execute("stalled", {}, controller.signal, undefined, {} as never);
    await vi.waitFor(() => expect(pulls).toBe(2));
    controller.abort(new Error("stop"));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("Plugin radar cancellation remained pending")), 500);
      deadline.unref();
    });
    try {
      await expect(Promise.race([pending, timeout])).rejects.toThrow(/cancelled/iu);
    } finally {
      clearTimeout(deadline);
    }
    expect(cancellations).toBe(2);
  });

  test("cancels both response bodies when abort arrives before the first read", async () => {
    let cancellations = 0;
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        const response = new Response(
          new ReadableStream({
            cancel: () => {
              cancellations += 1;
            },
          }),
        );
        return Promise.resolve(response).then((resolved) => {
          controller.abort(new Error("stop before read"));
          return resolved;
        });
      }),
    );
    const { tool } = await fixture();
    await expect(tool.execute("early-abort", {}, controller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
    expect(cancellations).toBe(2);
  });

  test("returns the declared-size diagnostic when body cleanup never settles", async () => {
    let cancellations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: () => {
                cancellations += 1;
                return new Promise(() => undefined);
              },
            }),
            { headers: { "content-length": String(1024 * 1024 + 1) } },
          ),
        ),
      ),
    );
    const { tool } = await fixture();
    await expect(
      settleWithin(tool.execute("oversized", {}, undefined, undefined, {} as never), "Declared-size diagnostic remained pending behind cleanup"),
    ).rejects.toThrow(/exceeded 1 MiB limit/iu);
    expect(cancellations).toBe(2);
  });

  test("returns the streamed-size diagnostic when reader cleanup never settles", async () => {
    let cancellations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start: (stream) => stream.enqueue(new Uint8Array(1024 * 1024 + 1)),
              cancel: () => {
                cancellations += 1;
                return new Promise(() => undefined);
              },
            }),
          ),
        ),
      ),
    );
    const { tool } = await fixture();
    await expect(
      settleWithin(tool.execute("streamed-oversized", {}, undefined, undefined, {} as never), "Streamed-size diagnostic remained pending behind cleanup"),
    ).rejects.toThrow(/exceeded 1 MiB limit/iu);
    expect(cancellations).toBe(2);
  });

  test("normalizes non-Error response stream failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start: (stream) => stream.error("stream broke"),
            }),
          ),
        ),
      ),
    );
    const { tool } = await fixture();
    await expect(tool.execute("stream-error", {}, undefined, undefined, {} as never)).rejects.toThrow(/response read failed/iu);
  });
});
