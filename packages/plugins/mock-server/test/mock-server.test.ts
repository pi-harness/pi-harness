import { request } from "node:http";
import { connect } from "node:net";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import mockServerPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry } from "@pi-harness/plugin-api";

const contexts: Context[] = [];

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

function rawRequest(url: string, target: string): Promise<string> {
  const port = Number(new URL(url).port);
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let response = "";
    socket.on("data", (chunk: Buffer) => (response += chunk.toString("utf8")));
    socket.on("error", reject);
    socket.on("close", () => resolve(response));
  });
}

async function fixture() {
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(mockServerPlugin, { routes: [{ path: "/hello", method: "GET", body: "world" }] });
  contexts.push(context);
  const find = (name: string) => {
    const tool = tools.snapshot().customTools.find((item) => item.name === name);
    if (tool === undefined) throw new Error(`${name} was not registered`);
    return tool;
  };
  return { context, tools, panels, start: find("mock_server_start"), stop: find("mock_server_stop"), status: find("mock_server_status") };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("mock server", () => {
  test("exposes complete server diagnostics in model-visible tool content", async () => {
    const { start, status } = await fixture();
    const started = await start.execute("start", {}, undefined, undefined, {} as never);
    expect(started.content).toEqual([{ type: "text", text: JSON.stringify(started.details) }]);
    const url = (started.details as { url: string }).url;
    await get(`${url}/hello`);
    const current = await status.execute("status", {}, undefined, undefined, {} as never);
    expect(current.details).toMatchObject({ routes: 1, lastRequest: "GET /hello", lastError: null });
    expect(current.content).toEqual([{ type: "text", text: JSON.stringify(current.details) }]);
  });

  test("rejects cancelled starts and retained tools after disposal", async () => {
    const { context, start, status } = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("Start cancelled"));
    await expect(start.execute("cancel", {}, controller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
    await context.fiber.dispose();
    await expect(start.execute("late", {}, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
    await expect(status.execute("late", {}, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
  });

  test("serializes stop and restart so the new listener remains authoritative", async () => {
    const { start, stop, status } = await fixture();
    await start.execute("first", {}, undefined, undefined, {} as never);
    const stopping = stop.execute("stop", {}, undefined, undefined, {} as never);
    const restarting = start.execute("restart", {}, undefined, undefined, {} as never);
    await stopping;
    const restarted = await restarting;
    const url = (restarted.details as { url: string }).url;
    expect(await get(`${url}/hello`)).toEqual({ status: 200, body: "world" });
    await expect(status.execute("status", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { running: true, url } });
  });

  test("rejects startup interrupted by disposal", async () => {
    const { context, start } = await fixture();
    const pending = start.execute("pending", {}, undefined, undefined, {} as never);
    const rejected = expect(pending).rejects.toThrow(/disposed/iu);
    await context.fiber.dispose();
    await rejected;
  });

  test("detaches tool results from live state", async () => {
    const { start, status, panels } = await fixture();
    const result = await start.execute("start", {}, undefined, undefined, {} as never);
    (result.details as { running: boolean }).running = false;
    await expect(status.execute("status", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { running: true } });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { running: true } }]);
  });

  test("closes active unfinished HTTP connections before disposal resolves", async () => {
    const { context, start } = await fixture();
    const result = await start.execute("start", {}, undefined, undefined, {} as never);
    const url = (result.details as { url: string }).url;
    const socket = connect(Number(new URL(url).port), "127.0.0.1");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write("POST /hello HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n");
    try {
      await context.fiber.dispose();
      await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Connection remained open after disposal")), 500))]);
      await expect(get(`${url}/hello`)).rejects.toThrow();
    } finally {
      socket.destroy();
    }
  });

  test("rejects informational status codes that cannot terminate a response", async () => {
    const context = new Context();
    contexts.push(context);
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", new PiPluginUiRegistry());
    await expect(context.plugin(mockServerPlugin, { routes: [{ path: "/hello", status: 100 }] })).rejects.toThrow(/200.*599/iu);
  });

  test("serves configured loopback routes and exposes strict sequential tools", async () => {
    const { start, stop, status } = await fixture();
    for (const tool of [start, stop, status]) {
      expect(tool.executionMode).toBe("sequential");
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
    const started = await start.execute("start", { port: 0 }, undefined, undefined, {} as never);
    const url = (started.details as { url: string }).url;
    expect(await get(`${url}/hello`)).toEqual({ status: 200, body: "world" });
    expect(await get(`${url}/missing`)).toMatchObject({ status: 404 });
    await expect(status.execute("status", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { running: true } });
    await expect(stop.execute("stop", {}, undefined, undefined, {} as never)).resolves.toMatchObject({ details: { stopped: true } });
  });

  test("rejects routes whose headers cannot be serialized into an HTTP response", async () => {
    const context = new Context();
    context.provide("piTools", new PiToolRegistry());
    context.provide("piPluginUi", new PiPluginUiRegistry());
    contexts.push(context);
    await expect(context.plugin(mockServerPlugin, { routes: [{ path: "/hello", headers: { "x-trace": "a\r\nInjected: yes" } }] })).rejects.toThrow(
      /header value.*invalid/iu,
    );
    await expect(context.plugin(mockServerPlugin, { routes: [{ path: "/hello", headers: { "x-trace": "中文" } }] })).rejects.toThrow(/header value.*invalid/iu);
    await expect(context.plugin(mockServerPlugin, { routes: [{ path: "/hello", headers: { "x trace": "ok" } }] })).rejects.toThrow(/header name.*token/iu);
  });

  test("answers 500 instead of crashing the host when a request target cannot be parsed", async () => {
    const { panels, start, status } = await fixture();
    const started = await start.execute("start", { port: 0 }, undefined, undefined, {} as never);
    const url = (started.details as { url: string }).url;
    expect(await rawRequest(url, "//[")).toMatch(/^HTTP\/1\.1 500\b/u);

    // The 500 is the only trace a request-listener failure leaves on the wire, so the reason has to reach the panel and the status tool rather than being dropped by the catch.
    const failed = await status.execute("status", {}, undefined, undefined, {} as never);
    expect((failed.details as { lastError: string | null }).lastError).toMatch(/invalid url/iu);
    const panel = (await panels.snapshot())[0]?.data as { lastError?: unknown };
    expect(panel.lastError).toMatch(/invalid url/iu);

    expect(await get(`${url}/hello`)).toEqual({ status: 200, body: "world" });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { lastRequest: "GET /hello", lastError: null } }]);
  });

  test("cleans up server and registrations on disposal", async () => {
    const { context, tools, panels, start } = await fixture();
    await start.execute("start", { port: 0 }, undefined, undefined, {} as never);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
});
