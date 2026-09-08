import { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import pluginFinder from "../src/index.js";
import toolsPlugin from "@pi-harness/core/plugins/tools";

const originalFetch = globalThis.fetch;
const contexts: Context[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function searchTool(): Promise<ToolDefinition> {
  const context = new Context();
  contexts.push(context);
  await context.plugin(toolsPlugin, { names: [] });
  await context.plugin(pluginFinder, { registryUrl: "https://registry.example" });
  const tool = context.piTools.snapshot().customTools.find((candidate) => candidate.name === "plugin_search");
  if (tool === undefined) throw new Error("plugin finder did not register plugin_search");
  return tool;
}

describe("plugin finder network boundaries", () => {
  test("rejects a registry response larger than one MiB", async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ objects: [], total: 0, padding: "x".repeat(1024 * 1024) }), {
          headers: { "content-type": "application/json" },
        }),
      );
    const tool = await searchTool();

    await expect(tool.execute("search-large", { query: "logger" }, undefined, undefined, {} as never)).rejects.toThrow(/exceeded the 1 MiB limit/);
  });

  test("does not start a registry request after the caller cancels", async () => {
    globalThis.fetch = (_input, init) =>
      init?.signal?.aborted === true ? Promise.reject(new DOMException("cancelled", "AbortError")) : Promise.resolve(Response.json({ objects: [], total: 0 }));
    const tool = await searchTool();
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute("search-cancelled", { query: "logger" }, controller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/);
  });

  test("cancels a non-success registry response body", async () => {
    let cancelled = false;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        ),
      );
    const tool = await searchTool();

    await expect(tool.execute("search-unavailable", { query: "logger" }, undefined, undefined, {} as never)).rejects.toThrow(/HTTP 503/iu);
    expect(cancelled).toBe(true);
  });

  test("keeps the HTTP error when response cancellation fails", async () => {
    globalThis.fetch = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        body: {
          cancel() {
            return Promise.reject(new Error("cancel failed"));
          },
        },
      } as unknown as Response);
    const tool = await searchTool();

    await expect(tool.execute("search-unavailable", { query: "logger" }, undefined, undefined, {} as never)).rejects.toThrow(/HTTP 503/iu);
  });

  test("rejects invalid UTF-8 registry responses", async () => {
    globalThis.fetch = () => Promise.resolve(new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }));
    const tool = await searchTool();

    await expect(tool.execute("search-invalid-utf8", { query: "logger" }, undefined, undefined, {} as never)).rejects.toThrow(/valid UTF-8/iu);
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
    const tool = await searchTool();
    await expect(tool.execute("search-accessor", params, undefined, undefined, {} as never)).rejects.toThrow(/data properties|plain object/iu);
    await expect(tool.execute("search-unknown", { query: "logger", extra: true }, undefined, undefined, {} as never)).rejects.toThrow(/unknown/iu);
    expect(accessed).toBe(false);
  });
  test("rejects malformed successful response shapes instead of reporting no results", async () => {
    const tool = await searchTool();
    for (const payload of [null, [], {}, { objects: {}, total: 0 }, { objects: [], total: -1 }]) {
      globalThis.fetch = () => Promise.resolve(Response.json(payload));
      await expect(tool.execute("malformed", { query: "logger" }, undefined, undefined, {} as never)).rejects.toThrow(/response.*structure/iu);
    }
  });

  test("detaches search snapshots and prevents networking after disposal", async () => {
    let requests = 0;
    globalThis.fetch = () => {
      requests += 1;
      return Promise.resolve(Response.json({ objects: [{ package: { name: "pi-example", version: "1.0.0" } }], total: 1 }));
    };
    const tool = await searchTool();
    const context = contexts.at(-1)!;
    const result = await tool.execute("search", { query: "example" }, undefined, undefined, {} as never);
    (result.details as { results: { name: string }[] }).results[0]!.name = "changed";
    expect(JSON.stringify(await context.piPluginUi.snapshot())).not.toContain("changed");
    await context.fiber.dispose();
    await expect(tool.execute("disposed", { query: "example" }, undefined, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
    expect(requests).toBe(1);
  });

  test("aborts an active fetch on disposal", async () => {
    let received: AbortSignal | null | undefined;
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        received = init?.signal;
        received?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    const tool = await searchTool();
    const pending = tool.execute("active", { query: "example" }, undefined, undefined, {} as never);
    const rejection = expect(pending).rejects.toThrow(/cancelled/iu);
    await contexts.at(-1)!.fiber.dispose();
    expect(received?.aborted).toBe(true);
    await rejection;
  });
  test("filters registry candidates before limiting results and prioritizes name matches", async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json({
          total: 22,
          objects: [
            ...Array.from({ length: 20 }, (_, id) => ({ package: { name: `pi-other-${id}`, version: "1" } })),
            { package: { name: "pi-context", version: "1", description: "Persistent memory" } },
            { package: { name: "pi-memory", version: "1" } },
          ],
        }),
      );
    const tool = await searchTool();
    await expect(tool.execute("search", { query: "memory" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { total: 2, registryTotal: 22, truncated: false, results: [{ name: "pi-memory" }, { name: "pi-context" }] },
    });
  });
  test("prioritizes multiword name matches over descriptions", async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json({
          total: 2,
          objects: [{ package: { name: "pi-tools", version: "1", description: "An mcp client" } }, { package: { name: "pi-mcp-client", version: "1" } }],
        }),
      );
    const tool = await searchTool();
    await expect(tool.execute("multiword", { query: "mcp client" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { results: [{ name: "pi-mcp-client" }, { name: "pi-tools" }] },
    });
  });
});
