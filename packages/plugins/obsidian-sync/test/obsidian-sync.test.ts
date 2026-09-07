import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import obsidianSyncPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";

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

  test("replaces an existing note on a second call", async () => {
    const { vault, tool } = await fixture();
    await tool.execute("first", { relativePath: "notes/today.md", content: "# Original", confirm: true }, undefined, undefined, {} as never);
    await expect(
      tool.execute("second", { relativePath: "notes/today.md", content: "# Replaced", confirm: true }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ details: { relativePath: "notes/today.md" } });
    await expect(readFile(join(vault, "notes/today.md"), "utf8")).resolves.toBe("# Replaced");
  });

  test("keeps the permissions of a note it replaces and creates a new note owner-only", async () => {
    const { vault, tool } = await fixture();
    const path = join(vault, "notes/today.md");
    await tool.execute("first", { relativePath: "notes/today.md", content: "# Original", confirm: true }, undefined, undefined, {} as never);
    await expect(stat(path).then((info) => info.mode & 0o777)).resolves.toBe(0o600);
    await chmod(path, 0o644);

    await tool.execute("second", { relativePath: "notes/today.md", content: "# Replaced", confirm: true }, undefined, undefined, {} as never);

    await expect(readFile(path, "utf8")).resolves.toBe("# Replaced");
    await expect(stat(path).then((info) => info.mode & 0o777)).resolves.toBe(0o644);
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
