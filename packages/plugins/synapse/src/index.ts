import type { Context } from "@deepseek-ai/cordis";
import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, parseSessionEntries, type AgentToolResult, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys, BoundedFileSizeError, readBoundedFile } from "@pi-harness/plugin-api";

const defaultMaxSessions = 500;
const maxAllowedSessions = 2_000;
const maxLabelLength = 120;
const graphCacheTtlMs = 5_000;
const maxSessionHeaderBytes = 64 * 1024;
const maxSessionFileBytes = 4 * 1024 * 1024;
const sessionReadConcurrency = 8;

export interface SynapsePluginConfig {
  maxSessions?: number;
}

export const Config: z<SynapsePluginConfig> = z.object({
  maxSessions: z.number().default(defaultMaxSessions),
});

export interface SynapseNode {
  id: string;
  sessionId: string;
  label: string;
  cwd: string;
  parentSessionId?: string;
  messageCount: number;
  messagesTruncated: boolean;
  modified: string;
  active: boolean;
  branchCount: number;
}

export interface SynapseEdge {
  from: string;
  to: string;
  kind: "fork";
}

export interface SynapseGraph {
  nodes: SynapseNode[];
  edges: SynapseEdge[];
  activeSessionId?: string;
  orphanCount: number;
}

export interface SynapseReport extends SynapseGraph {
  cwd: string;
  total: number;
  truncated: boolean;
  metadataTruncated: number;
  metadataUnavailable: number;
}

type SynapseSessionInfo = SessionInfo & { messagesTruncated?: boolean };
type SessionHeaderResult = { kind: "session"; session: SynapseSessionInfo } | { kind: "excluded" } | { kind: "unavailable" };
type SessionCwdResult = { kind: "accepted"; cwd: string } | { kind: "excluded" } | { kind: "unavailable" };

function sessionLabel(session: SessionInfo): string {
  const value = session.name?.trim() || session.firstMessage.trim() || session.id;
  if (value.length <= maxLabelLength) return value;
  let preview = value.slice(0, maxLabelLength - 1);
  if (/[\uD800-\uDBFF]$/u.test(preview)) preview = preview.slice(0, -1);
  return `${preview}…`;
}

export function buildSynapseGraph(sessions: readonly SynapseSessionInfo[], activePath?: string): SynapseGraph {
  const byPath = new Map(sessions.map((session) => [session.path, session]));
  const children = new Map<string, number>();
  const edges: SynapseEdge[] = [];
  let orphanCount = 0;
  for (const session of sessions) {
    const parentPath = session.parentSessionPath;
    if (parentPath === undefined) continue;
    const parent = byPath.get(parentPath);
    if (parent === undefined) {
      orphanCount += 1;
      continue;
    }
    children.set(parent.id, (children.get(parent.id) ?? 0) + 1);
    edges.push({ from: parent.id, to: session.id, kind: "fork" });
  }
  const activeSessionId = sessions.find((session) => session.path === activePath)?.id;
  return {
    nodes: sessions.map((session) => {
      const parent = session.parentSessionPath === undefined ? undefined : byPath.get(session.parentSessionPath);
      return {
        id: session.id,
        sessionId: session.id,
        label: sessionLabel(session),
        cwd: session.cwd,
        ...(parent === undefined ? {} : { parentSessionId: parent.id }),
        messageCount: session.messageCount,
        messagesTruncated: session.messagesTruncated === true,
        modified: session.modified.toISOString(),
        active: session.path === activePath,
        branchCount: children.get(session.id) ?? 0,
      };
    }),
    edges,
    ...(activeSessionId === undefined ? {} : { activeSessionId }),
    orphanCount,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new Error("Synapse scan was cancelled", { cause: signal.reason });
}

function sessionCwd(value: unknown, expectedCwd: string, filterCwd: boolean): SessionCwdResult {
  if (value === undefined) return filterCwd ? { kind: "excluded" } : { kind: "accepted", cwd: "" };
  if (typeof value !== "string" || value.length > 4_096) return { kind: "unavailable" };
  if (filterCwd && (value === "" || resolve(value) !== resolve(expectedCwd))) return { kind: "excluded" };
  return { kind: "accepted", cwd: value };
}

function headerSession(value: unknown, path: string, modified: Date, expectedCwd: string, filterCwd: boolean): SessionHeaderResult {
  const header = record(value);
  if (
    header?.type !== "session" ||
    typeof header.id !== "string" ||
    header.id.length === 0 ||
    header.id.length > 256 ||
    (header.parentSession !== undefined && (typeof header.parentSession !== "string" || header.parentSession.length > 4_096))
  )
    return { kind: "unavailable" };
  const cwd = sessionCwd(header.cwd, expectedCwd, filterCwd);
  if (cwd.kind !== "accepted") return cwd;
  const createdTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : Number.NaN;
  return {
    kind: "session",
    session: {
      path,
      id: header.id,
      cwd: cwd.cwd,
      ...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
      created: Number.isNaN(createdTime) ? modified : new Date(createdTime),
      modified,
      messageCount: 0,
      firstMessage: "",
      allMessagesText: "",
      messagesTruncated: true,
    },
  };
}

async function readSessionHeader(path: string, expectedCwd: string, filterCwd: boolean, signal: AbortSignal | undefined): Promise<SessionHeaderResult> {
  throwIfCancelled(signal);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    throwIfCancelled(signal);
    const metadata = await handle.stat();
    throwIfCancelled(signal);
    if (!metadata.isFile()) return { kind: "unavailable" };
    const chunks: Buffer[] = [];
    let total = 0;
    let newline = -1;
    while (total < maxSessionHeaderBytes) {
      throwIfCancelled(signal);
      const buffer = Buffer.allocUnsafe(Math.min(16 * 1024, maxSessionHeaderBytes - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      throwIfCancelled(signal);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const index = chunk.indexOf(0x0a);
      chunks.push(index === -1 ? chunk : chunk.subarray(0, index));
      total += index === -1 ? chunk.length : index;
      if (index !== -1) {
        newline = total;
        break;
      }
    }
    throwIfCancelled(signal);
    if (newline === -1 && metadata.size > total) return { kind: "unavailable" };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    return headerSession(JSON.parse(text), path, metadata.mtime, expectedCwd, filterCwd);
  } catch {
    throwIfCancelled(signal);
    return { kind: "unavailable" };
  } finally {
    await handle?.close();
  }
}

function compareCandidates(left: SynapseSessionInfo, right: SynapseSessionInfo): number {
  return right.modified.getTime() - left.modified.getTime() || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function retainCandidate(candidates: SynapseSessionInfo[], candidate: SynapseSessionInfo, limit: number): void {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareCandidates(candidate, candidates[middle]!) < 0) high = middle;
    else low = middle + 1;
  }
  candidates.splice(low, 0, candidate);
  if (candidates.length > limit) candidates.pop();
}

async function discoverSessions(
  directory: string,
  cwd: string,
  filterCwd: boolean,
  activePath: string | undefined,
  limit: number,
  signal: AbortSignal | undefined,
  check: () => void,
): Promise<{ candidates: SynapseSessionInfo[]; total: number; validTotal: number; unavailable: number }> {
  let handle: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    handle = await opendir(directory);
  } catch (error) {
    check();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { candidates: [], total: 0, validTotal: 0, unavailable: 0 };
    throw error;
  }
  const candidates: SynapseSessionInfo[] = [];
  let active: SynapseSessionInfo | undefined;
  let total = 0;
  let validTotal = 0;
  let unavailable = 0;
  for await (const entry of handle) {
    check();
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const result = await readSessionHeader(join(directory, entry.name), cwd, filterCwd, signal);
    check();
    if (result.kind === "excluded") continue;
    total += 1;
    if (result.kind === "unavailable") {
      unavailable += 1;
      continue;
    }
    const { session } = result;
    validTotal += 1;
    if (activePath !== undefined && resolve(session.path) === resolve(activePath)) active = session;
    retainCandidate(candidates, session, limit);
  }
  check();
  if (active !== undefined && !candidates.some((candidate) => candidate.path === active.path)) {
    if (candidates.length === limit) candidates.pop();
    retainCandidate(candidates, active, limit);
  }
  return { candidates, total, validTotal, unavailable };
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const part of value) {
    const block = record(part);
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text.trim());
  }
  return parts.filter(Boolean).join(" ").trim();
}

function hydrateSession(candidate: SynapseSessionInfo, entries: readonly unknown[], expectedCwd: string, filterCwd: boolean): SynapseSessionInfo | undefined {
  const header = record(entries[0]);
  const cwd = sessionCwd(header?.cwd, expectedCwd, filterCwd);
  if (header?.type !== "session" || header.id !== candidate.id || cwd.kind !== "accepted" || cwd.cwd !== candidate.cwd) return undefined;
  let name: string | undefined;
  let firstMessage = "";
  let messageCount = 0;
  let lastActivity = Number.NaN;
  for (const value of entries.slice(1)) {
    const entry = record(value);
    if (entry?.type === "session_info") {
      name = typeof entry.name === "string" ? entry.name.trim().slice(0, maxLabelLength + 1) || undefined : undefined;
      continue;
    }
    const message = record(entry?.message);
    if (entry?.type !== "message") continue;
    messageCount += 1;
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    const text = messageText(message.content);
    if (firstMessage === "" && message.role === "user" && text !== "") firstMessage = text.slice(0, maxLabelLength + 1);
    const timestamp =
      typeof message.timestamp === "number" ? message.timestamp : typeof entry.timestamp === "string" ? new Date(entry.timestamp).getTime() : Number.NaN;
    if (!Number.isNaN(timestamp)) lastActivity = Number.isNaN(lastActivity) ? timestamp : Math.max(lastActivity, timestamp);
  }
  return {
    ...candidate,
    ...(name === undefined ? {} : { name }),
    firstMessage,
    messageCount,
    modified: Number.isNaN(lastActivity) ? candidate.modified : new Date(lastActivity),
    messagesTruncated: false,
  };
}

async function readSessionMetadata(
  candidate: SynapseSessionInfo,
  expectedCwd: string,
  filterCwd: boolean,
  signal: AbortSignal | undefined,
  check: () => void,
): Promise<SynapseSessionInfo | undefined> {
  try {
    const bytes = await readBoundedFile(candidate.path, maxSessionFileBytes, "Synapse session file", signal);
    check();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (const line of text.split("\n")) if (line.trim() !== "") JSON.parse(line);
    return hydrateSession(candidate, parseSessionEntries(text), expectedCwd, filterCwd);
  } catch (error) {
    check();
    if (!(error instanceof BoundedFileSizeError)) return undefined;
    const current = await readSessionHeader(candidate.path, expectedCwd, filterCwd, signal);
    check();
    return current.kind === "session" && current.session.id === candidate.id && current.session.cwd === candidate.cwd ? current.session : undefined;
  }
}

async function readSessionMetadataBatch(
  candidates: readonly SynapseSessionInfo[],
  expectedCwd: string,
  filterCwd: boolean,
  signal: AbortSignal | undefined,
  check: () => void,
): Promise<SynapseSessionInfo[]> {
  const sessions: SynapseSessionInfo[] = [];
  for (let index = 0; index < candidates.length; index += sessionReadConcurrency) {
    check();
    const batch = await Promise.all(
      candidates.slice(index, index + sessionReadConcurrency).map((candidate) => readSessionMetadata(candidate, expectedCwd, filterCwd, signal, check)),
    );
    check();
    sessions.push(...batch.filter((session): session is SynapseSessionInfo => session !== undefined));
  }
  return sessions.sort(compareCandidates);
}

export default {
  name: "pi-synapse",
  inject: ["piHarnessLaunch", "piSession", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: SynapsePluginConfig) {
    assertKnownConfigKeys("pi-synapse", config, ["maxSessions"]);
    const maxSessions = config.maxSessions ?? defaultMaxSessions;
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > maxAllowedSessions)
      throw new Error("Synapse maxSessions must be an integer from 1 to 2000");
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
    const currentManager = () => context.get("piRuntime")?.session.sessionManager ?? context.piSession.manager;
    const capture = () => {
      if (lifecycle.signal.aborted) throw new Error("Synapse scan was cancelled");
      const manager = currentManager();
      return {
        manager,
        cwd: manager.getCwd(),
        directory: manager.getSessionDir(),
        filterCwd: !manager.usesDefaultSessionDir(),
        sessionId: manager.getSessionId(),
        path: manager.getSessionFile(),
      };
    };
    type Scope = ReturnType<typeof capture>;
    const sameScope = (left: Scope, right: Scope) =>
      left.manager === right.manager &&
      left.cwd === right.cwd &&
      left.directory === right.directory &&
      left.filterCwd === right.filterCwd &&
      left.sessionId === right.sessionId &&
      left.path === right.path;
    let cached: { scope: Scope; graph: SynapseReport; at: number } | undefined;
    let refreshes = 0;
    let generation = 0;
    let inFlight: { scope: Scope; promise: Promise<SynapseReport> } | undefined;
    const scan = async (scope: Scope, signal?: AbortSignal): Promise<SynapseReport> => {
      const check = () => {
        if (lifecycle.signal.aborted || signal?.aborted) throw new Error("Synapse scan was cancelled");
        if (!sameScope(scope, capture())) throw new Error("Synapse context changed during execution");
      };
      check();
      const ticket = ++generation;
      const discovery = await discoverSessions(scope.directory, scope.cwd, scope.filterCwd, scope.path, maxSessions, signal, check);
      check();
      const sessions = await readSessionMetadataBatch(discovery.candidates, scope.cwd, scope.filterCwd, signal, check);
      check();
      if (ticket !== generation) throw new Error("Synapse scan was superseded");
      const graph: SynapseReport = {
        ...buildSynapseGraph(sessions, scope.path),
        cwd: scope.cwd,
        total: discovery.total,
        truncated: discovery.validTotal > discovery.candidates.length,
        metadataTruncated: sessions.filter((session) => session.messagesTruncated === true).length,
        metadataUnavailable: discovery.unavailable + discovery.candidates.length - sessions.length,
      };
      cached = { scope, graph: structuredClone(graph), at: Date.now() };
      return graph;
    };
    const refresh = (scope: Scope, signal?: AbortSignal): Promise<SynapseReport> => {
      const promise = scan(scope, signal).finally(() => {
        if (inFlight?.promise === promise) inFlight = undefined;
      });
      inFlight = { scope, promise };
      return promise;
    };
    const readGraph = (): Promise<SynapseReport> => {
      const scope = capture();
      if (inFlight !== undefined && sameScope(inFlight.scope, scope)) return inFlight.promise.then((graph) => structuredClone(graph));
      if (cached !== undefined && sameScope(cached.scope, scope) && Date.now() - cached.at < graphCacheTtlMs)
        return Promise.resolve(structuredClone(cached.graph));
      return refresh(scope).then((graph) => structuredClone(graph));
    };

    const refreshTool = context.piTools.register(
      defineTool({
        name: "synapse_session_map",
        label: "Refresh session map",
        description: "Refresh the Synapse view from Pi's native session files and return fork relationships for the current workspace.",
        promptSnippet: "inspect the native Pi session map and fork lineage",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<SynapseReport>> {
          if (signal?.aborted || lifecycle.signal.aborted) throw new Error("Synapse scan was cancelled");
          if (params === null || typeof params !== "object" || Array.isArray(params) || Reflect.ownKeys(params).length !== 0)
            throw new Error("Synapse parameters must be an empty object");
          const scope = capture();
          const next = await refresh(scope, signal);
          if (signal?.aborted || lifecycle.signal.aborted) throw new Error("Synapse scan was cancelled");
          if (!sameScope(scope, capture())) throw new Error("Synapse context changed during execution");
          // The panel reports how many times this tool was asked for a map; background polls reuse the same scan and must not inflate it.
          refreshes = Math.min(Number.MAX_SAFE_INTEGER, refreshes + 1);
          return { content: [{ type: "text", text: JSON.stringify(next) }], details: next };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "synapse-panel",
        pluginId: "@pi-harness/plugin-synapse",
        title: "Synapse",
        description: "将当前工作区的原生 Pi 会话与 fork 关系投影成可浏览地图。",
        icon: "⌘",
        read: async () => ({ ...(await readGraph()), refreshes }),
      });
    } catch (error) {
      refreshTool();
      throw error;
    }
    context.effect(() => () => {
      refreshTool();
      disposePanel();
    });
  },
};
