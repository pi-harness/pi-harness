import { request } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import mockServerPlugin from "../src/plugins/mock-server.js";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

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

  test("cleans up server and registrations on disposal", async () => {
    const { context, tools, panels, start } = await fixture();
    await start.execute("start", { port: 0 }, undefined, undefined, {} as never);
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
});
