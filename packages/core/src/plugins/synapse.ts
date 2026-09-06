import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, SessionManager, type AgentToolResult, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "../config.js";

const defaultMaxSessions = 500;
const maxAllowedSessions = 2_000;
const maxLabelLength = 120;

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

function sessionLabel(session: SessionInfo): string {
  const value = session.name?.trim() || session.firstMessage.trim() || session.id;
  return value.length > maxLabelLength ? `${value.slice(0, maxLabelLength - 1)}…` : value;
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
    const maxSessions = Math.max(1, Math.min(maxAllowedSessions, Math.trunc(config.maxSessions ?? defaultMaxSessions)));
    let graph: SynapseGraph = { nodes: [], edges: [], orphanCount: 0 };
    let refreshes = 0;

    const refresh = async (): Promise<SynapseGraph> => {
      const sessions = await SessionManager.list(context.piHarnessLaunch.cwd, context.piSession.manager.getSessionDir());
      graph = buildSynapseGraph(sessions.slice(0, maxSessions), context.piSession.manager.getSessionFile());
      refreshes += 1;
      return graph;
    };

    const refreshTool = context.piTools.register(
      defineTool({
        name: "synapse_session_map",
        label: "Refresh session map",
        description: "Refresh the Synapse view from Pi's native session files and return fork relationships for the current workspace.",
        promptSnippet: "inspect the native Pi session map and fork lineage",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(): Promise<AgentToolResult<SynapseGraph>> {
          const next = await refresh();
          return { content: [{ type: "text", text: `Synapse mapped ${next.nodes.length} session(s) and ${next.edges.length} fork edge(s).` }], details: next };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "synapse-panel",
        pluginId: "@pi-harness/core/plugins/synapse",
        title: "Synapse",
        description: "将当前工作区的原生 Pi 会话与 fork 关系投影成可浏览地图。",
        icon: "⌘",
        read: async () => ({ ...(await refresh()), refreshes }),
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
