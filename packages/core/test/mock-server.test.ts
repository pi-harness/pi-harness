import { request } from "node:http";
import { connect } from "node:net";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import mockServerPlugin from "../src/plugins/mock-server.js";
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
