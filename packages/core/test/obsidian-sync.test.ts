import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import obsidianSyncPlugin from "../src/plugins/obsidian-sync.js";
import { provideLaunchContext, PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-obsidian-"));
  const vault = join(root, "vault");
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(obsidianSyncPlugin, { vaultPath: vault });
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "obsidian_sync");
  if (tool === undefined) throw new Error("obsidian_sync was not registered");
  return { root, vault, context, tools, panels, tool };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("Obsidian sync", () => {
  test("writes a confirmed Markdown note inside the configured vault", async () => {
    const { vault, tool, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    await expect(
      tool.execute("sync", { relativePath: "notes/today.md", content: "# Today", confirm: true }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({
      details: { relativePath: "notes/today.md", bytes: 7 },
    });
    await expect(readFile(join(vault, "notes/today.md"), "utf8")).resolves.toBe("# Today");
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { configured: true, last: { relativePath: "notes/today.md" } } }]);
  });

  test("rejects unconfirmed or escaping paths and cleans up", async () => {
    const { context, tools, panels, tool } = await fixture();
    await expect(tool.execute("no", { relativePath: "x.md", content: "x", confirm: false }, undefined, undefined, {} as never)).rejects.toThrow(
      /confirm=true/iu,
    );
    await expect(tool.execute("escape", { relativePath: "../x.md", content: "x", confirm: true }, undefined, undefined, {} as never)).rejects.toThrow(
      /inside/iu,
    );
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });
});
