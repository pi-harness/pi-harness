import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import webServerPlugin, { DEFAULT_WEB_SERVER_PORT } from "../src/index.js";

const contexts: Context[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

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
});
