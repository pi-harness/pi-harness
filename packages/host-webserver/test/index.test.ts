import { Context } from "@deepseek-ai/cordis";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import webServerPlugin, { DEFAULT_WEB_SERVER_PORT, type WebServer } from "../src/index.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

async function startServer(config: { host?: string; port: number }): Promise<WebServer> {
  const context = new Context();
  contexts.push(context);
  await context.plugin(webServerPlugin, config);
  return context.webServer;
}

// Node's fetch strips a caller-supplied Host header, so raw node:http is needed to emulate a DNS-rebinding request.
function rawRequest(server: WebServer, headers: Record<string, string>, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: server.port, path: "/health", method, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

function registerHealth(server: WebServer): { calls: number } {
  const state = { calls: 0 };
  server.register({
    path: "/health",
    handler(_request, response) {
      state.calls += 1;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
    },
  });
  return state;
}

describe("web server plugin", () => {
  test("uses the memorable Pi default port", () => {
    expect(DEFAULT_WEB_SERVER_PORT).toBe(3141);
  });

  test("serves registered routes and disposes the listener with the Cordis fiber", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    const server = context.webServer;
    const disposeRoute = server.register({
      path: "/health",
      handler(_request, response) {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok");
      },
    });

    await expect(fetch(server.url + "/health").then(async (response) => ({ status: response.status, body: await response.text() }))).resolves.toEqual({
      status: 200,
      body: "ok",
    });
    expect(() => server.register({ path: "/health", handler() {} })).toThrow(/already registered/);

    disposeRoute();
    await expect(fetch(server.url + "/health")).resolves.toMatchObject({ status: 404 });
    await context.fiber.dispose();
    await expect(fetch(server.url + "/health")).rejects.toThrow();
    contexts.splice(contexts.indexOf(context), 1);
  });

  test("rejects malformed route paths", async () => {
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { port: 0 });

    expect(() => context.webServer.register({ path: "health", handler() {} })).toThrow(/absolute/);
    expect(() => context.webServer.register({ path: "/health/", handler() {} })).toThrow(/trailing slash/);
  });

  test("turns a synchronous handler throw into a 500 response and keeps serving", async () => {
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    server.register({
      path: "/sync-throw",
      handler() {
        throw new Error("boom-sync");
      },
    });
    server.register({
      path: "/async-throw",
      handler() {
        return Promise.reject(new Error("boom-async"));
      },
    });
    registerHealth(server);

    await expect(
      fetch(server.url + "/sync-throw").then(async (response) => ({ status: response.status, body: (await response.json()) as unknown })),
    ).resolves.toEqual({
      status: 500,
      body: { error: "boom-sync" },
    });
    await expect(
      fetch(server.url + "/async-throw").then(async (response) => ({ status: response.status, body: (await response.json()) as unknown })),
    ).resolves.toEqual({
      status: 500,
      body: { error: "boom-async" },
    });
    await expect(fetch(server.url + "/health")).resolves.toMatchObject({ status: 200 });
  });

  test("rejects cross-origin requests with 403 before any handler or fallback runs", async () => {
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    const health = registerHealth(server);
    let fallbackCalls = 0;
    server.registerFallback((_request, response) => {
      fallbackCalls += 1;
      response.end("fallback");
    });

    const crossOrigin = await fetch(server.url + "/health", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toEqual({ error: "Cross-origin requests are not allowed" });
    await expect(fetch(server.url + "/anything", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).resolves.toMatchObject({
      status: 403,
    });
    await expect(fetch(server.url + "/health", { headers: { origin: "null" } })).resolves.toMatchObject({ status: 403 });
    await expect(fetch(server.url + "/health", { headers: { origin: "http://127.0.0.1:" + (server.port + 1) } })).resolves.toMatchObject({ status: 403 });
    await expect(fetch(server.url + "/health", { headers: { origin: "https://127.0.0.1:" + server.port } })).resolves.toMatchObject({ status: 403 });
    expect(health.calls).toBe(0);
    expect(fallbackCalls).toBe(0);

    await expect(fetch(server.url + "/health", { method: "POST", headers: { origin: server.url }, body: "{}" })).resolves.toMatchObject({ status: 200 });
    expect(health.calls).toBe(1);
  });

  test("rejects requests whose Host header does not name the bound server", async () => {
    const server = await startServer({ host: "127.0.0.1", port: 0 });
    const health = registerHealth(server);

    await expect(rawRequest(server, { host: "evil.example:" + server.port })).resolves.toEqual({
      status: 400,
      body: JSON.stringify({ error: "Host header does not match the web server address" }),
    });
    await expect(rawRequest(server, { host: "127.0.0.1:" + (server.port + 1) })).resolves.toMatchObject({ status: 400 });
    await expect(rawRequest(server, { host: "127.0.0.1" })).resolves.toMatchObject({ status: 400 });
    await expect(rawRequest(server, { host: "user@127.0.0.1:" + server.port })).resolves.toMatchObject({ status: 400 });
    expect(health.calls).toBe(0);

    await expect(rawRequest(server, { host: "localhost:" + server.port, origin: "http://localhost:" + server.port }, "POST")).resolves.toMatchObject({
      status: 200,
    });
    await expect(rawRequest(server, { host: "LOCALHOST:" + server.port })).resolves.toMatchObject({ status: 200 });
    await expect(rawRequest(server, { host: "[::1]:" + server.port })).resolves.toMatchObject({ status: 200 });
    await expect(rawRequest(server, { host: "localhost:" + server.port, origin: "http://127.0.0.1:" + server.port })).resolves.toMatchObject({ status: 403 });
    expect(health.calls).toBe(3);
  });

  test("accepts the configured non-loopback host and any hostname on a wildcard bind", async () => {
    const wildcard = await startServer({ host: "0.0.0.0", port: 0 });
    registerHealth(wildcard);
    await expect(rawRequest(wildcard, { host: "workstation.lan:" + wildcard.port })).resolves.toMatchObject({ status: 200 });
    await expect(rawRequest(wildcard, { host: "workstation.lan:" + (wildcard.port + 1) })).resolves.toMatchObject({ status: 400 });

    const ipv6 = await startServer({ host: "::1", port: 0 });
    registerHealth(ipv6);
    expect(ipv6.url).toBe("http://[::1]:" + ipv6.port);
    await expect(fetch(ipv6.url + "/health")).resolves.toMatchObject({ status: 200 });
    await expect(fetch(ipv6.url + "/health", { headers: { origin: ipv6.url } })).resolves.toMatchObject({ status: 200 });
  });
});
