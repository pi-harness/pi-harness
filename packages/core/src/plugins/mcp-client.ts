import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import packageMetadata from "../../package.json" with { type: "json" };
import type { PiMcpServerSnapshot } from "../services.js";
import { assertKnownConfigKeys } from "../config.js";

type JsonObject = Record<string, unknown>;
type McpTool = { name: string; description?: string; inputSchema?: unknown };
type McpResource = { uri: string; name: string; description?: string; mimeType?: string };
type McpPrompt = { name: string; description?: string; arguments?: unknown[] };
type McpCallResult = { content?: unknown[]; isError?: boolean } & JsonObject;
type AgentContent = AgentToolResult<unknown>["content"][number];
type ManagedServer = {
  id: string;
  command: string[];
  child: ChildProcessWithoutNullStreams;
  status: "running" | "stopping";
  nextRequestId: number;
  queue: Promise<void>;
  startedAt: number;
  lifecycle: AbortController;
};
type PendingRequest = {
  receivedBytes: number;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
};
type StdioRouter = {
  buffer: Buffer<ArrayBufferLike>;
  pending: Map<number, PendingRequest>;
  terminalError?: Error;
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
const maxToolArgumentsBytes = 64 * 1024;
const maxToolArgumentDepth = 32;
const maxResponseBytes = 1024 * 1024;
const maxInventoryItems = 1000;
const maxPaginationPages = 100;
const maxManagedServers = 128;
const maxStderrBytes = 8192;
const requestTimeoutMs = 30_000;
const maxPanelItems = 20;
const clientVersion = packageMetadata.version;
const disposedMessage = "MCP client plugin disposed";
const connectionParameterNames = new Set(["command", "serverId"]);
const callParameterNames = new Set(["command", "serverId", "name", "arguments"]);
const stopParameterNames = new Set(["serverId"]);
const readResourceParameterNames = new Set(["command", "serverId", "uri"]);
const noParameterNames = new Set<string>();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeFrame(value: Buffer<ArrayBufferLike>): string {
  try {
    return utf8Decoder.decode(value);
  } catch (error) {
    throw new Error("MCP server response must contain valid UTF-8", { cause: error });
  }
}

function inspectParameters(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP parameters must be an object");
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("MCP parameters must be a plain object");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) throw new Error("MCP parameters contain an unknown property");
    if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("MCP parameters must use data properties");
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  } catch (error) {
    if (
      error instanceof Error &&
      /^(?:MCP parameters must be a plain object|MCP parameters contain an unknown property|MCP parameters must use data properties)$/u.test(error.message)
    )
      throw error;
    throw new Error("MCP parameters must be an accessible plain object", { cause: error });
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`MCP ${field} must be a string`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value, field);
  if (result === undefined) throw new Error(`MCP ${field} is required`);
  return result;
}

function serverIdValue(value: unknown, required = false): string | undefined {
  const result = optionalString(value, "serverId");
  if (result === undefined) {
    if (required) throw new Error("MCP serverId is required");
    return undefined;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/iu.test(result)) throw new Error("MCP serverId must use 1-64 letters, numbers, _ or -");
  return result;
}

function boundedInput(value: string, field: string, maximum: number): string {
  if (value.includes("\0")) throw new Error(`MCP ${field} must not contain NUL characters`);
  if (value.length === 0 || value.length > maximum) throw new Error(`MCP ${field} must contain 1-${maximum} characters`);
  return value;
}

function rejectAmbiguousTarget(command: string[] | undefined, serverId: string | undefined): void {
  if (command !== undefined && serverId !== undefined) throw new Error("Provide either command or serverId, not both");
}

function optionalCommand(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("MCP command must be an array of strings");
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const length: unknown = descriptors.length?.value as unknown;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) throw new Error("MCP command must be a dense array of string data properties");
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string")
      throw new Error("MCP command must be a dense array of string data properties");
    result.push(descriptor.value);
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/u.test(key))))
    throw new Error("MCP command contains an unknown property");
  return result;
}

function jsonObject(value: unknown): JsonObject {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP arguments must be a JSON object");
  const result = cloneJsonValue(value, new Set(), 0) as JsonObject;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxToolArgumentsBytes) throw new Error("MCP arguments cannot exceed 64 KiB");
  return result;
}

function promptArguments(value: unknown): JsonObject {
  const result = jsonObject(value);
  if (Object.values(result).some((item) => typeof item !== "string")) throw new Error("MCP prompt arguments must contain string values");
  return result;
}

function cloneJsonValue(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("MCP arguments must contain finite JSON numbers");
    return value;
  }
  if (typeof value !== "object") throw new Error("MCP arguments must contain only JSON values");
  if (depth > maxToolArgumentDepth) throw new Error(`MCP arguments cannot exceed ${maxToolArgumentDepth} levels of nesting`);
  if (ancestors.has(value)) throw new Error("MCP arguments must not contain circular references");
  ancestors.add(value);
  try {
    const descriptors: Record<PropertyKey, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("MCP arguments must use data properties");
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) throw new Error("MCP arguments cannot contain symbol properties");
    if (Array.isArray(value)) {
      const length: unknown = descriptors.length?.value as unknown;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) throw new Error("MCP argument arrays must be dense");
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) throw new Error("MCP argument arrays must be dense");
        result.push(cloneJsonValue(descriptor.value, ancestors, depth + 1));
      }
      if (Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9]\d*)$/u.test(key)))
        throw new Error("MCP argument arrays contain an unknown property");
      return result;
    }
    const result: JsonObject = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor.enumerable !== true) continue;
      result[key] = cloneJsonValue(descriptor.value, ancestors, depth + 1);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function executionSignal(signal: AbortSignal | undefined, lifecycle: AbortSignal): AbortSignal {
  return signal === undefined ? lifecycle : AbortSignal.any([signal, lifecycle]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function appendByteTail(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, maximum: number): Buffer<ArrayBufferLike> {
  const combined = Buffer.concat([current, chunk]);
  return combined.byteLength <= maximum ? combined : combined.subarray(combined.byteLength - maximum);
}

function toolInventory(value: unknown): McpTool[] {
  if (!Array.isArray(value)) throw new Error("MCP server returned an invalid MCP tools inventory");
  if (value.length > maxInventoryItems) throw new Error(`MCP remote inventory cannot exceed ${maxInventoryItems} items`);
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("MCP server returned an invalid MCP tool descriptor");
    const raw = item as JsonObject;
    if (typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 512 || raw.name.includes("\0"))
      throw new Error("MCP server returned an invalid MCP tool descriptor");
    if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 8192))
      throw new Error("MCP server returned an invalid MCP tool descriptor");
    if (raw.inputSchema === null || typeof raw.inputSchema !== "object" || Array.isArray(raw.inputSchema))
      throw new Error("MCP server returned an invalid MCP tool descriptor");
    return {
      name: raw.name,
      ...(raw.description === undefined ? {} : { description: raw.description }),
      inputSchema: clone(raw.inputSchema),
    };
  });
}

function resourceInventory(value: unknown): McpResource[] {
  if (!Array.isArray(value)) throw new Error("MCP server returned an invalid MCP resources inventory");
  if (value.length > maxInventoryItems) throw new Error(`MCP remote inventory cannot exceed ${maxInventoryItems} items`);
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("MCP server returned an invalid MCP resource descriptor");
    const raw = item as JsonObject;
    if (typeof raw.uri !== "string" || raw.uri.length === 0 || raw.uri.length > 4096 || raw.uri.includes("\0"))
      throw new Error("MCP server returned an invalid MCP resource descriptor");
    if (typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 512 || raw.name.includes("\0"))
      throw new Error("MCP server returned an invalid MCP resource descriptor");
    if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 8192))
      throw new Error("MCP server returned an invalid MCP resource descriptor");
    if (raw.mimeType !== undefined && (typeof raw.mimeType !== "string" || raw.mimeType.length > 256))
      throw new Error("MCP server returned an invalid MCP resource descriptor");
    return {
      uri: raw.uri,
      name: raw.name,
      ...(raw.description === undefined ? {} : { description: raw.description }),
      ...(raw.mimeType === undefined ? {} : { mimeType: raw.mimeType }),
    };
  });
}

function promptInventory(value: unknown): McpPrompt[] {
  if (!Array.isArray(value)) throw new Error("MCP server returned an invalid MCP prompts inventory");
  if (value.length > maxInventoryItems) throw new Error(`MCP remote inventory cannot exceed ${maxInventoryItems} items`);
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("MCP server returned an invalid MCP prompt descriptor");
    const raw = item as JsonObject;
    if (typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 512 || raw.name.includes("\0"))
      throw new Error("MCP server returned an invalid MCP prompt descriptor");
    if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > 8192))
      throw new Error("MCP server returned an invalid MCP prompt descriptor");
    if (raw.arguments !== undefined && !Array.isArray(raw.arguments)) throw new Error("MCP server returned an invalid MCP prompt descriptor");
    if (Array.isArray(raw.arguments) && raw.arguments.length > 128) throw new Error("MCP server returned an invalid MCP prompt descriptor");
    const argumentsValue = Array.isArray(raw.arguments)
      ? raw.arguments.map((argument) => {
          if (argument === null || typeof argument !== "object" || Array.isArray(argument))
            throw new Error("MCP server returned an invalid MCP prompt descriptor");
          const candidate = argument as JsonObject;
          if (typeof candidate.name !== "string" || candidate.name.length === 0 || candidate.name.length > 512)
            throw new Error("MCP server returned an invalid MCP prompt descriptor");
          if (candidate.description !== undefined && (typeof candidate.description !== "string" || candidate.description.length > 8192))
            throw new Error("MCP server returned an invalid MCP prompt descriptor");
          if (candidate.required !== undefined && typeof candidate.required !== "boolean")
            throw new Error("MCP server returned an invalid MCP prompt descriptor");
          return {
            name: candidate.name,
            ...(candidate.description === undefined ? {} : { description: candidate.description }),
            ...(candidate.required === undefined ? {} : { required: candidate.required }),
          };
        })
      : undefined;
    return {
      name: raw.name,
      ...(raw.description === undefined ? {} : { description: raw.description }),
      ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
    };
  });
}

function paginationCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0"))
    throw new Error("MCP server returned an invalid pagination cursor");
  return value;
}

async function paginatedInventory<T>(
  method: string,
  field: string,
  requestPage: (params?: JsonObject) => Promise<JsonObject>,
  validate: (value: unknown) => T[],
): Promise<T[]> {
  const result: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPaginationPages; page += 1) {
    const response = await requestPage(cursor === undefined ? undefined : { cursor });
    const pageItems = validate(response[field]);
    if (result.length + pageItems.length > maxInventoryItems) throw new Error(`MCP remote inventory cannot exceed ${maxInventoryItems} items`);
    result.push(...pageItems);
    const nextCursor = paginationCursor(response.nextCursor);
    if (nextCursor === undefined) return result;
    if (seenCursors.has(nextCursor)) throw new Error(`MCP server repeated a pagination cursor for ${method}`);
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error(`MCP ${method} pagination cannot exceed ${maxPaginationPages} pages`);
}

function requiredRemoteString(value: unknown, message: string, maximum = maxResponseBytes): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) throw new Error(message);
  return value;
}

function base64RemoteString(value: unknown, message: string): string {
  const result = requiredRemoteString(value, message);
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}(?:==)?|[A-Za-z\d+/]{3}=?)?$/u.test(result)) throw new Error(message);
  return result;
}

function toolResultContent(result: McpCallResult): AgentContent[] {
  if (!Array.isArray(result.content) || result.content.length > maxInventoryItems) throw new Error("MCP server returned invalid MCP tool result content");
  if (result.isError !== undefined && typeof result.isError !== "boolean") throw new Error("MCP server returned invalid MCP tool result content");
  return result.content.map((item): AgentContent => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("MCP server returned invalid MCP tool result content");
    const raw = item as JsonObject;
    if (raw.type === "text") {
      return { type: "text", text: requiredRemoteString(raw.text, "MCP server returned invalid MCP tool result content") };
    }
    if (raw.type === "image") {
      const data = base64RemoteString(raw.data, "MCP server returned invalid MCP tool result content");
      const mimeType = requiredRemoteString(raw.mimeType, "MCP server returned invalid MCP tool result content", 256);
      if (!mimeType.startsWith("image/")) throw new Error("MCP server returned invalid MCP tool result content");
      return { type: "image", data, mimeType };
    }
    if (raw.type === "audio") {
      const mimeType = requiredRemoteString(raw.mimeType, "MCP server returned invalid MCP tool result content", 256);
      base64RemoteString(raw.data, "MCP server returned invalid MCP tool result content");
      return { type: "text", text: `[MCP audio content omitted: ${mimeType}]` };
    }
    if (raw.type === "resource") {
      if (raw.resource === null || typeof raw.resource !== "object" || Array.isArray(raw.resource))
        throw new Error("MCP server returned invalid MCP tool result content");
      const resource = raw.resource as JsonObject;
      const uri = requiredRemoteString(resource.uri, "MCP server returned invalid MCP tool result content", 4096);
      if (typeof resource.text === "string") return { type: "text", text: resource.text };
      if (typeof resource.blob === "string") {
        const blob = base64RemoteString(resource.blob, "MCP server returned invalid MCP tool result content");
        const mimeType =
          resource.mimeType === undefined ? undefined : requiredRemoteString(resource.mimeType, "MCP server returned invalid MCP tool result content", 256);
        return mimeType?.startsWith("image/") === true
          ? { type: "image", data: blob, mimeType }
          : { type: "text", text: `[MCP binary resource omitted: ${uri} (${mimeType ?? "unknown MIME type"})]` };
      }
      throw new Error("MCP server returned invalid MCP tool result content");
    }
    if (raw.type === "resource_link") {
      const uri = requiredRemoteString(raw.uri, "MCP server returned invalid MCP tool result content", 4096);
      const name = raw.name === undefined ? uri : requiredRemoteString(raw.name, "MCP server returned invalid MCP tool result content", 512);
      return { type: "text", text: `[MCP resource: ${name} — ${uri}]` };
    }
    throw new Error("MCP server returned invalid MCP tool result content");
  });
}

function validateInitializeResult(result: JsonObject): void {
  if (
    result.protocolVersion !== "2025-06-18" ||
    result.capabilities === null ||
    typeof result.capabilities !== "object" ||
    Array.isArray(result.capabilities) ||
    result.serverInfo === null ||
    typeof result.serverInfo !== "object" ||
    Array.isArray(result.serverInfo)
  )
    throw new Error("MCP server returned an invalid MCP initialize result");
  const serverInfo = result.serverInfo as JsonObject;
  if (
    typeof serverInfo.name !== "string" ||
    serverInfo.name.length === 0 ||
    serverInfo.name.length > 512 ||
    typeof serverInfo.version !== "string" ||
    serverInfo.version.length === 0 ||
    serverInfo.version.length > 512 ||
    (result.instructions !== undefined && (typeof result.instructions !== "string" || result.instructions.length > 65_536))
  )
    throw new Error("MCP server returned an invalid MCP initialize result");
}

function resourceResultContent(result: JsonObject): AgentContent[] {
  if (!Array.isArray(result.contents) || result.contents.length > maxInventoryItems) throw new Error("MCP server returned invalid MCP resource contents");
  return result.contents.map((item): AgentContent => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("MCP server returned invalid MCP resource contents");
    const raw = item as JsonObject;
    const uri = requiredRemoteString(raw.uri, "MCP server returned invalid MCP resource contents", 4096);
    if (typeof raw.text === "string") return { type: "text", text: raw.text };
    if (typeof raw.blob === "string") {
      const blob = base64RemoteString(raw.blob, "MCP server returned invalid MCP resource contents");
      const mimeType = raw.mimeType === undefined ? undefined : requiredRemoteString(raw.mimeType, "MCP server returned invalid MCP resource contents", 256);
      return mimeType?.startsWith("image/") === true
        ? { type: "image", data: blob, mimeType }
        : { type: "text", text: `[MCP binary resource omitted: ${uri} (${mimeType ?? "unknown MIME type"})]` };
    }
    throw new Error("MCP server returned invalid MCP resource contents");
  });
}

function promptResultContent(result: JsonObject): AgentContent[] {
  if (result.description !== undefined && (typeof result.description !== "string" || result.description.length > 8192))
    throw new Error("MCP server returned invalid MCP prompt messages");
  if (!Array.isArray(result.messages) || result.messages.length > maxInventoryItems) throw new Error("MCP server returned invalid MCP prompt messages");
  return result.messages.flatMap((item): AgentContent[] => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("MCP server returned invalid MCP prompt messages");
    const raw = item as JsonObject;
    const role = raw.role;
    if (role !== "user" && role !== "assistant") throw new Error("MCP server returned invalid MCP prompt messages");
    const normalized = toolResultContent({ content: [raw.content] });
    return normalized.flatMap((content): AgentContent[] =>
      content.type === "text" ? [{ type: "text", text: `[${role}]\n${content.text}` }] : [{ type: "text", text: `[${role}]` }, content],
    );
  });
}

function validateCommand(command: string[]): void {
  if (command.length === 0) throw new Error("MCP server command cannot be empty");
  if (command.length > maxCommandArgs) throw new Error(`MCP server command cannot exceed ${maxCommandArgs} arguments`);
  if (command.some((part) => part.includes("\0"))) throw new Error("MCP server command arguments must not contain NUL characters");
  if (command.some((part) => part.length === 0 || Buffer.byteLength(part) > maxArgumentBytes))
    throw new Error("MCP server command contains an invalid argument");
  const executable = executableName(command)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/u, "");
  if (shellCommands.has(executable)) throw new Error("MCP shell wrappers are not allowed; pass an executable argv directly");
}

function executableName(command: readonly string[]): string {
  return (command[0] ?? "").replaceAll("\\", "/").split("/").pop() ?? "";
}

function serverLabel(command: readonly string[]): string {
  const count = Math.max(0, command.length - 1);
  return `${executableName(command)}${count === 0 ? "" : ` (+${count} ${count === 1 ? "arg" : "args"})`}`;
}

function encodeMessage(message: JsonObject): Buffer<ArrayBufferLike> {
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

function waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    child.once("close", onClose);
  });
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildClose(child, 250)) return;
  child.kill("SIGKILL");
  await waitForChildClose(child, 500);
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
      if (!Number.isSafeInteger(length) || length > maxResponseBytes) throw new Error("MCP server response exceeded the 1 MiB limit");
      const bodyStart = separator + 4;
      if (rest.length < bodyStart + length) break;
      const body = decodeFrame(rest.subarray(bodyStart, bodyStart + length));
      const message = JSON.parse(body) as unknown;
      if (typeof message === "object" && message !== null) messages.push(message as JsonObject);
      rest = rest.subarray(bodyStart + length);
      continue;
    }
    const newline = rest.indexOf(10);
    if (newline < 0) break;
    const line = decodeFrame(rest.subarray(0, newline)).trim();
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

function cancellationError(method: string, reason: unknown): Error {
  if (reason instanceof Error && reason.message === disposedMessage) return reason;
  return new Error(`MCP request was cancelled: ${method}${reason instanceof Error ? ` (${reason.message})` : ""}`, { cause: reason });
}

function withCancellation<T>(operation: Promise<T>, signal: AbortSignal | undefined, method: string): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(cancellationError(method, signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(cancellationError(method, signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("MCP operation failed", { cause: error }));
      },
    );
  });
}

const stdioRouters = new WeakMap<ChildProcessWithoutNullStreams, StdioRouter>();

function responseResult(message: JsonObject): JsonObject {
  const hasError = Object.hasOwn(message, "error");
  const hasResult = Object.hasOwn(message, "result");
  if (message.jsonrpc !== "2.0" || hasError === hasResult) throw new Error("MCP server returned an invalid JSON-RPC response");
  if (hasError) {
    if (typeof message.error !== "object" || message.error === null || Array.isArray(message.error))
      throw new Error("MCP server returned an invalid JSON-RPC response");
    const errorMessage = (message.error as JsonObject).message;
    const errorCode = (message.error as JsonObject).code;
    if (typeof errorMessage !== "string" || typeof errorCode !== "number" || !Number.isInteger(errorCode))
      throw new Error("MCP server returned an invalid JSON-RPC response");
    throw new Error(errorMessage);
  }
  if (typeof message.result !== "object" || message.result === null || Array.isArray(message.result))
    throw new Error("MCP server returned an invalid response");
  return message.result as JsonObject;
}

function stdioRouter(child: ChildProcessWithoutNullStreams): StdioRouter {
  const existing = stdioRouters.get(child);
  if (existing !== undefined) return existing;
  const router: StdioRouter = { buffer: Buffer.alloc(0), pending: new Map() };
  const fail = (error: Error): void => {
    if (router.terminalError !== undefined) return;
    router.terminalError = error;
    router.buffer = Buffer.alloc(0);
    child.stdout.off("data", onData);
    child.off("error", onError);
    child.off("close", onClose);
    for (const request of [...router.pending.values()]) request.reject(error);
  };
  const onData = (chunk: Buffer): void => {
    for (const request of [...router.pending.values()]) {
      request.receivedBytes += chunk.byteLength;
      if (request.receivedBytes > maxResponseBytes) request.reject(new Error("MCP server response exceeded the 1 MiB limit"));
    }
    if (router.buffer.byteLength + chunk.byteLength > maxResponseBytes) {
      fail(new Error("MCP server response exceeded the 1 MiB limit"));
      return;
    }
    const buffer = router.buffer.byteLength === 0 ? chunk : Buffer.concat([router.buffer, chunk]);
    let parsed: { messages: JsonObject[]; rest: Buffer<ArrayBufferLike> };
    try {
      parsed = parseFrames(buffer);
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Failed to parse MCP response", { cause: error }));
      return;
    }
    router.buffer = parsed.rest.byteLength === 0 ? Buffer.alloc(0) : Buffer.from(parsed.rest);
    for (const message of parsed.messages) {
      if (typeof message.id !== "number") continue;
      const request = router.pending.get(message.id);
      if (request === undefined) continue;
      try {
        request.resolve(responseResult(message));
      } catch (error) {
        request.reject(error instanceof Error ? error : new Error("Failed to validate MCP response", { cause: error }));
      }
    }
  };
  const onError = (error: Error): void => fail(error);
  const onClose = (code: number | null): void => fail(new Error(`MCP server exited before responding${code === null ? "" : ` (code ${code})`}`));
  child.stdout.on("data", onData);
  child.once("error", onError);
  child.once("close", onClose);
  stdioRouters.set(child, router);
  return router;
}

async function request(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
  if (signal?.aborted === true) throw cancellationError(method, signal.reason);
  return new Promise((resolve, reject) => {
    const router = stdioRouter(child);
    if (router.terminalError !== undefined) {
      reject(router.terminalError);
      return;
    }
    if (router.pending.has(id)) {
      reject(new Error(`MCP request id is already pending: ${id}`));
      return;
    }
    let settled = false;
    let sent = false;
    const sendCancellation = (reason: string): void => {
      if (!sent || method === "initialize" || child.stdin.destroyed || child.stdin.writableEnded) return;
      try {
        child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } }), () => undefined);
      } catch {
        // The original timeout or cancellation remains the actionable error.
      }
    };
    const timer = setTimeout(() => {
      sendCancellation(`MCP request timed out: ${method}`);
      rejectRequest(new Error(`MCP request timed out: ${method}`));
    }, requestTimeoutMs);
    timer.unref();
    const onAbort = (): void => {
      sendCancellation(signal?.reason instanceof Error ? signal.reason.message : "MCP client request cancelled");
      rejectRequest(cancellationError(method, signal?.reason));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      router.pending.delete(id);
      signal?.removeEventListener("abort", onAbort);
    };
    const resolveRequest = (value: JsonObject): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectRequest = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    router.pending.set(id, { receivedBytes: 0, resolve: resolveRequest, reject: rejectRequest });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }), (error) => {
        if (error === null || error === undefined) return;
        rejectRequest(error);
      });
      sent = true;
    } catch (error) {
      rejectRequest(error instanceof Error ? error : new Error("Failed to write MCP request", { cause: error }));
    }
  });
}

async function withServer<T>(
  command: string[],
  cwd: string,
  callback: (child: ChildProcessWithoutNullStreams) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  validateCommand(command);
  if (signal?.aborted === true) throw cancellationError("initialize", signal.reason);
  const child = spawn(command[0]!, command.slice(1), { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendByteTail(stderr, chunk, maxStderrBytes);
  });
  try {
    const initializeResult = await request(
      child,
      1,
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-harness", version: clientVersion } },
      signal,
    );
    validateInitializeResult(initializeResult);
    child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
    return await callback(child);
  } catch (error) {
    if (error instanceof Error && error.message === disposedMessage) throw error;
    const stderrText = stderr.toString("utf8").trim();
    if (error instanceof Error && stderrText !== "") throw new Error(`${error.message}: ${stderrText}`, { cause: error });
    throw error;
  } finally {
    await terminateChild(child);
  }
}

export default {
  name: "pi-mcp-client",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  async apply(context: Context, config: McpClientConfig) {
    assertKnownConfigKeys("pi-mcp-client", config, ["servers"]);
    type Latest = { server: string; tools: McpTool[]; resources: McpResource[]; prompts: McpPrompt[]; lastCall?: string };
    const lifecycle = new AbortController();
    let latest: Latest | undefined;
    let latestKey: string | undefined;
    const previousFor = (key: string): Latest | undefined => (latestKey === key ? latest : undefined);
    const publishLatest = (key: string, value: Latest): Latest => {
      latestKey = key;
      latest = clone(value);
      return clone(value);
    };
    const servers = new Map<string, ManagedServer>();
    const startingServers = new Set<string>();
    const unregisters: Array<() => void> = [];
    const registerTool = (definition: Parameters<typeof context.piTools.register>[0]): (() => void) => {
      try {
        const unregister = context.piTools.register(definition);
        unregisters.push(unregister);
        return unregister;
      } catch (error) {
        for (const unregister of unregisters.splice(0).reverse()) unregister();
        lifecycle.abort(new Error("MCP client plugin activation failed", { cause: error }));
        throw error;
      }
    };
    const configured = new Map<string, McpServerDefinition>();
    const definitions = config.servers ?? [];
    if (definitions.length > maxManagedServers) throw new Error(`MCP configured inventory cannot exceed ${maxManagedServers} servers`);
    for (const definition of definitions) {
      const id = serverIdValue(definition.id, true)!;
      if (configured.has(id)) throw new Error(`Configured MCP server id is duplicated: ${id}`);
      validateCommand(definition.command);
      configured.set(id, { id, command: [...definition.command], autoStart: definition.autoStart === true });
    }
    let nextServerId = 1;
    const startServer = async (command: string[], requestedId?: string, signal?: AbortSignal): Promise<ManagedServer> => {
      validateCommand(command);
      let id = requestedId;
      if (id === undefined) {
        do id = `mcp-${nextServerId++}`;
        while (configured.has(id) || servers.has(id) || startingServers.has(id));
      }
      if (servers.has(id)) throw new Error(`MCP server is already running: ${id}`);
      if (startingServers.has(id)) throw new Error(`MCP server is already starting: ${id}`);
      if (servers.size + startingServers.size >= maxManagedServers) throw new Error(`MCP client cannot manage more than ${maxManagedServers} running servers`);
      startingServers.add(id);
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command[0]!, command.slice(1), { cwd: context.piHarnessLaunch.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        startingServers.delete(id);
        throw error;
      }
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendByteTail(stderr, chunk, maxStderrBytes);
      });
      const server: ManagedServer = {
        id,
        command: [...command],
        child,
        status: "running",
        nextRequestId: 2,
        queue: Promise.resolve(),
        startedAt: Date.now(),
        lifecycle: new AbortController(),
      };
      child.once("close", () => {
        server.status = "stopping";
        server.lifecycle.abort(new Error(`MCP server exited: ${server.id}`));
        servers.delete(server.id);
      });
      try {
        const initializeResult = await request(
          child,
          1,
          "initialize",
          { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-harness", version: clientVersion } },
          signal,
        );
        validateInitializeResult(initializeResult);
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`MCP server exited during initialization: ${id}`);
        servers.set(server.id, server);
        child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
        return server;
      } catch (error) {
        servers.delete(server.id);
        await terminateChild(child);
        if (error instanceof Error && error.message === disposedMessage) throw error;
        const stderrText = stderr.toString("utf8").trim();
        if (error instanceof Error && stderrText !== "") throw new Error(`${error.message}: ${stderrText}`, { cause: error });
        throw error;
      } finally {
        startingServers.delete(id);
      }
    };
    const stopServer = (serverId: string, signal?: AbortSignal): Promise<boolean> => {
      const server = servers.get(serverId);
      if (server === undefined) throw new Error(`MCP server is not running: ${serverId}`);
      server.status = "stopping";
      server.lifecycle.abort(new Error(`MCP server stopped: ${server.id}`));
      const operation = (async () => {
        await server.queue;
        servers.delete(server.id);
        await terminateChild(server.child);
        return true;
      })();
      return withCancellation(operation, signal, "server/stop");
    };
    const requestManaged = (server: ManagedServer, method: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonObject> => {
      if (server.status !== "running") throw new Error(`MCP server is not running: ${server.id}`);
      const requestSignal = signal === undefined ? server.lifecycle.signal : AbortSignal.any([signal, server.lifecycle.signal]);
      const task = server.queue.then(() => request(server.child, server.nextRequestId++, method, params, requestSignal));
      server.queue = task.then(
        () => undefined,
        () => undefined,
      );
      return withCancellation(task, requestSignal, method);
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
    const statusSnapshot = () => {
      const running = [...servers.values()].map((server) => ({
        id: server.id,
        executable: executableName(server.command),
        argumentCount: Math.max(0, server.command.length - 1),
        status: server.status,
        startedAt: server.startedAt,
      }));
      const active = new Set(running.map((server) => server.id));
      return [
        ...running,
        ...[...configured.values()]
          .filter((definition) => !active.has(definition.id))
          .map((definition) => ({
            id: definition.id,
            executable: executableName(definition.command),
            argumentCount: Math.max(0, definition.command.length - 1),
            status: "stopped",
            startedAt: 0,
          })),
      ];
    };
    const list = async (command?: string[], serverId?: string, signal?: AbortSignal): Promise<Latest> => {
      rejectAmbiguousTarget(command, serverId);
      if (serverId !== undefined) {
        const managed = getServer(serverId);
        const tools = await paginatedInventory("tools/list", "tools", (params) => requestManaged(managed, "tools/list", params, signal), toolInventory);
        const key = `managed:${managed.id}`;
        const server = serverLabel(managed.command);
        const previous = previousFor(key);
        const next = { server, tools, resources: previous?.resources ?? [], prompts: previous?.prompts ?? [] };
        return publishLatest(key, next);
      }
      if (command === undefined) throw new Error("Provide command or serverId to list MCP tools");
      return withServer(
        command,
        context.piHarnessLaunch.cwd,
        async (child) => {
          let requestId = 2;
          const tools = await paginatedInventory("tools/list", "tools", (params) => request(child, requestId++, "tools/list", params, signal), toolInventory);
          const key = `command:${JSON.stringify(command)}`;
          const server = serverLabel(command);
          const previous = previousFor(key);
          const next = { server, tools, resources: previous?.resources ?? [], prompts: previous?.prompts ?? [] };
          return publishLatest(key, next);
        },
        signal,
      );
    };
    const call = async (
      command: string[] | undefined,
      serverId: string | undefined,
      name: string,
      args: JsonObject,
      signal?: AbortSignal,
    ): Promise<McpCallResult> => {
      rejectAmbiguousTarget(command, serverId);
      boundedInput(name, "tool name", 512);
      if (serverId !== undefined) {
        const managed = getServer(serverId);
        const result = (await requestManaged(managed, "tools/call", { name, arguments: args }, signal)) as McpCallResult;
        toolResultContent(result);
        const key = `managed:${managed.id}`;
        const server = serverLabel(managed.command);
        const previous = previousFor(key);
        publishLatest(key, {
          server,
          tools: previous?.tools ?? [],
          resources: previous?.resources ?? [],
          prompts: previous?.prompts ?? [],
          lastCall: name,
        });
        return result;
      }
      if (command === undefined) throw new Error("Provide command or serverId to call an MCP tool");
      return withServer(
        command,
        context.piHarnessLaunch.cwd,
        async (child) => {
          const result = (await request(child, 2, "tools/call", { name, arguments: args }, signal)) as McpCallResult;
          toolResultContent(result);
          const key = `command:${JSON.stringify(command)}`;
          const server = serverLabel(command);
          const previous = previousFor(key);
          publishLatest(key, {
            server,
            tools: previous?.tools ?? [],
            resources: previous?.resources ?? [],
            prompts: previous?.prompts ?? [],
            lastCall: name,
          });
          return result;
        },
        signal,
      );
    };
    const requestOneShot = async (command: string[], method: string, params?: JsonObject, signal?: AbortSignal): Promise<JsonObject> =>
      withServer(command, context.piHarnessLaunch.cwd, async (child) => request(child, 2, method, params, signal), signal);
    const requireCommand = (command: string[] | undefined, message: string): string[] => {
      if (command === undefined) throw new Error(message);
      return command;
    };
    const resources = async (command: string[] | undefined, serverId: string | undefined, signal?: AbortSignal): Promise<McpResource[]> => {
      rejectAmbiguousTarget(command, serverId);
      let items: McpResource[];
      let selectedCommand: string[];
      if (serverId === undefined) {
        selectedCommand = requireCommand(command, "Provide command or serverId to list MCP resources");
        items = await withServer(
          selectedCommand,
          context.piHarnessLaunch.cwd,
          async (child) => {
            let requestId = 2;
            return paginatedInventory(
              "resources/list",
              "resources",
              (params) => request(child, requestId++, "resources/list", params, signal),
              resourceInventory,
            );
          },
          signal,
        );
      } else {
        const managed = getServer(serverId);
        selectedCommand = managed.command;
        items = await paginatedInventory(
          "resources/list",
          "resources",
          (params) => requestManaged(managed, "resources/list", params, signal),
          resourceInventory,
        );
      }
      const key = serverId === undefined ? `command:${JSON.stringify(selectedCommand)}` : `managed:${serverId}`;
      const server = serverLabel(selectedCommand);
      const previous = previousFor(key);
      const next = {
        server,
        tools: previous?.tools ?? [],
        resources: items,
        prompts: previous?.prompts ?? [],
      };
      publishLatest(key, next);
      return clone(items);
    };
    const readResource = async (command: string[] | undefined, serverId: string | undefined, uri: string, signal?: AbortSignal): Promise<JsonObject> => {
      rejectAmbiguousTarget(command, serverId);
      boundedInput(uri, "resource URI", 4096);
      return serverId === undefined
        ? requestOneShot(requireCommand(command, "Provide command or serverId to read an MCP resource"), "resources/read", { uri }, signal)
        : requestManaged(getServer(serverId), "resources/read", { uri }, signal);
    };
    const prompts = async (command: string[] | undefined, serverId: string | undefined, signal?: AbortSignal): Promise<McpPrompt[]> => {
      rejectAmbiguousTarget(command, serverId);
      let items: McpPrompt[];
      let selectedCommand: string[];
      if (serverId === undefined) {
        selectedCommand = requireCommand(command, "Provide command or serverId to list MCP prompts");
        items = await withServer(
          selectedCommand,
          context.piHarnessLaunch.cwd,
          async (child) => {
            let requestId = 2;
            return paginatedInventory("prompts/list", "prompts", (params) => request(child, requestId++, "prompts/list", params, signal), promptInventory);
          },
          signal,
        );
      } else {
        const managed = getServer(serverId);
        selectedCommand = managed.command;
        items = await paginatedInventory("prompts/list", "prompts", (params) => requestManaged(managed, "prompts/list", params, signal), promptInventory);
      }
      const key = serverId === undefined ? `command:${JSON.stringify(selectedCommand)}` : `managed:${serverId}`;
      const server = serverLabel(selectedCommand);
      const previous = previousFor(key);
      const next = {
        server,
        tools: previous?.tools ?? [],
        resources: previous?.resources ?? [],
        prompts: items,
      };
      publishLatest(key, next);
      return clone(items);
    };
    const getPrompt = async (
      command: string[] | undefined,
      serverId: string | undefined,
      name: string,
      args: JsonObject,
      signal?: AbortSignal,
    ): Promise<JsonObject> => {
      rejectAmbiguousTarget(command, serverId);
      boundedInput(name, "prompt name", 512);
      return serverId === undefined
        ? requestOneShot(requireCommand(command, "Provide command or serverId to get an MCP prompt"), "prompts/get", { name, arguments: args }, signal)
        : requestManaged(getServer(serverId), "prompts/get", { name, arguments: args }, signal);
    };
    const unregisterList = registerTool(
      defineTool({
        name: "mcp_list_tools",
        label: "MCP list tools",
        description: "Start an MCP stdio server and list its available tools.",
        promptSnippet: "discover tools exposed by an MCP stdio server",
        parameters: Type.Object(
          {
            command: Type.Optional(Type.Array(Type.String(), { description: "MCP server executable and arguments; shell wrappers are rejected" })),
            serverId: Type.Optional(Type.String({ description: "A configured or running MCP server id" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ server: string; tools: McpTool[] }>> {
          const operationSignal = executionSignal(signal, lifecycle.signal);
          operationSignal.throwIfAborted();
          const raw = inspectParameters(params, connectionParameterNames);
          const result = await list(optionalCommand(raw.command), serverIdValue(raw.serverId), operationSignal);
          return {
            content: [
              { type: "text", text: result.tools.map((tool) => `${tool.name}: ${tool.description ?? ""}`).join("\n") || "MCP server returned no tools." },
            ],
            details: result,
          };
        },
      }),
    );
    const unregisterCall = registerTool(
      defineTool({
        name: "mcp_call",
        label: "MCP call tool",
        description: "Call a named tool on an MCP stdio server with a JSON object of arguments.",
        promptSnippet: "call a tool exposed by an MCP stdio server",
        parameters: Type.Object(
          {
            command: Type.Optional(Type.Array(Type.String())),
            serverId: Type.Optional(Type.String()),
            name: Type.String(),
            arguments: Type.Optional(Type.Record(Type.String(), Type.Any())),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<McpCallResult>> {
          const operationSignal = executionSignal(signal, lifecycle.signal);
          operationSignal.throwIfAborted();
          const raw = inspectParameters(params, callParameterNames);
          const result = await call(
            optionalCommand(raw.command),
            serverIdValue(raw.serverId),
            requiredString(raw.name, "tool name"),
            jsonObject(raw.arguments),
            operationSignal,
          );
          return { content: toolResultContent(result), details: clone(result) };
        },
      }),
    );
    const unregisterStart = registerTool(
      defineTool({
        name: "mcp_server_start",
        label: "MCP server start",
        description: "Start and initialize a persistent MCP stdio server managed by Pi Harness.",
        promptSnippet: "start a persistent MCP stdio server",
        parameters: Type.Object(
          {
            command: Type.Optional(Type.Array(Type.String(), { description: "MCP server executable and arguments; shell wrappers are rejected" })),
            serverId: Type.Optional(Type.String({ description: "Configured server id or a running server id" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ serverId: string; command: string[]; status: string }>> {
          const operationSignal = executionSignal(signal, lifecycle.signal);
          operationSignal.throwIfAborted();
          const raw = inspectParameters(params, connectionParameterNames);
          const serverId = serverIdValue(raw.serverId);
          const command = optionalCommand(raw.command) ?? (serverId === undefined ? undefined : configuredCommand(serverId));
          if (command === undefined) throw new Error("Provide command or configured serverId to start an MCP server");
          const server = await startServer(command, serverId, operationSignal);
          return {
            content: [{ type: "text", text: `MCP server ${server.id} is running.` }],
            details: { serverId: server.id, command: [...server.command], status: server.status },
          };
        },
      }),
    );
    const unregisterStatus = registerTool(
      defineTool({
        name: "mcp_server_status",
        label: "MCP server status",
        description: "List persistent MCP stdio servers managed by Pi Harness.",
        promptSnippet: "inspect running MCP server status",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        execute(
          _toolCallId,
          params,
          signal,
        ): Promise<AgentToolResult<{ servers: Array<{ id: string; executable: string; argumentCount: number; status: string; startedAt: number }> }>> {
          return Promise.resolve().then(() => {
            const operationSignal = executionSignal(signal, lifecycle.signal);
            operationSignal.throwIfAborted();
            inspectParameters(params, noParameterNames);
            const snapshot = statusSnapshot();
            return {
              content: [
                {
                  type: "text",
                  text:
                    snapshot.length === 0
                      ? "No MCP servers are running."
                      : snapshot
                          .map(
                            (server) =>
                              `${server.id}: ${server.status} (${server.executable}, ${server.argumentCount} argument${server.argumentCount === 1 ? "" : "s"})`,
                          )
                          .join("\n"),
                },
              ],
              details: { servers: snapshot },
            };
          });
        },
      }),
    );
    const unregisterStop = registerTool(
      defineTool({
        name: "mcp_server_stop",
        label: "MCP server stop",
        description: "Stop a persistent MCP stdio server and remove it from the managed set.",
        promptSnippet: "stop a persistent MCP stdio server",
        parameters: Type.Object({ serverId: Type.String() }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ serverId: string; stopped: boolean }>> {
          const operationSignal = executionSignal(signal, lifecycle.signal);
          operationSignal.throwIfAborted();
          const raw = inspectParameters(params, stopParameterNames);
          const serverId = serverIdValue(raw.serverId, true)!;
          const stopped = await stopServer(serverId, operationSignal);
          return { content: [{ type: "text", text: `MCP server ${serverId} stopped.` }], details: { serverId, stopped } };
        },
      }),
    );
    const unregisterListResources = registerTool(
      defineTool({
        name: "mcp_list_resources",
        label: "MCP list resources",
        description: "List resources exposed by an MCP server.",
        promptSnippet: "list resources exposed by an MCP server",
        parameters: Type.Object({ command: Type.Optional(Type.Array(Type.String())), serverId: Type.Optional(Type.String()) }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ resources: McpResource[] }>> {
          const operationSignal = executionSignal(signal, lifecycle.signal);
          operationSignal.throwIfAborted();
          const raw = inspectParameters(params, connectionParameterNames);
          const items = await resources(optionalCommand(raw.command), serverIdValue(raw.serverId), operationSignal);
          return {
            content: [{ type: "text", text: items.map((item) => `${item.uri} ${item.name ?? ""}`).join("\n") || "MCP server returned no resources." }],
            details: { resources: items },
          };
        },
      }),
    );
    const unregisterReadResource = registerTool(
      defineTool({
        name: "mcp_read_resource",
        label: "MCP read resource",
        description: "Read one resource exposed by an MCP server.",
        promptSnippet: "read a resource exposed by an MCP server",
        parameters: Type.Object(
          { command: Type.Optional(Type.Array(Type.String())), serverId: Type.Optional(Type.String()), uri: Type.String() },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<JsonObject>> {
          const operationSignal = executionSignal(signal, lifecycle.signal);
          operationSignal.throwIfAborted();
          const raw = inspectParameters(params, readResourceParameterNames);
          const result = await readResource(
            optionalCommand(raw.command),
            serverIdValue(raw.serverId),
            requiredString(raw.uri, "resource URI"),
            operationSignal,
          );
          return { content: resourceResultContent(result), details: clone(result) };
        },
      }),
    );
    const unregisterListPrompts = registerTool(
      defineTool({
        name: "mcp_list_prompts",
        label: "MCP list prompts",
        description: "List prompt templates exposed by an MCP server.",
        promptSnippet: "list prompt templates exposed by an MCP server",
        parameters: Type.Object({ command: Type.Optional(Type.Array(Type.String())), serverId: Type.Optional(Type.String()) }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ prompts: McpPrompt[] }>> {
          const operationSignal = executionSignal(signal, lifecycle.signal);
          operationSignal.throwIfAborted();
          const raw = inspectParameters(params, connectionParameterNames);
          const items = await prompts(optionalCommand(raw.command), serverIdValue(raw.serverId), operationSignal);
          return {
            content: [{ type: "text", text: items.map((item) => `${item.name}: ${item.description ?? ""}`).join("\n") || "MCP server returned no prompts." }],
            details: { prompts: items },
          };
        },
      }),
    );
    const unregisterGetPrompt = registerTool(
      defineTool({
        name: "mcp_get_prompt",
        label: "MCP get prompt",
        description: "Render a prompt template exposed by an MCP server.",
        promptSnippet: "render a prompt template from an MCP server",
        parameters: Type.Object(
          {
            command: Type.Optional(Type.Array(Type.String())),
            serverId: Type.Optional(Type.String()),
            name: Type.String(),
            arguments: Type.Optional(Type.Record(Type.String(), Type.String())),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<JsonObject>> {
          const operationSignal = executionSignal(signal, lifecycle.signal);
          operationSignal.throwIfAborted();
          const raw = inspectParameters(params, callParameterNames);
          const result = await getPrompt(
            optionalCommand(raw.command),
            serverIdValue(raw.serverId),
            requiredString(raw.name, "prompt name"),
            promptArguments(raw.arguments),
            operationSignal,
          );
          return { content: promptResultContent(result), details: clone(result) };
        },
      }),
    );
    const serverSnapshot = (): PiMcpServerSnapshot[] => {
      const running = [...servers.values()].map((server) => ({
        id: server.id,
        command: [executableName(server.command)],
        status: server.status,
        startedAt: server.startedAt,
      }));
      const active = new Set(running.map((server) => server.id));
      return [
        ...running,
        ...[...configured.values()]
          .filter((definition) => !active.has(definition.id))
          .map((definition) => ({ id: definition.id, command: [executableName(definition.command)], status: "stopped", startedAt: 0 })),
      ];
    };
    context.provide("piMcp", { snapshot: () => ({ servers: serverSnapshot() }) });
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "mcp-client-panel",
        pluginId: "@pi-harness/core/plugins/mcp-client",
        title: "MCP Client",
        description: "通过 stdio JSON-RPC 连接外部 MCP 工具服务器。",
        icon: "⌘",
        read: () => {
          const tools = latest?.tools ?? [];
          const resources = latest?.resources ?? [];
          const prompts = latest?.prompts ?? [];
          const serverStatuses = statusSnapshot();
          return clone({
            server: latest?.server ?? null,
            tools: tools.slice(0, maxPanelItems),
            resources: resources.slice(0, maxPanelItems),
            prompts: prompts.slice(0, maxPanelItems),
            lastCall: latest?.lastCall ?? null,
            servers: serverStatuses.slice(0, maxPanelItems),
            inventory: {
              tools: { total: tools.length, shown: Math.min(tools.length, maxPanelItems), truncated: tools.length > maxPanelItems },
              resources: { total: resources.length, shown: Math.min(resources.length, maxPanelItems), truncated: resources.length > maxPanelItems },
              prompts: { total: prompts.length, shown: Math.min(prompts.length, maxPanelItems), truncated: prompts.length > maxPanelItems },
              servers: {
                total: serverStatuses.length,
                shown: Math.min(serverStatuses.length, maxPanelItems),
                truncated: serverStatuses.length > maxPanelItems,
              },
            },
            limits: {
              responseBytes: maxResponseBytes,
              commandArgs: maxCommandArgs,
              argumentBytes: maxArgumentBytes,
              toolArgumentsBytes: maxToolArgumentsBytes,
              toolArgumentDepth: maxToolArgumentDepth,
              requestTimeoutMs,
              panelItems: maxPanelItems,
              inventoryItems: maxInventoryItems,
              paginationPages: maxPaginationPages,
              stderrBytes: maxStderrBytes,
              managedServers: maxManagedServers,
            },
          });
        },
      });
    } catch (error) {
      for (const unregister of unregisters.splice(0).reverse()) unregister();
      lifecycle.abort(new Error("MCP client plugin activation failed", { cause: error }));
      throw error;
    }
    context.effect(() => async () => {
      lifecycle.abort(new Error(disposedMessage));
      unregisterList();
      unregisterCall();
      unregisterStart();
      unregisterStatus();
      unregisterStop();
      unregisterListResources();
      unregisterReadResource();
      unregisterListPrompts();
      unregisterGetPrompt();
      const running = [...servers.values()];
      for (const server of running) {
        server.status = "stopping";
        server.lifecycle.abort(new Error(disposedMessage));
      }
      servers.clear();
      disposePanel();
      await Promise.all(running.map(async (server) => terminateChild(server.child)));
    });
    for (const definition of configured.values()) {
      if (definition.autoStart === true) await startServer(definition.command, definition.id, lifecycle.signal);
    }
  },
};
