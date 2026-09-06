import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import mcpPanelPlugin from "../src/plugins/mcp-panel.js";
import { provideLaunchContext, PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const contexts: Context[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-mcp-panel-"));
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  context.provide("piMcp", { snapshot: () => ({ servers: [{ id: "docs", command: ["node", "server.mjs"], status: "running", startedAt: 10 }] }) } as never);
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  await context.plugin(mcpPanelPlugin, { patchPath: "patch.yml" });
  contexts.push(context);
  const tool = tools.snapshot().customTools.find((item) => item.name === "mcp_panel");
  if (tool === undefined) throw new Error("mcp_panel was not registered");
  return { root, context, tools, panels, tool };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.fiber.dispose()));
});

describe("MCP panel", () => {
  test("reports status and previews a validated profile patch", async () => {
    const { tool, panels } = await fixture();
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    await expect(tool.execute("status", { action: "status" }, undefined, undefined, {} as never)).resolves.toMatchObject({
      details: { action: "status", servers: [{ id: "docs", status: "running", executable: "node" }] },
    });
    const preview = await tool.execute(
      "preview",
      { action: "preview", serverId: "new-server", command: ["node", "new.mjs"] },
      undefined,
      undefined,
      {} as never,
    );
    expect((preview.details as { fragment: string }).fragment).toContain('id: "new-server"');
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { writesEnabled: true } }]);
  });

  test("requires confirmation for writes, writes a backup, and cleans up", async () => {
    const { root, context, tools, panels, tool } = await fixture();
    await expect(
      tool.execute("apply", { action: "apply", serverId: "new-server", command: ["node", "new.mjs"], confirm: false }, undefined, undefined, {} as never),
    ).rejects.toThrow(/confirm=true/iu);
    const result = await tool.execute(
      "apply",
      { action: "apply", serverId: "new-server", command: ["node", "new.mjs"], confirm: true },
      undefined,
      undefined,
      {} as never,
    );
    expect((result.details as { path: string }).path).toContain("patch.yml");
    expect(await readFile(join(root, "patch.yml"), "utf8")).toContain("new-server");
    expect(await readFile(join(root, "patch.yml.bak"), "utf8")).toBe("");
    await context.fiber.dispose();
    expect(tools.snapshot().customTools).toHaveLength(0);
    await expect(panels.snapshot()).resolves.toHaveLength(0);
  });

  test("refreshes the backup with the profile immediately preceding each apply", async () => {
    const { root, tool } = await fixture();
    await tool.execute(
      "apply-first",
      { action: "apply", serverId: "first-server", command: ["node", "first.mjs"], confirm: true },
      undefined,
      undefined,
      {} as never,
    );
    const profileAfterFirstApply = await readFile(join(root, "patch.yml"), "utf8");

    await tool.execute(
      "apply-second",
      { action: "apply", serverId: "second-server", command: ["node", "second.mjs"], confirm: true },
      undefined,
      undefined,
      {} as never,
    );

    expect(await readFile(join(root, "patch.yml.bak"), "utf8")).toBe(profileAfterFirstApply);
  });
});
