import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import webServerPlugin from "@pi-harness/host-webserver";
import webAppPlugin, { isInsideStaticRoot } from "../src/index.js";

const contexts: Context[] = [];

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
