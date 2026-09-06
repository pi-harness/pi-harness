const visibleTools = 12;
const visibleResources = 8;
const visiblePrompts = 8;
const visibleServers = 12;
const defaults = {
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
} as const;
const serverStatuses = new Set(["running", "stopping", "stopped"]);

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= fallback ? Math.trunc(value) : fallback;
}

function string(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}

function tool(value: unknown) {
  const record = ownRecord(value);
  if (record === undefined) return undefined;
  const name = string(record.name, 512);
  if (name === undefined) return undefined;
  const description = string(record.description, 500);
  return { name, ...(description === undefined ? {} : { description }) };
}

function resource(value: unknown) {
  const record = ownRecord(value);
  if (record === undefined) return undefined;
  const uri = string(record.uri, 4_096);
  if (uri === undefined) return undefined;
  const name = string(record.name, 512);
  const mimeType = string(record.mimeType, 256);
  return { uri, ...(name === undefined ? {} : { name }), ...(mimeType === undefined ? {} : { mimeType }) };
}

function prompt(value: unknown) {
  const record = ownRecord(value);
  if (record === undefined) return undefined;
  const name = string(record.name, 512);
  if (name === undefined) return undefined;
  const description = string(record.description, 500);
  return { name, ...(description === undefined ? {} : { description }) };
}

function server(value: unknown) {
  const record = ownRecord(value);
  if (record === undefined) return undefined;
  const id = string(record.id, 64);
  if (id === undefined) return undefined;
  const status = typeof record.status === "string" && serverStatuses.has(record.status) ? record.status : "unknown";
  const startedAt = typeof record.startedAt === "number" && Number.isFinite(record.startedAt) && record.startedAt >= 0 ? Math.trunc(record.startedAt) : 0;
  return { id, status, startedAt };
}

function items<T>(raw: unknown, visible: number, normalize: (value: unknown) => T | undefined): { values: T[]; clipped: boolean; rawLength: number } {
  const source = ownArray(raw, visible + 2) ?? [];
  const inspected = source;
  const values = inspected
    .map(normalize)
    .filter((value): value is T => value !== undefined)
    .slice(0, visible);
  return { values, clipped: source.length > visible || source.length !== values.length, rawLength: source.length };
}

function inventory(raw: unknown, shown: number, clipped: boolean) {
  const source = ownRecord(raw) ?? {};
  const total = count(source.total, shown);
  return { total, shown, truncated: source.truncated === true || clipped || total > shown };
}

export function mcpClientPanelView(data: unknown) {
  const source = ownRecord(data) ?? {};
  const normalizedTools = items(source.tools, visibleTools, tool);
  const normalizedResources = items(source.resources, visibleResources, resource);
  const normalizedPrompts = items(source.prompts, visiblePrompts, prompt);
  const normalizedServers = items(source.servers, visibleServers, server);
  const rawInventory = ownRecord(source.inventory) ?? {};
  const rawLimits = ownRecord(source.limits) ?? {};
  return {
    server: source.server === null ? null : (string(source.server, 4_096) ?? null),
    tools: normalizedTools.values,
    resources: normalizedResources.values,
    prompts: normalizedPrompts.values,
    lastCall: source.lastCall === null ? null : (string(source.lastCall, 512) ?? null),
    servers: normalizedServers.values,
    inventory: {
      tools: inventory(rawInventory.tools, normalizedTools.values.length, normalizedTools.clipped),
      resources: inventory(rawInventory.resources, normalizedResources.values.length, normalizedResources.clipped),
      prompts: inventory(rawInventory.prompts, normalizedPrompts.values.length, normalizedPrompts.clipped),
      servers: inventory(rawInventory.servers, normalizedServers.values.length, normalizedServers.clipped),
    },
    limits: {
      responseBytes: positive(rawLimits.responseBytes, defaults.responseBytes),
      commandArgs: positive(rawLimits.commandArgs, defaults.commandArgs),
      argumentBytes: positive(rawLimits.argumentBytes, defaults.argumentBytes),
      toolArgumentsBytes: positive(rawLimits.toolArgumentsBytes, defaults.toolArgumentsBytes),
      toolArgumentDepth: positive(rawLimits.toolArgumentDepth, defaults.toolArgumentDepth),
      requestTimeoutMs: positive(rawLimits.requestTimeoutMs, defaults.requestTimeoutMs),
      panelItems: positive(rawLimits.panelItems, defaults.panelItems),
      inventoryItems: positive(rawLimits.inventoryItems, defaults.inventoryItems),
      paginationPages: positive(rawLimits.paginationPages, defaults.paginationPages),
      stderrBytes: positive(rawLimits.stderrBytes, defaults.stderrBytes),
      managedServers: positive(rawLimits.managedServers, defaults.managedServers),
    },
  };
}
import { ownArray, ownRecord } from "./panel-safe.js";
