import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test, vi } from "vitest";
import mcpClientPlugin from "../src/plugins/mcp-client.js";
import { PiPluginUiRegistry, PiToolRegistry } from "../src/services.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFixture(options?: { servers?: Array<{ id: string; command: string[]; autoStart?: boolean }>; launchCwd?: string; loadPlugin?: boolean }) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-harness-mcp-client-workspace-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-harness-mcp-client-agent-"));
  temporaryDirectories.push(cwd, agentDir);
  const context = new Context();
  const tools = new PiToolRegistry();
  const panels = new PiPluginUiRegistry();
  context.provide("piHarnessLaunch", { cwd: options?.launchCwd ?? cwd, agentDir, args: [], requestExit() {} });
  context.provide("piTools", tools);
  context.provide("piPluginUi", panels);
  if (options?.loadPlugin !== false) await context.plugin(mcpClientPlugin, options?.servers === undefined ? {} : { servers: options.servers });
  return { context, cwd, tools, panels };
}

function tool(tools: PiToolRegistry, name: string) {
  const result = tools.snapshot().customTools.find((candidate) => candidate.name === name);
  if (result === undefined) throw new Error(`${name} was not registered`);
  return result;
}

async function writeServer(cwd: string, body: string): Promise<string> {
  const path = join(cwd, `server-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(path, body, "utf8");
  return path;
}

describe("MCP client production boundaries", () => {
  test("rejects unknown configuration before registering any surface", async () => {
    const fixture = await createFixture({ loadPlugin: false });
    try {
      await expect(fixture.context.plugin(mcpClientPlugin, { unexpected: true } as never)).rejects.toThrow(/unknown.*unexpected/iu);
      expect(fixture.tools.snapshot().customTools).toEqual([]);
      await expect(fixture.panels.snapshot()).resolves.toEqual([]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("declares strict sequential schemas for every stateful tool", async () => {
    const fixture = await createFixture();
    try {
      for (const name of [
        "mcp_list_tools",
        "mcp_call",
        "mcp_server_start",
        "mcp_server_status",
        "mcp_server_stop",
        "mcp_list_resources",
        "mcp_read_resource",
        "mcp_list_prompts",
        "mcp_get_prompt",
      ]) {
        const candidate = tool(fixture.tools, name);
        expect(candidate.executionMode, name).toBe("sequential");
        expect(candidate.parameters, name).toMatchObject({ additionalProperties: false });
      }
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects class instances as raw MCP parameter objects", async () => {
    const fixture = await createFixture();
    class Parameters {
      readonly command = [process.execPath, "server.mjs"];
    }
    try {
      await expect(tool(fixture.tools, "mcp_list_tools").execute("instance", new Parameters(), undefined, undefined, {} as never)).rejects.toThrow(
        /parameters.*plain object/iu,
      );
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rolls back every registered tool when panel registration fails", async () => {
    const fixture = await createFixture({ loadPlugin: false });
    fixture.panels.register({ id: "mcp-client-panel", pluginId: "fixture", title: "Fixture", read: () => ({}) });
    try {
      await expect(fixture.context.plugin(mcpClientPlugin, {})).rejects.toThrow(/panel is already registered: mcp-client-panel/iu);
      expect(fixture.tools.snapshot().customTools).toEqual([]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rolls back registered surfaces when an auto-start server fails", async () => {
    const fixture = await createFixture({ loadPlugin: false, servers: [{ id: "broken", command: ["/definitely/missing-mcp-server"], autoStart: true }] });
    try {
      await expect(
        fixture.context.plugin(mcpClientPlugin, { servers: [{ id: "broken", command: ["/definitely/missing-mcp-server"], autoStart: true }] }),
      ).rejects.toThrow();
      expect(fixture.tools.snapshot().customTools).toEqual([]);
      await expect(fixture.panels.snapshot()).resolves.toEqual([]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("strictly validates raw parameters without invoking accessors", async () => {
    const fixture = await createFixture();
    let accessed = false;
    const params = {} as { command?: string[] };
    Object.defineProperty(params, "command", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("MCP accessor executed");
      },
    });
    try {
      await expect(tool(fixture.tools, "mcp_list_tools").execute("accessor", params, undefined, undefined, {} as never)).rejects.toThrow(
        /parameters.*data properties/iu,
      );
      expect(accessed).toBe(false);
      await expect(tool(fixture.tools, "mcp_server_status").execute("unknown", { unexpected: true }, undefined, undefined, {} as never)).rejects.toThrow(
        /unknown property/iu,
      );
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects portable shell wrapper names", async () => {
    const fixture = await createFixture();
    try {
      for (const command of ["C:\\tools\\sh.exe", "C:\\tools\\bash.cmd", "C:\\tools\\powershell.bat", "C:\\tools\\cmd.com"]) {
        await expect(
          tool(fixture.tools, "mcp_list_tools").execute("shell", { command: [command, "server.js"] }, undefined, undefined, {} as never),
        ).rejects.toThrow(/shell wrapper/iu);
      }
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels and reaps a one-shot server when the plugin is disposed", async () => {
    const fixture = await createFixture();
    const requested = join(fixture.cwd, "requested");
    const server = await writeServer(
      fixture.cwd,
      `import { writeFileSync } from "node:fs";
console.error("server diagnostic");
let buffer = "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "hang", version: "1" } } }); else if (message.method === "tools/list") writeFileSync(${JSON.stringify(requested)}, "yes"); } });`,
    );
    const controller = new AbortController();
    const rejected = join(fixture.cwd, "rejected");
    const pending = tool(fixture.tools, "mcp_list_tools").execute(
      "dispose",
      { command: [process.execPath, server] },
      controller.signal,
      undefined,
      {} as never,
    );
    let rejection: unknown;
    void pending.catch(async (error: unknown) => {
      rejection = error;
      await writeFile(rejected, "yes", "utf8");
    });
    try {
      await vi.waitFor(() => expect(existsSync(requested)).toBe(true));
      await fixture.context.fiber.dispose();
      await vi.waitFor(() => expect(existsSync(rejected)).toBe(true), { timeout: 500 });
      expect(rejection).toMatchObject({ message: "MCP client plugin disposed" });
    } finally {
      controller.abort(new Error("test cleanup"));
      await pending.catch(() => undefined);
    }
  });

  test("detaches and bounds remote inventories before publishing the panel", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "inventory", version: "1" } } }); else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: Array.from({ length: 40 }, (_, index) => ({ name: "tool-" + index, description: "d".repeat(1000), inputSchema: { type: "object" } })) } }); } });`,
    );
    try {
      const result = await tool(fixture.tools, "mcp_list_tools").execute("list", { command: [process.execPath, server] }, undefined, undefined, {} as never);
      (result.details as { tools: Array<{ name: string }> }).tools[0]!.name = "mutated-through-tool";
      const first = await fixture.panels.snapshot();
      expect(first).toMatchObject([
        {
          id: "mcp-client-panel",
          data: {
            inventory: { tools: { total: 40, shown: 20, truncated: true }, resources: { total: 0 }, prompts: { total: 0 } },
            limits: { responseBytes: 1_048_576, commandArgs: 32, argumentBytes: 4_096, requestTimeoutMs: 30_000, panelItems: 20 },
          },
        },
      ]);
      const data = first[0]?.data as { tools: Array<{ name: string }> };
      expect(data.tools).toHaveLength(20);
      expect(data.tools[0]?.name).toBe("tool-0");
      data.tools[0]!.name = "mutated-through-panel";
      const second = await fixture.panels.snapshot();
      expect((second[0]?.data as { tools: Array<{ name: string }> }).tools[0]?.name).toBe("tool-0");
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("follows bounded pagination for one-shot and managed MCP inventories", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); const cursor = message.params?.cursor; if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "pagination", version: "1" } } }); else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: cursor === "tools-next" ? { tools: [{ name: "tool-2", inputSchema: { type: "object" } }] } : { tools: [{ name: "tool-1", inputSchema: { type: "object" } }], nextCursor: "tools-next" } }); else if (message.method === "resources/list") send({ jsonrpc: "2.0", id: message.id, result: cursor === "resources-next" ? { resources: [{ uri: "fixture://resource-2", name: "Resource 2" }] } : { resources: [{ uri: "fixture://resource-1", name: "Resource 1" }], nextCursor: "resources-next" } }); else if (message.method === "prompts/list") send({ jsonrpc: "2.0", id: message.id, result: cursor === "prompts-next" ? { prompts: [{ name: "prompt-2" }] } : { prompts: [{ name: "prompt-1" }], nextCursor: "prompts-next" } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_list_tools").execute("one-shot-pages", { command: [process.execPath, server] }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({ details: { tools: [{ name: "tool-1" }, { name: "tool-2" }] } });
      await tool(fixture.tools, "mcp_server_start").execute(
        "managed-pages-start",
        { command: [process.execPath, server], serverId: "pages" },
        undefined,
        undefined,
        {} as never,
      );
      await expect(
        tool(fixture.tools, "mcp_list_resources").execute("resource-pages", { serverId: "pages" }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({ details: { resources: [{ uri: "fixture://resource-1" }, { uri: "fixture://resource-2" }] } });
      await expect(
        tool(fixture.tools, "mcp_list_prompts").execute("prompt-pages", { serverId: "pages" }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({ details: { prompts: [{ name: "prompt-1" }, { name: "prompt-2" }] } });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects repeated MCP pagination cursors", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "cursor-loop", version: "1" } } }); else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [], nextCursor: "same" } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_list_tools").execute("cursor-loop", { command: [process.execPath, server] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/repeated.*pagination cursor/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("copies nested tool arguments without invoking accessors", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "arguments", version: "1" } } }); else if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "called" }] } }); } });`,
    );
    let accessed = false;
    const argumentsValue = {} as Record<string, unknown>;
    Object.defineProperty(argumentsValue, "secret", {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error("nested MCP accessor executed");
      },
    });
    try {
      await expect(
        tool(fixture.tools, "mcp_call").execute(
          "arguments-accessor",
          { command: [process.execPath, server], name: "echo", arguments: argumentsValue },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/arguments.*data properties/iu);
      expect(accessed).toBe(false);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects oversized tool arguments before starting a server", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        tool(fixture.tools, "mcp_call").execute(
          "oversized-arguments",
          { command: ["/definitely/missing-mcp-server"], name: "echo", arguments: { payload: "x".repeat(70 * 1024) } },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/arguments.*64 KiB/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects excessively deep tool arguments", async () => {
    const fixture = await createFixture();
    let argumentsValue: Record<string, unknown> = {};
    for (let depth = 0; depth < 40; depth += 1) argumentsValue = { nested: argumentsValue };
    try {
      await expect(
        tool(fixture.tools, "mcp_call").execute(
          "deep-arguments",
          { command: ["/definitely/missing-mcp-server"], name: "echo", arguments: argumentsValue },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/arguments.*32 levels/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("cancels a managed request while it is waiting in the server queue", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-mcp-client-queue-"));
    temporaryDirectories.push(cwd);
    const firstRequested = join(cwd, "first-requested");
    const server = await writeServer(
      cwd,
      `import { writeFileSync } from "node:fs"; let buffer = ""; let lists = 0; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "queue", version: "1" } } }); else if (message.method === "tools/list" && ++lists === 1) writeFileSync(${JSON.stringify(firstRequested)}, "yes"); } });`,
    );
    const fixture = await createFixture({ servers: [{ id: "queue", command: [process.execPath, server] }] });
    await tool(fixture.tools, "mcp_server_start").execute("start", { serverId: "queue" }, undefined, undefined, {} as never);
    const first = tool(fixture.tools, "mcp_list_tools").execute("first", { serverId: "queue" }, undefined, undefined, {} as never);
    void first.catch(() => undefined);
    const controller = new AbortController();
    let secondOutcome: unknown;
    let second: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(firstRequested)).toBe(true));
      second = tool(fixture.tools, "mcp_list_tools").execute("second", { serverId: "queue" }, controller.signal, undefined, {} as never);
      void second.catch((error: unknown) => {
        secondOutcome = error;
      });
      controller.abort(new Error("queued request cancelled"));
      await vi.waitFor(() => expect(secondOutcome).toBeInstanceOf(Error), { timeout: 500 });
      expect((secondOutcome as Error).message).toMatch(/cancelled/iu);
    } finally {
      await fixture.context.fiber.dispose();
      await first.catch(() => undefined);
      await second?.catch(() => undefined);
    }
  });

  test("retains stdout framing bytes between managed requests", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = "";
const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { data: "between requests" } });
const split = Math.floor(notification.length / 2);
const header = "Content-Length: " + Buffer.byteLength(notification) + "\\r\\n\\r\\n";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "framing", version: "1" } } }) + "\\n" + header + notification.slice(0, split)); else if (message.method === "tools/list") process.stdout.write(notification.slice(split) + JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "retained", inputSchema: { type: "object" } }] } }) + "\\n"); } });`,
    );
    try {
      await tool(fixture.tools, "mcp_server_start").execute(
        "start-framing",
        { command: [process.execPath, server], serverId: "framing" },
        undefined,
        undefined,
        {} as never,
      );
      await expect(
        tool(fixture.tools, "mcp_list_tools").execute("list-framing", { serverId: "framing" }, AbortSignal.timeout(500), undefined, {} as never),
      ).resolves.toMatchObject({ details: { tools: [{ name: "retained" }] } });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("bounds total bytes received before the matching response", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "bytes", version: "1" } } }); else if (message.method === "tools/list") { for (let index = 0; index < 1400; index += 1) send({ jsonrpc: "2.0", method: "notifications/message", params: { data: "x".repeat(900) } }); send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }); } } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_list_tools").execute("total-bytes", { command: [process.execPath, server] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/response exceeded the 1 MiB limit/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects remote inventories above the item limit", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "inventory-limit", version: "1" } } }); else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: Array.from({ length: 1001 }, (_, index) => ({ name: "tool-" + index, inputSchema: { type: "object" } })) } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_list_tools").execute("inventory-limit", { command: [process.execPath, server] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/inventory.*1000 items/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects malformed remote tool descriptors", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "malformed-tool", version: "1" } } }); else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "", description: 42, inputSchema: [] }] } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_list_tools").execute("malformed-tool", { command: [process.execPath, server] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/invalid MCP tool descriptor/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects malformed remote resource and prompt descriptors", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "malformed-inventory", version: "1" } } }); else if (message.method === "resources/list") send({ jsonrpc: "2.0", id: message.id, result: { resources: [{ uri: "fixture://missing-name" }] } }); else if (message.method === "prompts/list") send({ jsonrpc: "2.0", id: message.id, result: { prompts: [{ name: "", arguments: {} }] } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_list_resources").execute("malformed-resource", { command: [process.execPath, server] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/invalid MCP resource descriptor/iu);
      await expect(
        tool(fixture.tools, "mcp_list_prompts").execute("malformed-prompt", { command: [process.execPath, server] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/invalid MCP prompt descriptor/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects malformed MCP tool result content before returning it to the agent", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "malformed-result", version: "1" } } }); else if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: 42 }] } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_call").execute(
          "malformed-result",
          { command: [process.execPath, server], name: "echo", arguments: {} },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/invalid MCP tool result content/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects malformed base64 content before returning it to the agent", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "malformed-base64", version: "1" } } }); else if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "image", data: "not-base64!", mimeType: "image/png" }] } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_call").execute("malformed-base64", { command: [process.execPath, server], name: "image" }, undefined, undefined, {} as never),
      ).rejects.toThrow(/invalid MCP tool result content/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not publish an invalid MCP tool call as the latest successful call", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "invalid-call-state", version: "1" } } }); else if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: 42 }] } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_call").execute(
          "invalid-call-state",
          { command: [process.execPath, server], name: "broken" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/invalid MCP tool result content/iu);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { lastCall: null } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("normalizes resource and prompt payloads into agent text and image content", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "content", version: "1" } } }); else if (message.method === "resources/read") send({ jsonrpc: "2.0", id: message.id, result: { contents: [{ uri: message.params.uri, mimeType: "text/plain", text: "resource body" }, { uri: "fixture://image", mimeType: "image/png", blob: "aGVsbG8=" }] } }); else if (message.method === "prompts/get") send({ jsonrpc: "2.0", id: message.id, result: { description: "Review", messages: [{ role: "user", content: { type: "text", text: "Review this" } }] } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_read_resource").execute(
          "read-resource",
          { command: [process.execPath, server], uri: "fixture://readme" },
          undefined,
          undefined,
          {} as never,
        ),
      ).resolves.toMatchObject({
        content: [
          { type: "text", text: "resource body" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      });
      await expect(
        tool(fixture.tools, "mcp_get_prompt").execute("get-prompt", { command: [process.execPath, server], name: "review" }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({ content: [{ type: "text", text: "[user]\nReview this" }] });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("accepts spec-valid binary resources without an optional MIME type", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "optional-mime", version: "1" } } }); else if (message.method === "resources/read") send({ jsonrpc: "2.0", id: message.id, result: { contents: [{ uri: "fixture://binary", blob: "aGVsbG8=" }] } }); else if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "resource", resource: { uri: "fixture://embedded", blob: "aGVsbG8=" } }] } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_read_resource").execute(
          "optional-mime-read",
          { command: [process.execPath, server], uri: "fixture://binary" },
          undefined,
          undefined,
          {} as never,
        ),
      ).resolves.toMatchObject({ content: [{ type: "text", text: "[MCP binary resource omitted: fixture://binary (unknown MIME type)]" }] });
      await expect(
        tool(fixture.tools, "mcp_call").execute(
          "optional-mime-call",
          { command: [process.execPath, server], name: "binary" },
          undefined,
          undefined,
          {} as never,
        ),
      ).resolves.toMatchObject({ content: [{ type: "text", text: "[MCP binary resource omitted: fixture://embedded (unknown MIME type)]" }] });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not mix inventories from different MCP servers", async () => {
    const fixture = await createFixture();
    const resourceServer = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "resources", version: "1" } } }); else if (message.method === "resources/list") send({ jsonrpc: "2.0", id: message.id, result: { resources: [{ uri: "fixture://one", name: "One" }] } }); } });`,
    );
    const toolServer = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "tools", version: "1" } } }); else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }); } });`,
    );
    try {
      await tool(fixture.tools, "mcp_list_resources").execute("resources", { command: [process.execPath, resourceServer] }, undefined, undefined, {} as never);
      await tool(fixture.tools, "mcp_list_tools").execute("tools", { command: [process.execPath, toolServer] }, undefined, undefined, {} as never);
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { resources: [], tools: [{ name: "echo" }] } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects NUL command arguments and invalid server ids before spawning", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "validation", version: "1" } } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_list_tools").execute("nul-command", { command: [process.execPath, `bad\0argument`] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/command.*NUL/iu);
      await expect(
        tool(fixture.tools, "mcp_server_start").execute(
          "invalid-id",
          { command: [process.execPath, server], serverId: "bad id" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/serverId.*letters.*numbers/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("validates tool names, prompt names, and resource URIs before spawning", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        tool(fixture.tools, "mcp_call").execute(
          "invalid-tool-name",
          { command: ["/definitely/missing-mcp-server"], name: "" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/tool name.*1.*512/iu);
      await expect(
        tool(fixture.tools, "mcp_get_prompt").execute(
          "invalid-prompt-name",
          { command: ["/definitely/missing-mcp-server"], name: "bad\0name" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/prompt name.*NUL/iu);
      await expect(
        tool(fixture.tools, "mcp_read_resource").execute(
          "invalid-uri",
          { command: ["/definitely/missing-mcp-server"], uri: "bad\0uri" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/resource URI.*NUL/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("escalates to SIGKILL when a one-shot server ignores graceful shutdown", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const pidPath = join(fixture.cwd, "server.pid");
    const requested = join(fixture.cwd, "kill-requested");
    const server = await writeServer(
      fixture.cwd,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "ignore-term", version: "1" } } }); else if (message.method === "tools/list") writeFileSync(${JSON.stringify(requested)}, "yes"); } });`,
    );
    const pending = tool(fixture.tools, "mcp_list_tools").execute("kill-fallback", { command: [process.execPath, server] }, undefined, undefined, {} as never);
    void pending.catch(() => undefined);
    let pid: number | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(requested)).toBe(true));
      pid = Number(await readFile(pidPath, "utf8"));
      await fixture.context.fiber.dispose();
      await pending.catch(() => undefined);
      await vi.waitFor(
        () => {
          expect(() => process.kill(pid!, 0)).toThrow();
        },
        { timeout: 1500 },
      );
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The plugin already reaped the process.
        }
      }
      await fixture.context.fiber.dispose();
      await pending.catch(() => undefined);
    }
  });

  test("cancels a stop request while an earlier managed request is still running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-mcp-client-stop-"));
    temporaryDirectories.push(cwd);
    const requested = join(cwd, "stop-wait-requested");
    const server = await writeServer(
      cwd,
      `import { writeFileSync } from "node:fs"; let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stop-wait", version: "1" } } }); else if (message.method === "tools/list") writeFileSync(${JSON.stringify(requested)}, "yes"); } });`,
    );
    const fixture = await createFixture({ servers: [{ id: "stop-wait", command: [process.execPath, server] }] });
    await tool(fixture.tools, "mcp_server_start").execute("start", { serverId: "stop-wait" }, undefined, undefined, {} as never);
    const first = tool(fixture.tools, "mcp_list_tools").execute("list", { serverId: "stop-wait" }, undefined, undefined, {} as never);
    void first.catch(() => undefined);
    const controller = new AbortController();
    let stopOutcome: unknown;
    let stopping: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(requested)).toBe(true));
      stopping = tool(fixture.tools, "mcp_server_stop").execute("stop", { serverId: "stop-wait" }, controller.signal, undefined, {} as never);
      void stopping.catch((error: unknown) => {
        stopOutcome = error;
      });
      controller.abort(new Error("stop cancelled"));
      await vi.waitFor(() => expect(stopOutcome).toBeInstanceOf(Error), { timeout: 500 });
      expect((stopOutcome as Error).message).toMatch(/cancelled/iu);
    } finally {
      await fixture.context.fiber.dispose();
      await first.catch(() => undefined);
      await stopping?.catch(() => undefined);
    }
  });

  test("bounds captured server stderr by UTF-8 bytes", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `process.stderr.write("🙂".repeat(5000)); let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; const newline = buffer.indexOf("\\n"); if (newline < 0) return; const message = JSON.parse(buffer.slice(0, newline)); send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "boom" } }); });`,
    );
    let failure: unknown;
    try {
      await tool(fixture.tools, "mcp_list_tools")
        .execute("stderr", { command: [process.execPath, server] }, undefined, undefined, {} as never)
        .catch((error: unknown) => {
          failure = error;
        });
      expect(failure).toBeInstanceOf(Error);
      expect(Buffer.byteLength((failure as Error).message, "utf8")).toBeLessThanOrEqual(8300);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects invalid UTF-8 in MCP JSON frames", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "utf8", version: "1" } } }); else if (message.method === "tools/list") process.stdout.write(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":' + message.id + ',"result":{"tools":[{"name":"'), Buffer.from([0xc3, 0x28]), Buffer.from('","inputSchema":{"type":"object"}}]}}\\n')])); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_list_tools").execute("invalid-utf8", { command: [process.execPath, server] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/valid UTF-8/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects malformed JSON-RPC response envelopes", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "rpc", version: "1" } } }); else if (message.method === "tools/list") send({ id: message.id, result: { tools: [] } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_list_tools").execute("invalid-rpc", { command: [process.execPath, server] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/invalid JSON-RPC response/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects an invalid initialize result before sending initialized", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "unsupported", capabilities: [], serverInfo: { name: "", version: 1 } } }); else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }); } });`,
    );
    try {
      await expect(
        tool(fixture.tools, "mcp_list_tools").execute("invalid-initialize", { command: [process.execPath, server] }, undefined, undefined, {} as never),
      ).rejects.toThrow(/invalid MCP initialize result/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("detaches resource and prompt details from panel state", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "detach", version: "1" } } }); else if (message.method === "resources/list") send({ jsonrpc: "2.0", id: message.id, result: { resources: [{ uri: "fixture://original", name: "Original" }] } }); else if (message.method === "prompts/list") send({ jsonrpc: "2.0", id: message.id, result: { prompts: [{ name: "original", arguments: [] }] } }); } });`,
    );
    try {
      const resourcesResult = await tool(fixture.tools, "mcp_list_resources").execute(
        "resources",
        { command: [process.execPath, server] },
        undefined,
        undefined,
        {} as never,
      );
      (resourcesResult.details as { resources: Array<{ uri: string }> }).resources[0]!.uri = "fixture://mutated";
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { resources: [{ uri: "fixture://original" }] } }]);
      const promptsResult = await tool(fixture.tools, "mcp_list_prompts").execute(
        "prompts",
        { command: [process.execPath, server] },
        undefined,
        undefined,
        {} as never,
      );
      (promptsResult.details as { prompts: Array<{ name: string }> }).prompts[0]!.name = "mutated";
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([{ data: { prompts: [{ name: "original" }] } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("detaches managed server command snapshots from tool results", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "snapshot", version: "1" } } }); } });`,
    );
    try {
      const started = await tool(fixture.tools, "mcp_server_start").execute(
        "start",
        { command: [process.execPath, server], serverId: "snapshot" },
        undefined,
        undefined,
        {} as never,
      );
      (started.details as { executable: string }).executable = "mutated";
      const status = await tool(fixture.tools, "mcp_server_status").execute("status", {}, undefined, undefined, {} as never);
      expect((status.details as { servers: Array<{ executable: string }> }).servers[0]?.executable).toBe(process.execPath.split("/").pop());
      (status.details as { servers: Array<{ executable: string }> }).servers[0]!.executable = "mutated-again";
      const secondStatus = await tool(fixture.tools, "mcp_server_status").execute("status-again", {}, undefined, undefined, {} as never);
      expect((secondStatus.details as { servers: Array<{ executable: string }> }).servers[0]?.executable).toBe(process.execPath.split("/").pop());
      await expect(fixture.panels.snapshot()).resolves.toMatchObject([
        { data: { servers: [{ id: "snapshot", executable: process.execPath.split("/").pop(), argumentCount: 1, status: "running" }] } },
      ]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("reserves managed server ids while concurrent starts initialize", async () => {
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "concurrent", version: "1" } } }), 100); } });`,
    );
    try {
      const starts = await Promise.allSettled([
        tool(fixture.tools, "mcp_server_start").execute(
          "start-1",
          { command: [process.execPath, server], serverId: "same" },
          undefined,
          undefined,
          {} as never,
        ),
        tool(fixture.tools, "mcp_server_start").execute(
          "start-2",
          { command: [process.execPath, server], serverId: "same" },
          undefined,
          undefined,
          {} as never,
        ),
      ]);
      expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(starts.filter((result) => result.status === "rejected")).toHaveLength(1);
      const rejection = starts.find((result) => result.status === "rejected");
      expect(rejection?.status).toBe("rejected");
      const reason: unknown = rejection?.status === "rejected" ? (rejection.reason as unknown) : undefined;
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).message).toMatch(/already.*starting|already running/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("releases a managed server id when process spawning throws synchronously", async () => {
    const fixture = await createFixture({ launchCwd: "invalid\0cwd" });
    try {
      const start = () =>
        tool(fixture.tools, "mcp_server_start").execute(
          "sync-spawn-failure",
          { command: [process.execPath, "server.mjs"], serverId: "retryable" },
          undefined,
          undefined,
          {} as never,
        );
      await expect(start()).rejects.toThrow(/null bytes|must be a string without null bytes|invalid.*cwd/iu);
      await expect(start()).rejects.toThrow(/null bytes|must be a string without null bytes|invalid.*cwd/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not expose command arguments in the plugin panel", async () => {
    const secret = "secret-command-argument";
    const fixture = await createFixture({ servers: [{ id: "private", command: [process.execPath, secret] }] });
    try {
      const panels = await fixture.panels.snapshot();
      expect(JSON.stringify(panels)).not.toContain(secret);
      expect(panels).toMatchObject([
        {
          data: {
            servers: [{ id: "private", executable: process.execPath.split("/").pop(), argumentCount: 1, status: "stopped" }],
          },
        },
      ]);
      const status = await tool(fixture.tools, "mcp_server_status").execute("status", {}, undefined, undefined, {} as never);
      expect(JSON.stringify(status)).not.toContain(secret);
      expect(status).toMatchObject({ details: { servers: [{ id: "private", executable: process.execPath.split("/").pop(), argumentCount: 1 }] } });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not expose command arguments in the mcp_server_start result", async () => {
    const secret = "ghp_secret-token-argument";
    const fixture = await createFixture();
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "private-start", version: "1" } } }); } });`,
    );
    try {
      const started = await tool(fixture.tools, "mcp_server_start").execute(
        "start",
        { command: [process.execPath, server, "--token", secret], serverId: "private-start" },
        undefined,
        undefined,
        {} as never,
      );
      expect(JSON.stringify(started)).not.toContain(secret);
      expect(JSON.stringify(started)).not.toContain(server);
      expect(started.details).toEqual({ serverId: "private-start", executable: process.execPath.split("/").pop(), argumentCount: 3, status: "running" });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("does not expose one-shot command arguments as the latest server label", async () => {
    const fixture = await createFixture();
    const secret = "secret-one-shot-argument";
    const server = await writeServer(
      fixture.cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "private", version: "1" } } }); else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }); } });`,
    );
    try {
      await tool(fixture.tools, "mcp_list_tools").execute("private", { command: [process.execPath, server, secret] }, undefined, undefined, {} as never);
      const panels = await fixture.panels.snapshot();
      expect(JSON.stringify(panels)).not.toContain(secret);
      expect(panels).toMatchObject([{ data: { server: `${process.execPath.split("/").pop()} (+2 args)` } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("accepts only string values for MCP prompt arguments", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        tool(fixture.tools, "mcp_get_prompt").execute(
          "prompt-arguments",
          { command: ["/definitely/missing-mcp-server"], name: "review", arguments: { count: 2 } },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/prompt arguments.*string values/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects oversized configured server inventories", async () => {
    let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
    let failure: unknown;
    try {
      fixture = await createFixture({
        servers: Array.from({ length: 129 }, (_, index) => ({ id: `server-${index}`, command: [process.execPath, "server.mjs"] })),
      });
    } catch (error) {
      failure = error;
    } finally {
      await fixture?.context.fiber.dispose();
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/configured.*128 servers/iu);
  });

  test("does not allocate an automatic id reserved by configuration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-mcp-client-id-"));
    temporaryDirectories.push(cwd);
    const configuredServer = await writeServer(cwd, `process.stdin.resume();`);
    const directServer = await writeServer(
      cwd,
      `let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "direct", version: "1" } } }); } });`,
    );
    const fixture = await createFixture({ servers: [{ id: "mcp-1", command: [process.execPath, configuredServer] }] });
    try {
      await expect(
        tool(fixture.tools, "mcp_server_start").execute("automatic-id", { command: [process.execPath, directServer] }, undefined, undefined, {} as never),
      ).resolves.toMatchObject({ details: { serverId: "mcp-2" } });
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("rejects ambiguous one-shot and managed server targets", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        tool(fixture.tools, "mcp_list_tools").execute(
          "ambiguous-target",
          { command: [process.execPath, "server.mjs"], serverId: "configured" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(/either command or serverId, not both/iu);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("reports truncated managed server inventory in the panel", async () => {
    const fixture = await createFixture({
      servers: Array.from({ length: 25 }, (_, index) => ({ id: `server-${index}`, command: [process.execPath, "server.mjs"] })),
    });
    try {
      const panels = await fixture.panels.snapshot();
      expect((panels[0]?.data as { servers: unknown[] }).servers).toHaveLength(20);
      expect(panels).toMatchObject([{ data: { inventory: { servers: { total: 25, shown: 20, truncated: true } } } }]);
    } finally {
      await fixture.context.fiber.dispose();
    }
  });

  test("stops a managed server without waiting for an in-flight request timeout", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-mcp-client-fast-stop-"));
    temporaryDirectories.push(cwd);
    const requested = join(cwd, "fast-stop-requested");
    const server = await writeServer(
      cwd,
      `import { writeFileSync } from "node:fs"; let buffer = ""; const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n"); process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const newline = buffer.indexOf("\\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue; const message = JSON.parse(line); if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fast-stop", version: "1" } } }); else if (message.method === "tools/list") writeFileSync(${JSON.stringify(requested)}, "yes"); } });`,
    );
    const fixture = await createFixture({ servers: [{ id: "fast-stop", command: [process.execPath, server] }] });
    await tool(fixture.tools, "mcp_server_start").execute("start", { serverId: "fast-stop" }, undefined, undefined, {} as never);
    const pending = tool(fixture.tools, "mcp_list_tools").execute("list", { serverId: "fast-stop" }, undefined, undefined, {} as never);
    void pending.catch(() => undefined);
    let stopped: unknown;
    let stopping: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(requested)).toBe(true));
      stopping = tool(fixture.tools, "mcp_server_stop")
        .execute("stop", { serverId: "fast-stop" }, undefined, undefined, {} as never)
        .then((result) => {
          stopped = result;
        });
      void stopping.catch(() => undefined);
      await vi.waitFor(() => expect(stopped).toMatchObject({ details: { stopped: true } }), { timeout: 500 });
      await expect(pending).rejects.toThrow(/stopped/iu);
    } finally {
      await fixture.context.fiber.dispose();
      await pending.catch(() => undefined);
      await stopping?.catch(() => undefined);
    }
  });
});
