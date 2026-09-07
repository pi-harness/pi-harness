import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { PassThrough } from "node:stream";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import webServerPlugin, { type WebRoute, type WebServer } from "@pi-harness/host-webserver";
import webAppPlugin, { isInsideStaticRoot } from "../src/index.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const contexts: Context[] = [];

// A response that records every writeHead and rejects a second one exactly like node:http, so a failure raised after the headers are on the wire is observable without a socket.
type MockResponse = PassThrough & { headersSent: boolean; writeHead: (status: number, headers?: unknown) => MockResponse };

function mockResponse(): { response: ServerResponse; statuses: number[] } {
  const stream = new PassThrough() as MockResponse;
  stream.resume();
  const statuses: number[] = [];
  stream.headersSent = false;
  stream.writeHead = (status) => {
    if (stream.headersSent) throw Object.assign(new Error("Cannot write headers after they are sent to the client"), { code: "ERR_HTTP_HEADERS_SENT" });
    stream.headersSent = true;
    statuses.push(status);
    return stream;
  };
  return { response: stream as unknown as ServerResponse, statuses };
}

// Captures the fallback the web app registers so it can be driven with a mock response instead of a real socket.
function provideFakeWebServer(context: Context): { current: WebRoute["handler"] | undefined } {
  const captured: { current: WebRoute["handler"] | undefined } = { current: undefined };
  const service: WebServer = {
    host: "127.0.0.1",
    port: 3141,
    url: "http://127.0.0.1:3141",
    register: () => () => {},
    registerFallback(handler) {
      captured.current = handler;
      return () => {
        captured.current = undefined;
      };
    },
    close: async () => {},
  };
  context.provide("webServer", service);
  return captured;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.fiber.dispose()));
});

describe("web app plugin", () => {
  test("serves the SPA and refuses symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-web-root-"));
    await writeFile(join(root, "index.html"), "<main>console</main>", "utf8");
    await symlink("/etc/hosts", join(root, "leak"));
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    await context.plugin(webAppPlugin, { staticDir: root });

    await expect(fetch(context.webServer.url + "/").then((response) => response.text())).resolves.toBe("<main>console</main>");
    await expect(fetch(context.webServer.url + "/missing-route").then((response) => response.text())).resolves.toBe("<main>console</main>");
    await expect(fetch(context.webServer.url + "/leak").then((response) => response.text())).resolves.toBe("<main>console</main>");
  });

  test("sends a content security policy and a declared content type with every static response", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-web-root-"));
    await writeFile(join(root, "index.html"), "<main>console</main>", "utf8");
    await writeFile(join(root, "icon.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const context = new Context();
    contexts.push(context);
    await context.plugin(webServerPlugin, { host: "127.0.0.1", port: 0 });
    await context.plugin(webAppPlugin, { staticDir: root });

    const page = await fetch(context.webServer.url + "/");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");

    const icon = await fetch(context.webServer.url + "/icon.png");
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("reports a read failure raised after the headers are sent instead of writing the SPA fallback over it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-web-root-"));
    await writeFile(join(root, "index.html"), "<main>console</main>", "utf8");
    await writeFile(join(root, "locked.js"), "export const value = 1;\n", "utf8");
    await chmod(join(root, "locked.js"), 0o000);
    const context = new Context();
    contexts.push(context);
    const fallback = provideFakeWebServer(context);
    await context.plugin(webAppPlugin, { staticDir: root });
    expect(fallback.current).toBeDefined();

    const locked = mockResponse();
    await expect(fallback.current?.({ url: "/locked.js" } as IncomingMessage, locked.response)).rejects.toThrow(/EACCES/);
    expect(locked.statuses).toEqual([200]);

    const missing = mockResponse();
    await expect(fallback.current?.({ url: "/missing-route" } as IncomingMessage, missing.response)).resolves.toBeUndefined();
    expect(missing.statuses).toEqual([200]);
  });
});

describe("static root containment", () => {
  test("accepts files below the root and rejects escapes with Windows separators", () => {
    const root = "C:\\app\\dist";
    expect(isInsideStaticRoot(root, root, win32)).toBe(true);
    expect(isInsideStaticRoot(root, "C:\\app\\dist\\index.html", win32)).toBe(true);
    expect(isInsideStaticRoot(root, "C:\\app\\dist\\assets\\a.js", win32)).toBe(true);
    expect(isInsideStaticRoot(root + "\\", "C:\\app\\dist\\index.html", win32)).toBe(true);
    expect(isInsideStaticRoot(root, "C:\\app\\x", win32)).toBe(false);
    expect(isInsideStaticRoot(root, "C:\\app", win32)).toBe(false);
    expect(isInsideStaticRoot(root, "C:\\app\\dist2\\z", win32)).toBe(false);
    expect(isInsideStaticRoot(root, "D:\\app\\dist\\y", win32)).toBe(false);
  });

  test("accepts files below the root and rejects escapes with POSIX separators", () => {
    const root = "/srv/app/dist";
    expect(isInsideStaticRoot(root, root, posix)).toBe(true);
    expect(isInsideStaticRoot(root, "/srv/app/dist/index.html", posix)).toBe(true);
    expect(isInsideStaticRoot(root + "/", "/srv/app/dist/assets/a.js", posix)).toBe(true);
    expect(isInsideStaticRoot(root, "/srv/app/x", posix)).toBe(false);
    expect(isInsideStaticRoot(root, "/srv/app", posix)).toBe(false);
    expect(isInsideStaticRoot(root, "/srv/app/dist2/z", posix)).toBe(false);
    expect(isInsideStaticRoot(root, "/etc/hosts", posix)).toBe(false);
  });

  test("uses the host platform's separators by default", () => {
    const root = join(tmpdir(), "pi-harness-web-root");
    expect(isInsideStaticRoot(root, join(root, "index.html"))).toBe(true);
    expect(isInsideStaticRoot(root, join(root, "..", "escape"))).toBe(false);
  });
});
