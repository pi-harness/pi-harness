import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;
type McpTool = { name: string; description?: string; inputSchema?: unknown };
type McpCallResult = { content?: unknown[]; isError?: boolean } & JsonObject;

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
  apply(context: Context) {
    let latest: { server: string; tools: McpTool[]; lastCall?: string } | undefined;
    const list = async (command: string[]): Promise<{ server: string; tools: McpTool[] }> =>
      withServer(command, context.piHarnessLaunch.cwd, async (child) => {
        const result = await request(child, 2, "tools/list");
        const tools = Array.isArray(result.tools)
          ? result.tools.filter((tool): tool is McpTool => typeof tool === "object" && tool !== null && typeof (tool as JsonObject).name === "string")
          : [];
        latest = { server: command.join(" "), tools };
        return latest;
      });
    const call = async (command: string[], name: string, args: JsonObject): Promise<McpCallResult> =>
      withServer(command, context.piHarnessLaunch.cwd, async (child) => {
        const result = (await request(child, 2, "tools/call", { name, arguments: args })) as McpCallResult;
        latest = { server: command.join(" "), tools: latest?.tools ?? [], lastCall: name };
        return result;
      });
    const unregisterList = context.piTools.register(
      defineTool({
        name: "mcp_list_tools",
        label: "MCP list tools",
        description: "Start an MCP stdio server and list its available tools.",
        promptSnippet: "discover tools exposed by an MCP stdio server",
        parameters: Type.Object({ command: Type.Array(Type.String(), { description: "MCP server executable and arguments; shell wrappers are rejected" }) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ server: string; tools: McpTool[] }>> {
          const result = await list(params.command);
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
        parameters: Type.Object({ command: Type.Array(Type.String()), name: Type.String(), arguments: Type.Optional(Type.Record(Type.String(), Type.Any())) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<McpCallResult>> {
          const result = await call(params.command, params.name, params.arguments ?? {});
          const content = Array.isArray(result.content) ? result.content : [{ type: "text", text: JSON.stringify(result) }];
          return { content: content as AgentToolResult<McpCallResult>["content"], details: result };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "mcp-client-panel",
      pluginId: "@pi-harness/core/plugins/mcp-client",
      title: "MCP Client",
      description: "通过 stdio JSON-RPC 连接外部 MCP 工具服务器。",
      icon: "⌘",
      read: () => ({ server: latest?.server ?? null, tools: latest?.tools ?? [], lastCall: latest?.lastCall ?? null }),
    });
    context.effect(() => () => {
      unregisterList();
      unregisterCall();
      disposePanel();
    });
  },
};
