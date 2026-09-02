import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const defaultFileName = "graph-memory.json";
const absoluteNodeLimit = 2_000;
const absoluteRelationLimit = 5_000;
const maxLabelLength = 160;
const maxSummaryBytes = 16 * 1024;
const maxSourceLength = 512;
const maxQueryLength = 160;
const maxFileBytes = 4 * 1024 * 1024;
const lockRetryMs = 25;
const lockTimeoutMs = 10_000;

type NodeKind = "task" | "skill" | "event";
type RelationKind = "USED_SKILL" | "SOLVED_BY" | "REQUIRES" | "PATCHES" | "CONFLICTS_WITH" | "RELATED_TO";
type GraphNode = { id: string; kind: NodeKind; label: string; summary: string; source?: string; createdAt: string; updatedAt: string };
type GraphRelation = { id: string; from: string; to: string; relation: RelationKind; createdAt: string };
type GraphFile = { version: 1; nodes: GraphNode[]; relations: GraphRelation[] };
type GraphSearchReport = { query: string; total: number; nodes: GraphNode[]; relations: GraphRelation[] };
type GraphState = Pick<GraphFile, "nodes" | "relations">;

export interface GraphMemoryPluginConfig {
  fileName?: string;
  maxNodes?: number;
  maxRelations?: number;
}

export const Config: z<GraphMemoryPluginConfig> = z.object({
  fileName: z.string().default(defaultFileName),
  maxNodes: z.number().default(absoluteNodeLimit),
  maxRelations: z.number().default(absoluteRelationLimit),
});

function normalizeFilePath(agentDir: string, fileName: string | undefined): string {
  const name = (fileName ?? defaultFileName).trim();
  if (name === "" || basename(name) !== name || !name.toLowerCase().endsWith(".json")) throw new Error("Graph memory fileName must be a single .json filename");
  return resolve(agentDir, name);
}

function normalizeText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new Error(`${field} must contain 1-${maxLength} characters`);
  return normalized;
}

function normalizeSummary(value: string): string {
  const normalized = value.trim();
  if (normalized === "" || Buffer.byteLength(normalized, "utf8") > maxSummaryBytes)
    throw new Error(`Graph memory summary must be non-empty and at most ${maxSummaryBytes} bytes`);
  return normalized;
}

function isNodeKind(value: unknown): value is NodeKind {
  return value === "task" || value === "skill" || value === "event";
}

function isRelationKind(value: unknown): value is RelationKind {
  return value === "USED_SKILL" || value === "SOLVED_BY" || value === "REQUIRES" || value === "PATCHES" || value === "CONFLICTS_WITH" || value === "RELATED_TO";
}

function isGraphNode(value: unknown): value is GraphNode {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  return (
    typeof node.id === "string" &&
    node.id.length > 0 &&
    node.id.length <= maxLabelLength &&
    isNodeKind(node.kind) &&
    typeof node.label === "string" &&
    node.label.trim().length > 0 &&
    node.label.length <= maxLabelLength &&
    typeof node.summary === "string" &&
    node.summary.trim().length > 0 &&
    Buffer.byteLength(node.summary, "utf8") <= maxSummaryBytes &&
    (node.source === undefined || typeof node.source === "string") &&
    (node.source === undefined || (node.source.length > 0 && node.source.length <= maxSourceLength)) &&
    typeof node.createdAt === "string" &&
    Number.isFinite(Date.parse(node.createdAt)) &&
    typeof node.updatedAt === "string" &&
    Number.isFinite(Date.parse(node.updatedAt))
  );
}

function isGraphRelation(value: unknown): value is GraphRelation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const relation = value as Record<string, unknown>;
  return (
    typeof relation.id === "string" &&
    relation.id.length > 0 &&
    relation.id.length <= maxLabelLength &&
    typeof relation.from === "string" &&
    typeof relation.to === "string" &&
    isRelationKind(relation.relation) &&
    typeof relation.createdAt === "string" &&
    Number.isFinite(Date.parse(relation.createdAt))
  );
}

async function readGraphFile(filePath: string, nodeLimit: number, relationLimit: number): Promise<GraphState> {
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nodes: [], relations: [] };
    throw error;
  }
  if (raw.byteLength > maxFileBytes) throw new Error(`Graph memory file exceeds its ${maxFileBytes}-byte limit`);
  const parsed = JSON.parse(raw.toString("utf8")) as Partial<GraphFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.relations)) throw new Error("Graph memory file has an unsupported format");
  if (!parsed.nodes.every(isGraphNode)) throw new Error("Graph memory file contains invalid nodes");
  if (!parsed.relations.every(isGraphRelation)) throw new Error("Graph memory file contains invalid relations");
  if (parsed.nodes.length > nodeLimit) throw new Error(`Graph memory file exceeds its ${nodeLimit}-node limit`);
  if (parsed.relations.length > relationLimit) throw new Error(`Graph memory file exceeds its ${relationLimit}-relation limit`);
  const nodeIds = new Set(parsed.nodes.map((node) => node.id));
  const relationIds = new Set<string>();
  for (const relation of parsed.relations) {
    if (!nodeIds.has(relation.from) || !nodeIds.has(relation.to)) throw new Error("Graph memory file contains relations with missing nodes");
    if (relation.from === relation.to) throw new Error("Graph memory file contains self-relations");
    if (!relationIds.add(relation.id)) throw new Error("Graph memory file contains duplicate relation ids");
  }
  if (nodeIds.size !== parsed.nodes.length) throw new Error("Graph memory file contains duplicate node ids");
  return { nodes: parsed.nodes, relations: parsed.relations };
}

async function writeGraphFile(filePath: string, state: GraphState): Promise<void> {
  const payload = JSON.stringify({ version: 1, ...state } satisfies GraphFile, null, 2);
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

async function acquireGraphLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline)
        throw new Error("Timed out waiting for graph memory file lock", { cause: error });
      await new Promise<void>((resolve) => setTimeout(resolve, lockRetryMs));
    }
  }
}

export default {
  name: "pi-graph-memory",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: GraphMemoryPluginConfig) {
    const filePath = normalizeFilePath(context.piHarnessLaunch.agentDir, config.fileName);
    const nodeLimit = Math.max(1, Math.min(absoluteNodeLimit, Math.trunc(config.maxNodes ?? absoluteNodeLimit)));
    const relationLimit = Math.max(1, Math.min(absoluteRelationLimit, Math.trunc(config.maxRelations ?? absoluteRelationLimit)));
    let nodes: GraphNode[] = [];
    let relations: GraphRelation[] = [];
    let loaded = false;
    let loading: Promise<void> | undefined;
    let mutationQueue = Promise.resolve();
    let lastSearch: GraphSearchReport | undefined;

    const load = async (): Promise<void> => {
      if (loaded) return;
      if (loading !== undefined) return loading;
      loading = (async () => {
        const state = await readGraphFile(filePath, nodeLimit, relationLimit);
        nodes = state.nodes;
        relations = state.relations;
        loaded = true;
      })();
      return loading;
    };

    const mutate = async <T>(operation: (state: GraphState) => T): Promise<T> => {
      let result: T | undefined;
      const run = async (): Promise<void> => {
        const release = await acquireGraphLock(`${filePath}.lock`);
        try {
          const state = await readGraphFile(filePath, nodeLimit, relationLimit);
          result = operation(state);
          await writeGraphFile(filePath, state);
          nodes = state.nodes;
          relations = state.relations;
          loaded = true;
        } finally {
          await release();
        }
      };
      mutationQueue = mutationQueue.catch(() => undefined).then(run);
      await mutationQueue;
      return result as T;
    };

    const recordTool = defineTool({
      name: "graph_memory_record",
      label: "Record graph memory",
      description: "Persist or update one typed task, skill, or event node with explicit provenance in the local graph memory.",
      promptSnippet: "record durable typed knowledge in the local graph memory",
      parameters: Type.Object({
        kind: Type.Union([Type.Literal("task"), Type.Literal("skill"), Type.Literal("event")]),
        label: Type.String(),
        summary: Type.String(),
        source: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params): Promise<AgentToolResult<GraphNode>> {
        const label = normalizeText(params.label, "Graph memory label", maxLabelLength);
        const summary = normalizeSummary(params.summary);
        const source = params.source === undefined ? undefined : normalizeText(params.source, "Graph memory source", maxSourceLength);
        const node = await mutate((state) => {
          const existing = state.nodes.find((candidate) => candidate.kind === params.kind && candidate.label.toLocaleLowerCase() === label.toLocaleLowerCase());
          if (existing === undefined && state.nodes.length >= nodeLimit) throw new Error(`Graph memory reached its ${nodeLimit}-node limit`);
          const now = new Date().toISOString();
          const next: GraphNode =
            existing === undefined
              ? { id: randomUUID(), kind: params.kind, label, summary, ...(source === undefined ? {} : { source }), createdAt: now, updatedAt: now }
              : { ...existing, label, summary, ...(source === undefined ? {} : { source }), updatedAt: now };
          state.nodes = [next, ...state.nodes.filter((candidate) => candidate.id !== next.id)];
          return next;
        });
        return { content: [{ type: "text", text: `Graph memory recorded: ${node.id} [${node.kind}] ${node.label}` }], details: node };
      },
    });

    const linkTool = defineTool({
      name: "graph_memory_link",
      label: "Link graph memories",
      description: "Create one typed directed relation between two existing graph-memory nodes.",
      promptSnippet: "link two graph memories with a typed relation",
      parameters: Type.Object({
        from: Type.String(),
        to: Type.String(),
        relation: Type.Union([
          Type.Literal("USED_SKILL"),
          Type.Literal("SOLVED_BY"),
          Type.Literal("REQUIRES"),
          Type.Literal("PATCHES"),
          Type.Literal("CONFLICTS_WITH"),
          Type.Literal("RELATED_TO"),
        ]),
      }),
      async execute(_toolCallId, params): Promise<AgentToolResult<GraphRelation>> {
        const from = normalizeText(params.from, "Graph relation source id", maxLabelLength);
        const to = normalizeText(params.to, "Graph relation target id", maxLabelLength);
        if (from === to) throw new Error("Graph memory relations require two different nodes");
        const relation = await mutate((state) => {
          if (!state.nodes.some((node) => node.id === from)) throw new Error(`Graph memory source node not found: ${from}`);
          if (!state.nodes.some((node) => node.id === to)) throw new Error(`Graph memory target node not found: ${to}`);
          const existing = state.relations.find((candidate) => candidate.from === from && candidate.to === to && candidate.relation === params.relation);
          if (existing !== undefined) return existing;
          if (state.relations.length >= relationLimit) throw new Error(`Graph memory reached its ${relationLimit}-relation limit`);
          const next: GraphRelation = { id: randomUUID(), from, to, relation: params.relation, createdAt: new Date().toISOString() };
          state.relations = [next, ...state.relations];
          return next;
        });
        return {
          content: [{ type: "text", text: `Graph relation ${relation.id} ${relation.relation}: ${relation.from} → ${relation.to}` }],
          details: relation,
        };
      },
    });

    const searchTool = defineTool({
      name: "graph_memory_search",
      label: "Search graph memory",
      description: "Search typed graph-memory nodes by label, summary, provenance, kind, or connected relation.",
      promptSnippet: "search the local cross-session knowledge graph",
      parameters: Type.Object({
        query: Type.String(),
        kind: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("skill"), Type.Literal("event")])),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_toolCallId, params): Promise<AgentToolResult<GraphSearchReport>> {
        await load();
        const query = normalizeText(params.query, "Graph memory query", maxQueryLength);
        if (query.length < 2) throw new Error(`Graph memory query must contain 2-${maxQueryLength} characters`);
        const needle = query.toLocaleLowerCase();
        const limit = Math.max(1, Math.min(50, Math.trunc(params.limit ?? 12)));
        const ranked = nodes
          .filter((node) => params.kind === undefined || node.kind === params.kind)
          .map((node) => {
            const label = node.label.toLocaleLowerCase();
            const summary = node.summary.toLocaleLowerCase();
            const source = node.source?.toLocaleLowerCase() ?? "";
            const relationHit = relations.some((relation) => {
              if (relation.from !== node.id && relation.to !== node.id) return false;
              if (relation.relation.toLocaleLowerCase().includes(needle)) return true;
              const neighborId = relation.from === node.id ? relation.to : relation.from;
              return (
                nodes
                  .find((candidate) => candidate.id === neighborId)
                  ?.label.toLocaleLowerCase()
                  .includes(needle) ?? false
              );
            });
            const score =
              label === needle ? 100 : label.includes(needle) ? 60 : summary.includes(needle) ? 30 : source.includes(needle) || node.kind === needle ? 15 : 0;
            return { node, score: score > 0 ? score : relationHit ? 20 : 0 };
          })
          .filter((match) => match.score > 0)
          .sort((left, right) => right.score - left.score || right.node.updatedAt.localeCompare(left.node.updatedAt));
        const matches = ranked.slice(0, limit).map((match) => match.node);
        const matchedIds = new Set(matches.map((node) => node.id));
        const matchedRelations = relations.filter((relation) => matchedIds.has(relation.from) || matchedIds.has(relation.to)).slice(0, limit * 4);
        lastSearch = { query, total: ranked.length, nodes: matches, relations: matchedRelations };
        return {
          content: [
            {
              type: "text",
              text:
                matches.length === 0
                  ? `No graph memories found for ${query}.`
                  : matches.map((node) => `${node.id} [${node.kind}] ${node.label}: ${node.summary}`).join("\n"),
            },
          ],
          details: lastSearch,
        };
      },
    });

    const forgetTool = defineTool({
      name: "graph_memory_forget",
      label: "Forget graph memory",
      description: "Delete one graph-memory node and all incident relations after explicit confirmation.",
      promptSnippet: "forget a graph memory after confirmation",
      parameters: Type.Object({ id: Type.String(), confirm: Type.Boolean() }),
      async execute(_toolCallId, params): Promise<AgentToolResult<{ id: string; removed: boolean; removedRelations: number }>> {
        const id = normalizeText(params.id, "Graph memory node id", maxLabelLength);
        if (params.confirm !== true) throw new Error("Deleting a graph memory requires confirm=true");
        const result = await mutate((state) => {
          const beforeNodes = state.nodes.length;
          const beforeRelations = state.relations.length;
          state.nodes = state.nodes.filter((node) => node.id !== id);
          state.relations = state.relations.filter((relation) => relation.from !== id && relation.to !== id);
          return { id, removed: state.nodes.length !== beforeNodes, removedRelations: beforeRelations - state.relations.length };
        });
        return {
          content: [{ type: "text", text: result.removed ? `Graph memory deleted: ${id}` : `Graph memory not found: ${id}` }],
          details: result,
        };
      },
    });

    const disposers: Array<() => void> = [];
    try {
      disposers.push(context.piTools.register(recordTool));
      disposers.push(context.piTools.register(linkTool));
      disposers.push(context.piTools.register(searchTool));
      disposers.push(context.piTools.register(forgetTool));
      disposers.push(
        context.piPluginUi.register({
          id: "graph-memory-panel",
          pluginId: "@pi-harness/core/plugins/graph-memory",
          title: "Graph Memory",
          description: "显式记录任务、技能与事件关系，保留来源并跨会话查询。",
          icon: "⌬",
          read: async () => {
            await load();
            return {
              filePath,
              nodes: nodes.length,
              relations: relations.length,
              kinds: {
                task: nodes.filter((node) => node.kind === "task").length,
                skill: nodes.filter((node) => node.kind === "skill").length,
                event: nodes.filter((node) => node.kind === "event").length,
              },
              recent: nodes.slice(0, 8),
              recentRelations: relations.slice(0, 8).map((relation) => ({
                ...relation,
                fromLabel: nodes.find((node) => node.id === relation.from)?.label ?? relation.from,
                toLabel: nodes.find((node) => node.id === relation.to)?.label ?? relation.to,
              })),
              lastSearch: lastSearch ?? null,
            };
          },
        }),
      );
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }
    context.effect(() => () => {
      for (const dispose of disposers.reverse()) dispose();
    });
  },
};
