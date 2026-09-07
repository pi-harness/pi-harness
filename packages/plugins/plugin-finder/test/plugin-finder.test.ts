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
});
