import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, SessionManager, type AgentToolResult, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

const defaultMaxSessions = 500;
const maxAllowedSessions = 2_000;
const maxLabelLength = 120;
const graphCacheTtlMs = 5_000;

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
}

function sessionLabel(session: SessionInfo): string {
  const value = session.name?.trim() || session.firstMessage.trim() || session.id;
  if (value.length <= maxLabelLength) return value;
  let preview = value.slice(0, maxLabelLength - 1);
  if (/[\uD800-\uDBFF]$/u.test(preview)) preview = preview.slice(0, -1);
  return `${preview}…`;
}

export function buildSynapseGraph(sessions: readonly SessionInfo[], activePath?: string): SynapseGraph {
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
      return { manager, cwd: manager.getCwd(), directory: manager.getSessionDir(), sessionId: manager.getSessionId(), path: manager.getSessionFile() };
    };
    type Scope = ReturnType<typeof capture>;
    const sameScope = (left: Scope, right: Scope) =>
      left.manager === right.manager &&
      left.cwd === right.cwd &&
      left.directory === right.directory &&
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
      const sessions = await SessionManager.list(scope.cwd, scope.directory);
      check();
      if (ticket !== generation) throw new Error("Synapse scan was superseded");
      const graph: SynapseReport = {
        ...buildSynapseGraph(sessions.slice(0, maxSessions), scope.path),
        cwd: scope.cwd,
        total: sessions.length,
        truncated: sessions.length > maxSessions,
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
