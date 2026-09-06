import { describe, expect, test } from "vitest";
import { mcpClientPanelView } from "../src/mcp-client-view.js";

describe("MCP client panel view", () => {
  test("normalizes server inventories and production limits", () => {
    const view = mcpClientPanelView({
      server: "node server.mjs",
      tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object" } }],
      resources: [{ uri: "fixture://readme", name: "Readme", mimeType: "text/plain" }],
      prompts: [{ name: "review", description: "Review code", arguments: [] }],
      lastCall: "echo",
      servers: [{ id: "docs", command: ["node", "server.mjs"], status: "running", startedAt: 100 }],
      inventory: {
        tools: { total: 1, shown: 1, truncated: false },
        resources: { total: 1, shown: 1, truncated: false },
        prompts: { total: 1, shown: 1, truncated: false },
        servers: { total: 1, shown: 1, truncated: false },
      },
      limits: {
        responseBytes: 1_048_576,
        commandArgs: 32,
        argumentBytes: 4_096,
        toolArgumentsBytes: 65_536,
        toolArgumentDepth: 32,
        requestTimeoutMs: 30_000,
        panelItems: 20,
        inventoryItems: 1_000,
        paginationPages: 100,
        stderrBytes: 8_192,
        managedServers: 128,
      },
    });

    expect(view).toEqual({
      server: "node server.mjs",
      tools: [{ name: "echo", description: "Echo text" }],
      resources: [{ uri: "fixture://readme", name: "Readme", mimeType: "text/plain" }],
      prompts: [{ name: "review", description: "Review code" }],
      lastCall: "echo",
      servers: [{ id: "docs", status: "running", startedAt: 100 }],
      inventory: {
        tools: { total: 1, shown: 1, truncated: false },
        resources: { total: 1, shown: 1, truncated: false },
        prompts: { total: 1, shown: 1, truncated: false },
        servers: { total: 1, shown: 1, truncated: false },
      },
      limits: {
        responseBytes: 1_048_576,
        commandArgs: 32,
        argumentBytes: 4_096,
        toolArgumentsBytes: 65_536,
        toolArgumentDepth: 32,
        requestTimeoutMs: 30_000,
        panelItems: 20,
        inventoryItems: 1_000,
        paginationPages: 100,
        stderrBytes: 8_192,
        managedServers: 128,
      },
    });
  });

  test("bounds hostile arrays and strings and marks clipped inventories", () => {
    const long = "x".repeat(10_000);
    const view = mcpClientPanelView({
      server: long,
      tools: [{ name: 42 }, ...Array.from({ length: 20 }, (_, index) => ({ name: `${index}-${long}`, description: long }))],
      resources: Array.from({ length: 20 }, (_, index) => ({ uri: `fixture://${index}/${long}`, name: long, mimeType: long })),
      prompts: Array.from({ length: 20 }, (_, index) => ({ name: `${index}-${long}`, description: long })),
      servers: Array.from({ length: 20 }, (_, index) => ({ id: `${index}-${long}`, status: index === 0 ? "running" : long, startedAt: -1 })),
      lastCall: long,
      inventory: { tools: { total: -1 }, resources: {}, prompts: {} },
      limits: {},
    });

    expect(view.server).toBe("x".repeat(4_096));
    expect(view.lastCall).toBe("x".repeat(512));
    expect(view.tools).toHaveLength(12);
    expect(view.tools[0]).toEqual({ name: `0-${"x".repeat(510)}`, description: "x".repeat(500) });
    expect(view.resources).toHaveLength(8);
    expect(view.resources[0]?.uri).toHaveLength(4_096);
    expect(view.resources[0]?.name).toHaveLength(512);
    expect(view.resources[0]?.mimeType).toHaveLength(256);
    expect(view.prompts).toHaveLength(8);
    expect(view.servers).toHaveLength(12);
    expect(view.servers[0]).toEqual({ id: `0-${"x".repeat(62)}`, status: "running", startedAt: 0 });
    expect(view.servers[1]?.status).toBe("unknown");
    expect(view.inventory.tools).toEqual({ total: 12, shown: 12, truncated: true });
    expect(view.inventory.resources).toEqual({ total: 8, shown: 8, truncated: true });
    expect(view.inventory.prompts).toEqual({ total: 8, shown: 8, truncated: true });
    expect(view.inventory.servers).toEqual({ total: 12, shown: 12, truncated: true });
    expect(view.limits).toEqual({
      responseBytes: 1_048_576,
      commandArgs: 32,
      argumentBytes: 4_096,
      toolArgumentsBytes: 65_536,
      toolArgumentDepth: 32,
      requestTimeoutMs: 30_000,
      panelItems: 20,
      inventoryItems: 1_000,
      paginationPages: 100,
      stderrBytes: 8_192,
      managedServers: 128,
    });
  });
});
