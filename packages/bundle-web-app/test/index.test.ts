import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import webServerPlugin from "@pi-harness/host-webserver";
import webAppPlugin from "../src/index.js";

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
