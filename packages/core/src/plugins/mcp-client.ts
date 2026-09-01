import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;
type McpTool = { name: string; description?: string; inputSchema?: unknown };
type McpResource = { uri: string; name?: string; description?: string; mimeType?: string };
type McpPrompt = { name: string; description?: string; arguments?: unknown[] };
type McpCallResult = { content?: unknown[]; isError?: boolean } & JsonObject;
type ManagedServer = {
  id: string;
  command: string[];
  child: ChildProcessWithoutNullStreams;
  status: "running" | "stopping";
  nextRequestId: number;
  queue: Promise<void>;
  startedAt: number;
};

export interface McpServerDefinition {
  id: string;
  command: string[];
  autoStart?: boolean;
}

export interface McpClientConfig {
  servers?: McpServerDefinition[];
}

export const Config: z<McpClientConfig> = z.object({
  servers: z.array(z.object({ id: z.string(), command: z.array(z.string()), autoStart: z.boolean().default(false) })).default([]),
});

const shellCommands = new Set(["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"]);
const maxCommandArgs = 32;
const maxArgumentBytes = 4096;
const requestTimeoutMs = 30_000;

function validateCommand(command: string[]): void {
  if (command.length === 0) throw new Error("MCP server command cannot be empty");
  if (command.length > maxCommandArgs) throw new Error(`MCP server command cannot exceed ${maxCommandArgs} arguments`);
  if (command.some((part) => part.length === 0 || Buffer.byteLength(part) > maxArgumentBytes))
    throw new Error("MCP server command contains an invalid argument");
  if (shellCommands.has(basename(command[0] ?? "").toLowerCase())) throw new Error("MCP shell wrappers are not allowed; pass an executable argv directly");
}

function encodeMessage(message: JsonObject): Buffer<ArrayBufferLike> {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "ascii"), payload]);
}

function parseFrames(buffer: Buffer<ArrayBufferLike>): { messages: JsonObject[]; rest: Buffer<ArrayBufferLike> } {
  const messages: JsonObject[] = [];
  let rest = buffer;
  while (rest.length > 0) {
    const separator = rest.indexOf("\r\n\r\n");
    if (separator < 0 && /^content-length\s*:/i.test(rest.toString("ascii"))) break;
    if (separator >= 0 && /^content-length\s*:/i.test(rest.subarray(0, separator).toString("ascii"))) {
      const header = rest.subarray(0, separator).toString("ascii");
      const match = header.match(/content-length\s*:\s*(\d+)/i);
      if (match === null) throw new Error("MCP server returned an invalid Content-Length header");
      const length = Number(match[1]);
      const bodyStart = separator + 4;
      if (rest.length < bodyStart + length) break;
      const body = rest.subarray(bodyStart, bodyStart + length).toString("utf8");
      const message = JSON.parse(body) as unknown;
      if (typeof message === "object" && message !== null) messages.push(message as JsonObject);
      rest = rest.subarray(bodyStart + length);
      continue;
    }
    const newline = rest.indexOf(10);
    if (newline < 0) break;
    const line = rest.subarray(0, newline).toString("utf8").trim();
    rest = rest.subarray(newline + 1);
    if (line === "") continue;
    try {
      const message = JSON.parse(line) as unknown;
      if (typeof message === "object" && message !== null) messages.push(message as JsonObject);
    } catch {
      continue;
    }
  }
  return { messages, rest };
}

async function request(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: JsonObject): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP request timed out: ${method}`));
    }, requestTimeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      let parsed: { messages: JsonObject[]; rest: Buffer<ArrayBufferLike> };
      try {
        parsed = parseFrames(buffer);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      buffer = parsed.rest;
      for (const message of parsed.messages) {
        if (message.id !== id) continue;
        cleanup();
        if (typeof message.error === "object" && message.error !== null)
          reject(new Error(String((message.error as JsonObject).message ?? "MCP request failed")));
        else if (typeof message.result === "object" && message.result !== null) resolve(message.result as JsonObject);
        else reject(new Error("MCP server returned an invalid response"));
        return;
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null): void => {
      cleanup();
      reject(new Error(`MCP server exited before responding${code === null ? "" : ` (code ${code})`}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
    child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
  });
}

async function withServer<T>(command: string[], cwd: string, callback: (child: ChildProcessWithoutNullStreams) => Promise<T>): Promise<T> {
  validateCommand(command);
  const child = spawn(command[0]!, command.slice(1), { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  try {
    await request(child, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-harness", version: "0.1.2" } });
    child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
    return await callback(child);
  } catch (error) {
    if (error instanceof Error && stderr.trim() !== "") throw new Error(`${error.message}: ${stderr.trim()}`);
    throw error;
  } finally {
    child.stdin.end();
    child.kill();
  }
}

export default {
  name: "pi-mcp-client",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  async apply(context: Context, config: McpClientConfig) {
    type Latest = { server: string; tools: McpTool[]; resources: McpResource[]; prompts: McpPrompt[]; lastCall?: string };
    let latest: Latest | undefined;
    const servers = new Map<string, ManagedServer>();
    const configured = new Map<string, McpServerDefinition>();
    for (const definition of config.servers ?? []) {
      if (definition.id.trim() === "") throw new Error("Configured MCP server id cannot be empty");
      if (configured.has(definition.id)) throw new Error(`Configured MCP server id is duplicated: ${definition.id}`);
      validateCommand(definition.command);
      configured.set(definition.id, { id: definition.id, command: [...definition.command], autoStart: definition.autoStart === true });
    }
    let nextServerId = 1;
    const startServer = async (command: string[], requestedId?: string): Promise<ManagedServer> => {
      validateCommand(command);
      const id = requestedId ?? `mcp-${nextServerId++}`;
      if (servers.has(id)) throw new Error(`MCP server is already running: ${id}`);
      const child = spawn(command[0]!, command.slice(1), { cwd: context.piHarnessLaunch.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8_000);
      });
      const server: ManagedServer = {
        id,
        command: [...command],
        child,
        status: "running",
        nextRequestId: 2,
        queue: Promise.resolve(),
        startedAt: Date.now(),
      };
      child.once("close", () => {
        server.status = "stopping";
        servers.delete(server.id);
      });
      try {
        await request(child, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-harness", version: "0.1.2" } });
        child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
        servers.set(server.id, server);
        return server;
      } catch (error) {
        child.stdin.end();
        child.kill();
        if (error instanceof Error && stderr.trim() !== "") throw new Error(`${error.message}: ${stderr.trim()}`);
        throw error;
      }
    };
    const stopServer = async (serverId: string): Promise<boolean> => {
      const server = servers.get(serverId);
      if (server === undefined) throw new Error(`MCP server is not running: ${serverId}`);
      server.status = "stopping";
      await server.queue;
      servers.delete(server.id);
      server.child.stdin.end();
      server.child.kill();
      return true;
    };
    const requestManaged = (server: ManagedServer, method: string, params?: JsonObject): Promise<JsonObject> => {
      if (server.status !== "running") throw new Error(`MCP server is not running: ${server.id}`);
      const task = server.queue.then(() => request(server.child, server.nextRequestId++, method, params));
      server.queue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    };
    const getServer = (serverId: string): ManagedServer => {
      const server = servers.get(serverId);
      if (server === undefined) throw new Error(`MCP server is not running: ${serverId}`);
      return server;
    };
    const configuredCommand = (serverId: string): string[] => {
      const definition = configured.get(serverId);
      if (definition === undefined) throw new Error(`Configured MCP server is not found: ${serverId}`);
      return [...definition.command];
    };
    const list = async (command?: string[], serverId?: string): Promise<Latest> => {
      if (serverId !== undefined) {
        const managed = getServer(serverId);
        const result = await requestManaged(managed, "tools/list");
        const tools = Array.isArray(result.tools)
          ? result.tools.filter((tool): tool is McpTool => typeof tool === "object" && tool !== null && typeof (tool as JsonObject).name === "string")
          : [];
        latest = { server: managed.command.join(" "), tools, resources: latest?.resources ?? [], prompts: latest?.prompts ?? [] };
        return latest;
      }
      if (command === undefined) throw new Error("Provide command or serverId to list MCP tools");
      return withServer(command, context.piHarnessLaunch.cwd, async (child) => {
        const result = await request(child, 2, "tools/list");
        const tools = Array.isArray(result.tools)
          ? result.tools.filter((tool): tool is McpTool => typeof tool === "object" && tool !== null && typeof (tool as JsonObject).name === "string")
          : [];
        latest = { server: command.join(" "), tools, resources: latest?.resources ?? [], prompts: latest?.prompts ?? [] };
        return latest;
      });
    };
    const call = async (command: string[] | undefined, serverId: string | undefined, name: string, args: JsonObject): Promise<McpCallResult> => {
      if (serverId !== undefined) {
        const managed = getServer(serverId);
        const result = (await requestManaged(managed, "tools/call", { name, arguments: args })) as McpCallResult;
        latest = {
          server: managed.command.join(" "),
          tools: latest?.tools ?? [],
          resources: latest?.resources ?? [],
          prompts: latest?.prompts ?? [],
          lastCall: name,
        };
        return result;
      }
      if (command === undefined) throw new Error("Provide command or serverId to call an MCP tool");
      return withServer(command, context.piHarnessLaunch.cwd, async (child) => {
        const result = (await request(child, 2, "tools/call", { name, arguments: args })) as McpCallResult;
        latest = { server: command.join(" "), tools: latest?.tools ?? [], resources: latest?.resources ?? [], prompts: latest?.prompts ?? [], lastCall: name };
        return result;
      });
    };
    const requestOneShot = async (command: string[], method: string, params?: JsonObject): Promise<JsonObject> =>
      withServer(command, context.piHarnessLaunch.cwd, async (child) => request(child, 2, method, params));
    const requireCommand = (command: string[] | undefined, message: string): string[] => {
      if (command === undefined) throw new Error(message);
      return command;
    };
    const resources = async (command: string[] | undefined, serverId: string | undefined): Promise<McpResource[]> => {
      const result =
        serverId === undefined
          ? await requestOneShot(requireCommand(command, "Provide command or serverId to list MCP resources"), "resources/list")
          : await requestManaged(getServer(serverId), "resources/list");
      const items = Array.isArray(result.resources)
        ? result.resources.filter((item): item is McpResource => typeof item === "object" && item !== null && typeof (item as JsonObject).uri === "string")
        : [];
      latest = {
        server: serverId === undefined ? (command ?? []).join(" ") : getServer(serverId).command.join(" "),
        tools: latest?.tools ?? [],
        resources: items,
        prompts: latest?.prompts ?? [],
      };
      return items;
    };
    const readResource = async (command: string[] | undefined, serverId: string | undefined, uri: string): Promise<JsonObject> => {
      if (uri.length === 0 || uri.length > 4096) throw new Error("MCP resource URI must be between 1 and 4096 characters");
      return serverId === undefined
        ? requestOneShot(requireCommand(command, "Provide command or serverId to read an MCP resource"), "resources/read", { uri })
        : requestManaged(getServer(serverId), "resources/read", { uri });
    };
    const prompts = async (command: string[] | undefined, serverId: string | undefined): Promise<McpPrompt[]> => {
      const result =
        serverId === undefined
          ? await requestOneShot(requireCommand(command, "Provide command or serverId to list MCP prompts"), "prompts/list")
          : await requestManaged(getServer(serverId), "prompts/list");
      const items = Array.isArray(result.prompts)
        ? result.prompts.filter((item): item is McpPrompt => typeof item === "object" && item !== null && typeof (item as JsonObject).name === "string")
        : [];
      latest = {
        server: serverId === undefined ? (command ?? []).join(" ") : getServer(serverId).command.join(" "),
        tools: latest?.tools ?? [],
        resources: latest?.resources ?? [],
        prompts: items,
      };
      return items;
    };
    const getPrompt = async (command: string[] | undefined, serverId: string | undefined, name: string, args: JsonObject): Promise<JsonObject> => {
      if (name.length === 0 || name.length > 512) throw new Error("MCP prompt name must be between 1 and 512 characters");
      return serverId === undefined
        ? requestOneShot(requireCommand(command, "Provide command or serverId to get an MCP prompt"), "prompts/get", { name, arguments: args })
        : requestManaged(getServer(serverId), "prompts/get", { name, arguments: args });
    };
    const unregisterList = context.piTools.register(
      defineTool({
        name: "mcp_list_tools",
        label: "MCP list tools",
        description: "Start an MCP stdio server and list its available tools.",
        promptSnippet: "discover tools exposed by an MCP stdio server",
        parameters: Type.Object({
          command: Type.Optional(Type.Array(Type.String(), { description: "MCP server executable and arguments; shell wrappers are rejected" })),
          serverId: Type.Optional(Type.String({ description: "A configured or running MCP server id" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ server: string; tools: McpTool[] }>> {
          const result = await list(params.command, params.serverId);
          return {
            content: [
              { type: "text", text: result.tools.map((tool) => `${tool.name}: ${tool.description ?? ""}`).join("\n") || "MCP server returned no tools." },
            ],
            details: result,
          };
        },
      }),
    );
    const unregisterCall = context.piTools.register(
      defineTool({
        name: "mcp_call",
        label: "MCP call tool",
        description: "Call a named tool on an MCP stdio server with a JSON object of arguments.",
        promptSnippet: "call a tool exposed by an MCP stdio server",
        parameters: Type.Object({
          command: Type.Optional(Type.Array(Type.String())),
          serverId: Type.Optional(Type.String()),
          name: Type.String(),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Any())),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<McpCallResult>> {
          const result = await call(params.command, params.serverId, params.name, params.arguments ?? {});
          const content = Array.isArray(result.content) ? result.content : [{ type: "text", text: JSON.stringify(result) }];
          return { content: content as AgentToolResult<McpCallResult>["content"], details: result };
        },
      }),
    );
    const unregisterStart = context.piTools.register(
      defineTool({
        name: "mcp_server_start",
        label: "MCP server start",
        description: "Start and initialize a persistent MCP stdio server managed by Pi Harness.",
        promptSnippet: "start a persistent MCP stdio server",
        parameters: Type.Object({
          command: Type.Optional(Type.Array(Type.String(), { description: "MCP server executable and arguments; shell wrappers are rejected" })),
          serverId: Type.Optional(Type.String({ description: "Configured server id or a running server id" })),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ serverId: string; command: string[]; status: string }>> {
          const command = params.command ?? (params.serverId === undefined ? undefined : configuredCommand(params.serverId));
          if (command === undefined) throw new Error("Provide command or configured serverId to start an MCP server");
          const server = await startServer(command, params.serverId);
          return {
            content: [{ type: "text", text: `MCP server ${server.id} is running.` }],
            details: { serverId: server.id, command: server.command, status: server.status },
          };
        },
      }),
    );
    const unregisterStatus = context.piTools.register(
      defineTool({
        name: "mcp_server_status",
        label: "MCP server status",
        description: "List persistent MCP stdio servers managed by Pi Harness.",
        promptSnippet: "inspect running MCP server status",
        parameters: Type.Object({}),
        async execute(_toolCallId): Promise<AgentToolResult<{ servers: Array<{ id: string; command: string[]; status: string; startedAt: number }> }>> {
          const running = [...servers.values()].map((server) => ({
            id: server.id,
            command: server.command,
            status: server.status,
            startedAt: server.startedAt,
          }));
          const active = new Set(running.map((server) => server.id));
          const snapshot = [
            ...running,
            ...[...configured.values()]
              .filter((definition) => !active.has(definition.id))
              .map((definition) => ({ id: definition.id, command: definition.command, status: "stopped", startedAt: 0 })),
          ];
          return {
            content: [
              {
                type: "text",
                text:
                  snapshot.length === 0
                    ? "No MCP servers are running."
                    : snapshot.map((server) => `${server.id}: ${server.status} (${server.command.join(" ")})`).join("\n"),
              },
            ],
            details: { servers: snapshot },
          };
        },
      }),
    );
    const unregisterStop = context.piTools.register(
      defineTool({
        name: "mcp_server_stop",
        label: "MCP server stop",
        description: "Stop a persistent MCP stdio server and remove it from the managed set.",
        promptSnippet: "stop a persistent MCP stdio server",
        parameters: Type.Object({ serverId: Type.String() }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ serverId: string; stopped: boolean }>> {
          const stopped = await stopServer(params.serverId);
          return { content: [{ type: "text", text: `MCP server ${params.serverId} stopped.` }], details: { serverId: params.serverId, stopped } };
        },
      }),
    );
    const unregisterListResources = context.piTools.register(
      defineTool({
        name: "mcp_list_resources",
        label: "MCP list resources",
        description: "List resources exposed by an MCP server.",
        promptSnippet: "list resources exposed by an MCP server",
        parameters: Type.Object({ command: Type.Optional(Type.Array(Type.String())), serverId: Type.Optional(Type.String()) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ resources: McpResource[] }>> {
          const items = await resources(params.command, params.serverId);
          return {
            content: [{ type: "text", text: items.map((item) => `${item.uri} ${item.name ?? ""}`).join("\n") || "MCP server returned no resources." }],
            details: { resources: items },
          };
        },
      }),
    );
    const unregisterReadResource = context.piTools.register(
      defineTool({
        name: "mcp_read_resource",
        label: "MCP read resource",
        description: "Read one resource exposed by an MCP server.",
        promptSnippet: "read a resource exposed by an MCP server",
        parameters: Type.Object({ command: Type.Optional(Type.Array(Type.String())), serverId: Type.Optional(Type.String()), uri: Type.String() }),
        async execute(_toolCallId, params): Promise<AgentToolResult<JsonObject>> {
          const result = await readResource(params.command, params.serverId, params.uri);
          const contents = Array.isArray(result.contents) ? result.contents : [{ type: "text", text: JSON.stringify(result) }];
          return { content: contents as AgentToolResult<JsonObject>["content"], details: result };
        },
      }),
    );
    const unregisterListPrompts = context.piTools.register(
      defineTool({
        name: "mcp_list_prompts",
        label: "MCP list prompts",
        description: "List prompt templates exposed by an MCP server.",
        promptSnippet: "list prompt templates exposed by an MCP server",
        parameters: Type.Object({ command: Type.Optional(Type.Array(Type.String())), serverId: Type.Optional(Type.String()) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ prompts: McpPrompt[] }>> {
          const items = await prompts(params.command, params.serverId);
          return {
            content: [{ type: "text", text: items.map((item) => `${item.name}: ${item.description ?? ""}`).join("\n") || "MCP server returned no prompts." }],
            details: { prompts: items },
          };
        },
      }),
    );
    const unregisterGetPrompt = context.piTools.register(
      defineTool({
        name: "mcp_get_prompt",
        label: "MCP get prompt",
        description: "Render a prompt template exposed by an MCP server.",
        promptSnippet: "render a prompt template from an MCP server",
        parameters: Type.Object({
          command: Type.Optional(Type.Array(Type.String())),
          serverId: Type.Optional(Type.String()),
          name: Type.String(),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Any())),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<JsonObject>> {
          const result = await getPrompt(params.command, params.serverId, params.name, params.arguments ?? {});
          const content = Array.isArray(result.messages) ? result.messages : [{ type: "text", text: JSON.stringify(result) }];
          return { content: content as AgentToolResult<JsonObject>["content"], details: result };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "mcp-client-panel",
      pluginId: "@pi-harness/core/plugins/mcp-client",
      title: "MCP Client",
      description: "通过 stdio JSON-RPC 连接外部 MCP 工具服务器。",
      icon: "⌘",
      read: () => ({
        server: latest?.server ?? null,
        tools: latest?.tools ?? [],
        resources: latest?.resources ?? [],
        prompts: latest?.prompts ?? [],
        lastCall: latest?.lastCall ?? null,
        servers: [
          ...[...servers.values()].map((server) => ({ id: server.id, command: server.command, status: server.status, startedAt: server.startedAt })),
          ...[...configured.values()]
            .filter((definition) => !servers.has(definition.id))
            .map((definition) => ({ id: definition.id, command: definition.command, status: "stopped", startedAt: 0 })),
        ],
      }),
    });
    context.effect(() => () => {
      unregisterList();
      unregisterCall();
      unregisterStart();
      unregisterStatus();
      unregisterStop();
      unregisterListResources();
      unregisterReadResource();
      unregisterListPrompts();
      unregisterGetPrompt();
      for (const server of servers.values()) {
        server.status = "stopping";
        server.child.stdin.end();
        server.child.kill();
      }
      servers.clear();
      disposePanel();
    });
    for (const definition of configured.values()) {
      if (definition.autoStart === true) await startServer(definition.command, definition.id);
    }
  },
};
