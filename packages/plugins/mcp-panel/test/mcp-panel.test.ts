import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import assert from "node:assert/strict";
import { afterEach, describe, expect, test } from "vitest";
import mcpPanelPlugin from "../src/index.js";
import { PiPluginUiRegistry, PiToolRegistry, provideLaunchContext } from "@pi-harness/plugin-api";
import { parse } from "yaml";
import mcpClientPlugin, { type McpClientConfig } from "@pi-harness/plugin-mcp-client";
import { fileURLToPath } from "node:url";

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}

function patchConfig(value: unknown): McpClientConfig {
  const config = record(record(array(value)[0]).config);
  for (const item of array(config.servers)) {
    const server = record(item);
    assert(typeof server.id === "string");
    assert(array(server.command).every((part) => typeof part === "string"));
    assert(server.autoStart === undefined || typeof server.autoStart === "boolean");
  }
  return config;
}

const contexts: Context[] = [];
const roots: string[] = [];

async function fixture(withMcp = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-mcp-panel-"));
  roots.push(root);
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  provideLaunchContext(context, { cwd: root, agentDir: root, args: [], requestExit() {} });
  if (withMcp)
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP panel", () => {
  test("activates without MCP and allows preview while marking runtime status unavailable", async () => {
    const { tool, panels } = await fixture(false);
    const result = await tool.execute("status", { action: "status" }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ available: false, servers: [] });
    expect(JSON.stringify(result.content)).toMatch(/unavailable/iu);
    expect((await panels.snapshot())[0]?.data).toMatchObject({ available: false });
    await expect(
      tool.execute("preview", { action: "preview", serverId: "new", command: ["node", "test.mjs"] }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ details: { action: "preview" } });
    await expect(tool.execute("tools", { action: "tools", serverId: "missing" }, undefined, undefined, {} as never)).rejects.toThrow(/enable.*MCP client/iu);
  });

  test("reflects MCP provider activation and removal without exposing command arguments", async () => {
    const { context, tool, panels } = await fixture(false);
    const provider = await context.plugin(mcpClientPlugin, {
      servers: [{ id: "late", command: ["node", "private-argument.mjs"], autoStart: false }],
    });
    const active = await tool.execute("active", { action: "status" }, undefined, undefined, {} as never);
    expect(active.details).toMatchObject({ available: true, servers: [{ id: "late", executable: "node" }] });
    expect(JSON.stringify(active)).not.toContain("private-argument.mjs");
    expect((await panels.snapshot())[0]?.data).toMatchObject({ available: true });
    await provider.dispose();
    const removed = await tool.execute("removed", { action: "status" }, undefined, undefined, {} as never);
    expect(removed.details).toMatchObject({ available: false, servers: [] });
    expect((await panels.snapshot())[0]?.data).toMatchObject({ available: false, servers: [] });
  });

  test("preserves real discovery schemas and actionable health suggestions", async () => {
    const context = new Context(),
      tools = new PiToolRegistry(),
      panels = new PiPluginUiRegistry();
    provideLaunchContext(context, { cwd: process.cwd(), agentDir: process.cwd(), args: [], requestExit() {} });
    context.provide("piTools", tools);
    context.provide("piPluginUi", panels);
    const command = [process.execPath, fileURLToPath(new URL("../../../../scripts/fixtures/plugin-verification/mcp/server.mjs", import.meta.url))];
    try {
      await context.plugin(mcpClientPlugin, { servers: [{ id: "local", command, autoStart: false }] });
      await context.plugin(mcpPanelPlugin, {});
      const tool = tools.snapshot().customTools.find((t) => t.name === "mcp_panel")!;
      const health = await tool.execute("health", { action: "health", serverId: "local" }, undefined, undefined, {} as never);
      expect(JSON.stringify(health.content)).toContain("mcp_server_start");
      await tools
        .snapshot()
        .customTools.find((t) => t.name === "mcp_server_start")!
        .execute("start", { serverId: "local" }, undefined, undefined, {} as never);
      const result = await tool.execute("tools", { action: "tools", serverId: "local" }, undefined, undefined, {} as never);
      const resultTools = array(record(JSON.parse((result.content[0] as { text: string }).text)).tools);
      expect(record(record(resultTools[0]).inputSchema).required).toEqual(["auditValue"]);
    } finally {
      await context.fiber.dispose();
    }
  });

  test("keeps repeated applies loadable as one MCP client with multiple server definitions", async () => {
    const { root, tool } = await fixture();
    for (const serverId of ["first", "second"]) {
      await tool.execute("apply", { action: "apply", serverId, command: ["node", "fixture.mjs"], confirm: true }, undefined, undefined, {} as never);
    }
    const rows: unknown = parse(await readFile(join(root, "patch.yml"), "utf8"));
    expect(rows).toHaveLength(1);
    const config = patchConfig(rows);
    expect(config.servers?.map((server) => server.id)).toEqual(["first", "second"]);
    const loaded = new Context();
    const tools = new PiToolRegistry();
    provideLaunchContext(loaded, { cwd: root, agentDir: root, args: [], requestExit() {} });
    loaded.provide("piTools", tools);
    loaded.provide("piPluginUi", new PiPluginUiRegistry());
    try {
      await loaded.plugin(mcpClientPlugin, config);
      expect(loaded.piMcp.snapshot().servers.map((server) => server.id)).toEqual(["first", "second"]);
    } finally {
      await loaded.fiber.dispose();
    }
  });

  test("rejects malformed or unrelated YAML before replacing the file or its backup", async () => {
    const { root, tool } = await fixture();
    const path = join(root, "patch.yml"),
      backup = path + ".bak";
    for (const content of [
      "invalid: [",
      "- name: unrelated\n  config: {}\n",
      "- null\n",
      "- []\n",
      "- id: broken\n  name: '@pi-harness/plugin-mcp-client'\n  config: null\n",
      "- id: broken\n  name: '@pi-harness/plugin-mcp-client'\n  config: { servers: [null] }\n",
      "- id: broken\n  name: '@pi-harness/plugin-mcp-client'\n  config: { servers: [{ id: old, command: [node, 42] }] }\n",
      "- id: broken\n  name: '@pi-harness/plugin-mcp-client'\n  config: { servers: [] }\n  config: {}\n",
    ]) {
      await writeFile(path, content);
      await writeFile(backup, "previous backup");
      await expect(
        tool.execute("invalid", { action: "apply", serverId: "next", command: ["node", "test.mjs"], confirm: true }, undefined, undefined, {} as never),
      ).rejects.toThrow(/patch|YAML/iu);
      expect(await readFile(path, "utf8")).toBe(content);
      expect(await readFile(backup, "utf8")).toBe("previous backup");
    }
  });

  test("consolidates old generated fragments and preserves server comments and the previous bytes", async () => {
    const { root, tool } = await fixture();
    const fragments: string[] = [];
    for (const serverId of ["old-first", "old-second"]) {
      const preview = await tool.execute(
        "preview",
        { action: "preview", serverId, command: ["node", "test.mjs", "argument with spaces"], autoStart: serverId === "old-second" },
        undefined,
        undefined,
        {} as never,
      );
      fragments.push((preview.details as { fragment: string }).fragment);
    }
    const previous = fragments.join("").replace('      - id: "old-first"', '      # keep server comment\n      - id: "old-first"');
    const path = join(root, "patch.yml");
    await writeFile(path, previous);
    await tool.execute("apply", { action: "apply", serverId: "new", command: ["node", "test.mjs"], confirm: true }, undefined, undefined, {} as never);
    const next = await readFile(path, "utf8");
    expect(parse(next)).toHaveLength(1);
    const config = patchConfig(parse(next));
    expect(config.servers?.map((server) => server.id)).toEqual(["old-first", "old-second", "new"]);
    expect(config.servers?.[1]).toEqual({ id: "old-second", command: ["node", "test.mjs", "argument with spaces"], autoStart: true });
    expect(next).toContain("keep server comment");
    expect(await readFile(path + ".bak", "utf8")).toBe(previous);
    await expect(
      tool.execute("duplicate", { action: "apply", serverId: "old-second", command: ["node", "test.mjs"], confirm: true }, undefined, undefined, {} as never),
    ).rejects.toThrow(/already exists/iu);
    expect(await readFile(path, "utf8")).toBe(next);
    expect(await readFile(path + ".bak", "utf8")).toBe(previous);
  });

  test("refuses alias expansion and the MCP configured server limit before writing", async () => {
    const { root, tool } = await fixture();
    const path = join(root, "patch.yml");
    const capacity = JSON.stringify([
      {
        id: "mcp",
        name: "@pi-harness/plugin-mcp-client",
        config: { servers: Array.from({ length: 128 }, (_, n) => ({ id: `server-${n}`, command: ["node", "test.mjs"], autoStart: false })) },
      },
    ]);
    for (const content of [
      capacity,
      '- id: mcp\n  name: "@pi-harness/plugin-mcp-client"\n  config:\n    servers: &items []\n- id: other\n  name: "@pi-harness/plugin-mcp-client"\n  config:\n    servers: *items\n',
    ]) {
      await writeFile(path, content);
      await expect(
        tool.execute("refuse", { action: "apply", serverId: "next", command: ["node", "test.mjs"], confirm: true }, undefined, undefined, {} as never),
      ).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(content);
      await expect(readFile(path + ".bak", "utf8")).rejects.toThrow(/ENOENT/iu);
    }
  });

  test("rejects cancelled and disposed operations without writing files", async () => {
    const { root, context, tool } = await fixture();
    const params = { action: "apply", serverId: "cancelled", command: ["node", "server.mjs"], confirm: true };
    const controller = new AbortController();
    controller.abort(new Error("Panel request cancelled"));
    await expect(tool.execute("cancel", params, controller.signal, undefined, {} as never)).rejects.toThrow(/cancelled/iu);
    await context.fiber.dispose();
    await expect(tool.execute("disposed", params, undefined, undefined, {} as never)).rejects.toThrow(/disposed/iu);
    expect(await readdir(root)).toEqual([]);
  });

  test("distinguishes undiscovered tools and delegates discovery to the MCP client", async () => {
    const { tools, panels, tool } = await fixture();
    const { defineTool } = await import("@earendil-works/pi-coding-agent");
    const { Type } = await import("@earendil-works/pi-ai");
    tools.register(
      defineTool({
        name: "mcp_list_tools",
        label: "List",
        description: "List real server tools",
        parameters: Type.Object({ serverId: Type.String() }),
        async execute(_id, params) {
          await Promise.resolve();
          expect(params.serverId).toBe("docs");
          return { content: [], details: { server: "node", tools: [{ name: "search", description: "Search documents" }] } };
        },
      }),
    );
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { servers: [{ toolCount: null }] } }]);
    const result = await tool.execute("discover", { action: "tools", serverId: "docs" }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ tools: [{ name: "search" }] });
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { servers: [{ toolCount: 1 }] } }]);
    (result.details as { tools: { name: string }[] }).tools[0]!.name = "mutated";
    await expect(panels.snapshot()).resolves.toMatchObject([{ data: { servers: [{ toolCount: 1 }] } }]);
  });

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

  test("refuses commands the MCP loader rejects at activation", async () => {
    const { root, tool } = await fixture();
    await expect(
      tool.execute("preview-shell", { action: "preview", serverId: "shell-server", command: ["bash", "-c", "my-server"] }, undefined, undefined, {} as never),
    ).rejects.toThrow(/shell wrappers are not allowed/iu);
    await expect(
      tool.execute(
        "apply-shell",
        { action: "apply", serverId: "shell-server", command: ["bash", "-c", "my-server"], confirm: true },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/shell wrappers are not allowed/iu);
    await expect(
      tool.execute("preview-nul", { action: "preview", serverId: "nul-server", command: ["server", "a\0b"] }, undefined, undefined, {} as never),
    ).rejects.toThrow(/NUL characters/iu);
    await expect(readFile(join(root, "patch.yml"), "utf8")).rejects.toThrow(/ENOENT/u);
  });
});
