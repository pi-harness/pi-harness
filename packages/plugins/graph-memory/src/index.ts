import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { atomicWriteFile, readBoundedFile, readBoundedTextFile } from "@pi-harness/plugin-api";

const defaultFileName = "graph-memory.json";
const absoluteNodeLimit = 2_000;
const absoluteRelationLimit = 5_000;
const maxLabelLength = 160;
const maxSummaryBytes = 16 * 1024;
const maxSourceLength = 512;
const maxQueryLength = 160;
const maxFileBytes = 4 * 1024 * 1024;
const maxSearchResults = 50;
const lockRetryMs = 25;
const lockTimeoutMs = 10_000;
const staleLockMs = 30_000;
const maxLockOwnerBytes = 1024;
const nodeFields = new Set(["id", "kind", "label", "summary", "source", "createdAt", "updatedAt"]);
const relationFields = new Set(["id", "from", "to", "relation", "createdAt"]);

type NodeKind = "task" | "skill" | "event";
type RelationKind = "USED_SKILL" | "SOLVED_BY" | "REQUIRES" | "PATCHES" | "CONFLICTS_WITH" | "RELATED_TO";
type GraphNode = { id: string; kind: NodeKind; label: string; summary: string; source?: string; createdAt: string; updatedAt: string };
type GraphRelation = { id: string; from: string; to: string; relation: RelationKind; createdAt: string };
type GraphFile = { version: 1; nodes: GraphNode[]; relations: GraphRelation[] };
type GraphSearchReport = { query: string; total: number; nodes: GraphNode[]; relations: GraphRelation[] };
type GraphState = Pick<GraphFile, "nodes" | "relations">;
type RecordParameters = { kind: NodeKind; label: string; summary: string; source?: string };
type LinkParameters = { from: string; to: string; relation: RelationKind };
type SearchParameters = { query: string; kind?: NodeKind; limit?: number };
type ForgetParameters = { id: string; confirm: boolean };

function cloneNode(node: GraphNode): GraphNode {
  return { ...node };
}

function cloneRelation(relation: GraphRelation): GraphRelation {
  return { ...relation };
}

function cloneSearchReport(report: GraphSearchReport): GraphSearchReport {
  return { ...report, nodes: report.nodes.map(cloneNode), relations: report.relations.map(cloneRelation) };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Graph memory operation was cancelled", { cause: signal.reason });
}

function rejectionError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}

function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    throwIfAborted(signal);
  } catch (error) {
    return Promise.reject(rejectionError(error, "Graph memory operation was cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(rejectionError(error, "Graph memory operation was cancelled"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(rejectionError(error, "Graph memory operation failed"));
      },
    );
  });
}

async function waitForLockRetry(signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, lockRetryMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Graph memory operation was cancelled", { cause: error }));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.trunc(value))) : fallback;
}

function dataDescriptors(value: unknown, field: string, allowed: ReadonlySet<string>): Record<PropertyKey, PropertyDescriptor> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) throw new Error(`${field} contains an unknown property`);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error(`${field} must use data properties`);
  return descriptors;
}

function recordParameters(value: unknown): RecordParameters {
  const descriptors = dataDescriptors(value, "Graph memory record parameters", new Set(["kind", "label", "summary", "source"]));
  const kind: unknown = descriptors.kind?.value;
  const label: unknown = descriptors.label?.value;
  const summary: unknown = descriptors.summary?.value;
  const source: unknown = descriptors.source?.value;
  if (!isNodeKind(kind)) throw new Error("Graph memory kind must be task, skill, or event");
  if (typeof label !== "string") throw new Error("Graph memory label must be a string");
  if (typeof summary !== "string") throw new Error("Graph memory summary must be a string");
  if (source !== undefined && typeof source !== "string") throw new Error("Graph memory source must be a string");
  return { kind, label, summary, ...(source === undefined ? {} : { source }) };
}

function linkParameters(value: unknown): LinkParameters {
  const descriptors = dataDescriptors(value, "Graph memory link parameters", new Set(["from", "to", "relation"]));
  const from: unknown = descriptors.from?.value;
  const to: unknown = descriptors.to?.value;
  const relation: unknown = descriptors.relation?.value;
  if (typeof from !== "string") throw new Error("Graph memory link from must be a string");
  if (typeof to !== "string") throw new Error("Graph memory link to must be a string");
  if (!isRelationKind(relation)) throw new Error("Graph memory relation kind is invalid");
  return { from, to, relation };
}

function searchParameters(value: unknown): SearchParameters {
  const descriptors = dataDescriptors(value, "Graph memory search parameters", new Set(["query", "kind", "limit"]));
  const query: unknown = descriptors.query?.value;
  const kind: unknown = descriptors.kind?.value;
  const limit: unknown = descriptors.limit?.value;
  if (typeof query !== "string") throw new Error("Graph memory query must be a string");
  if (kind !== undefined && !isNodeKind(kind)) throw new Error("Graph memory search kind must be task, skill, or event");
  if (limit !== undefined && typeof limit !== "number") throw new Error("Graph memory search limit must be a number");
  return { query, ...(kind === undefined ? {} : { kind }), ...(limit === undefined ? {} : { limit }) };
}

function forgetParameters(value: unknown): ForgetParameters {
  const descriptors = dataDescriptors(value, "Graph memory forget parameters", new Set(["id", "confirm"]));
  const id: unknown = descriptors.id?.value;
  const confirm: unknown = descriptors.confirm?.value;
  if (typeof id !== "string") throw new Error("Graph memory forget id must be a string");
  if (typeof confirm !== "boolean") throw new Error("Graph memory forget confirm must be a boolean");
  return { id, confirm };
}

function normalizeFilePath(agentDir: string, fileName: string | undefined): string {
  const name = (fileName ?? defaultFileName).trim();
  if (name.includes("\0")) throw new Error("Graph memory fileName must not contain NUL characters");
  if (name === "" || name.includes("/") || name.includes("\\") || basename(name) !== name || !name.toLowerCase().endsWith(".json"))
    throw new Error("Graph memory fileName must be a single .json filename");
  return resolve(agentDir, name);
}

function normalizeText(value: string, field: string, maxLength: number): string {
  if (value.includes("\0")) throw new Error(`${field} must not contain NUL characters`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new Error(`${field} must contain 1-${maxLength} characters`);
  return normalized;
}

function normalizeSummary(value: string): string {
  if (value.includes("\0")) throw new Error("Graph memory summary must not contain NUL characters");
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
    Object.keys(node).every((key) => nodeFields.has(key)) &&
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
    Object.keys(relation).every((key) => relationFields.has(key)) &&
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
    raw = await readBoundedFile(filePath, maxFileBytes, "Graph memory file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nodes: [], relations: [] };
    throw error;
  }
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
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > maxFileBytes) throw new Error(`Graph memory file exceeds its ${maxFileBytes}-byte limit`);
  await mkdir(dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, payload, { encoding: "utf8", mode: 0o600 });
}

function graphLockOwnerIsAlive(value: unknown): boolean | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pid = (value as Record<string, unknown>).pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
  }
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function reclaimStaleGraphLock(lockPath: string, lockMetadata: Awaited<ReturnType<typeof lstat>>): Promise<boolean> {
  if (Date.now() - Number(lockMetadata.mtimeMs) <= staleLockMs) return false;
  let directory;
  try {
    directory = await opendir(lockPath, { bufferSize: 1 });
  } catch {
    return false;
  }
  let ownerName: string | undefined;
  try {
    const owner = await directory.read();
    const extra = await directory.read();
    if (owner === null || extra !== null || !/^[a-z0-9-]{1,64}\.owner$/iu.test(owner.name)) return false;
    ownerName = owner.name;
  } finally {
    await directory.close().catch(() => undefined);
  }
  const ownerPath = resolve(lockPath, ownerName);
  let ownerMetadata;
  try {
    ownerMetadata = await lstat(ownerPath);
    if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || Date.now() - Number(ownerMetadata.mtimeMs) <= staleLockMs) return false;
    const owner = JSON.parse(await readBoundedTextFile(ownerPath, maxLockOwnerBytes, "Graph memory lock owner")) as unknown;
    if (graphLockOwnerIsAlive(owner) === true) return false;
    const [currentLockMetadata, currentOwnerMetadata] = await Promise.all([lstat(lockPath), lstat(ownerPath)]);
    if (!sameFile(lockMetadata, currentLockMetadata) || !sameFile(ownerMetadata, currentOwnerMetadata)) return false;
    await unlink(ownerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (!(error instanceof SyntaxError)) return false;
    const [currentLockMetadata, currentOwnerMetadata] = await Promise.all([lstat(lockPath), lstat(ownerPath)]).catch(() => []);
    if (currentLockMetadata === undefined || currentOwnerMetadata === undefined) return false;
    if (!sameFile(lockMetadata, currentLockMetadata) || ownerMetadata === undefined || !sameFile(ownerMetadata, currentOwnerMetadata)) return false;
    await unlink(ownerPath).catch(() => undefined);
  }
  try {
    await rmdir(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function acquireGraphLock(lockPath: string, signal: AbortSignal): Promise<() => Promise<void>> {
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
    throwIfAborted(signal);
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const token = randomUUID();
      const ownerPath = resolve(lockPath, `${token}.owner`);
      try {
        await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        await rmdir(lockPath).catch(() => undefined);
        throw new Error("Could not establish graph memory lock ownership", { cause: error });
      }
      return async () => {
        try {
          await unlink(ownerPath);
        } catch (error) {
          throw new Error("Graph memory lock ownership was lost before release", { cause: error });
        }
        try {
          await rmdir(lockPath);
        } catch (error) {
          throw new Error("Could not safely release graph memory file lock", { cause: error });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Could not acquire graph memory file lock", { cause: error });
      let metadata;
      try {
        metadata = await lstat(lockPath);
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("Could not inspect graph memory file lock", { cause: inspectionError });
      }
      if (metadata.isSymbolicLink()) throw new Error("Graph memory file lock must not be a symbolic link", { cause: error });
      if (!metadata.isDirectory()) throw new Error("Graph memory file lock must be a directory", { cause: error });
      if (await reclaimStaleGraphLock(lockPath, metadata)) continue;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for graph memory file lock", { cause: error });
      await waitForLockRetry(signal);
    }
  }
}

export default {
  name: "pi-graph-memory",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: GraphMemoryPluginConfig) {
    const filePath = normalizeFilePath(context.piHarnessLaunch.agentDir, config.fileName);
    const nodeLimit = boundedInteger(config.maxNodes, absoluteNodeLimit, absoluteNodeLimit);
    const relationLimit = boundedInteger(config.maxRelations, absoluteRelationLimit, absoluteRelationLimit);
    let nodes: GraphNode[] = [];
    let relations: GraphRelation[] = [];
    let loaded = false;
    let loading: Promise<void> | undefined;
    let mutationQueue = Promise.resolve();
    let lastSearch: GraphSearchReport | undefined;
    const lifecycle = new AbortController();

    const load = async (): Promise<void> => {
      if (loaded) return;
      if (loading !== undefined) return loading;
      const pending = (async () => {
        const state = await readGraphFile(filePath, nodeLimit, relationLimit);
        nodes = state.nodes;
        relations = state.relations;
        loaded = true;
      })();
      loading = pending;
      try {
        await pending;
      } finally {
        if (loading === pending) loading = undefined;
      }
    };

    const mutate = async <T>(operation: (state: GraphState) => T, signal: AbortSignal): Promise<T> => {
      throwIfAborted(signal);
      let result: T | undefined;
      const run = async (): Promise<void> => {
        throwIfAborted(signal);
        const release = await acquireGraphLock(`${filePath}.lock`, signal);
        try {
          const state = await readGraphFile(filePath, nodeLimit, relationLimit);
          throwIfAborted(signal);
          result = operation(state);
          throwIfAborted(signal);
          await writeGraphFile(filePath, state);
          nodes = state.nodes;
          relations = state.relations;
          loaded = true;
          lastSearch = undefined;
        } finally {
          await release();
        }
      };
      const scheduled = mutationQueue.catch(() => undefined).then(run);
      mutationQueue = scheduled.then(
        () => undefined,
        () => undefined,
      );
      await withCancellation(scheduled, signal);
      return result as T;
    };

    const recordTool = defineTool({
      name: "graph_memory_record",
      label: "Record graph memory",
      description: "Persist or update one typed task, skill, or event node with explicit provenance in the local graph memory.",
      promptSnippet: "record durable typed knowledge in the local graph memory",
      parameters: Type.Object(
        {
          kind: Type.Union([Type.Literal("task"), Type.Literal("skill"), Type.Literal("event")]),
          label: Type.String(),
          summary: Type.String(),
          source: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<GraphNode>> {
        const params = recordParameters(rawParams);
        const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
        throwIfAborted(operationSignal);
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
        }, operationSignal);
        return { content: [{ type: "text", text: `Graph memory recorded: ${node.id} [${node.kind}] ${node.label}` }], details: cloneNode(node) };
      },
    });

    const linkTool = defineTool({
      name: "graph_memory_link",
      label: "Link graph memories",
      description: "Create one typed directed relation between two existing graph-memory nodes.",
      promptSnippet: "link two graph memories with a typed relation",
      parameters: Type.Object(
        {
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
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<GraphRelation>> {
        const params = linkParameters(rawParams);
        const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
        throwIfAborted(operationSignal);
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
        }, operationSignal);
        return {
          content: [{ type: "text", text: `Graph relation ${relation.id} ${relation.relation}: ${relation.from} → ${relation.to}` }],
          details: cloneRelation(relation),
        };
      },
    });

    const searchTool = defineTool({
      name: "graph_memory_search",
      label: "Search graph memory",
      description: "Search typed graph-memory nodes by label, summary, provenance, kind, or connected relation.",
      promptSnippet: "search the local cross-session knowledge graph",
      parameters: Type.Object(
        {
          query: Type.String(),
          kind: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("skill"), Type.Literal("event")])),
          limit: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<GraphSearchReport>> {
        const params = searchParameters(rawParams);
        const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
        throwIfAborted(operationSignal);
        await load();
        throwIfAborted(operationSignal);
        const query = normalizeText(params.query, "Graph memory query", maxQueryLength);
        if (query.length < 2) throw new Error(`Graph memory query must contain 2-${maxQueryLength} characters`);
        const needle = query.toLocaleLowerCase();
        const limit = boundedInteger(params.limit, 12, maxSearchResults);
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
        const report = { query, total: ranked.length, nodes: matches.map(cloneNode), relations: matchedRelations.map(cloneRelation) };
        lastSearch = cloneSearchReport(report);
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
          details: cloneSearchReport(report),
        };
      },
    });

    const forgetTool = defineTool({
      name: "graph_memory_forget",
      label: "Forget graph memory",
      description: "Delete one graph-memory node and all incident relations after explicit confirmation.",
      promptSnippet: "forget a graph memory after confirmation",
      parameters: Type.Object({ id: Type.String(), confirm: Type.Boolean() }, { additionalProperties: false }),
      executionMode: "sequential",
      async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<{ id: string; removed: boolean; removedRelations: number }>> {
        const params = forgetParameters(rawParams);
        const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
        throwIfAborted(operationSignal);
        const id = normalizeText(params.id, "Graph memory node id", maxLabelLength);
        if (params.confirm !== true) throw new Error("Deleting a graph memory requires confirm=true");
        const result = await mutate((state) => {
          const beforeNodes = state.nodes.length;
          const beforeRelations = state.relations.length;
          state.nodes = state.nodes.filter((node) => node.id !== id);
          state.relations = state.relations.filter((relation) => relation.from !== id && relation.to !== id);
          return { id, removed: state.nodes.length !== beforeNodes, removedRelations: beforeRelations - state.relations.length };
        }, operationSignal);
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
          pluginId: "@pi-harness/plugin-graph-memory",
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
              recent: nodes.slice(0, 8).map(cloneNode),
              recentRelations: relations.slice(0, 8).map((relation) => ({
                ...relation,
                fromLabel: nodes.find((node) => node.id === relation.from)?.label ?? relation.from,
                toLabel: nodes.find((node) => node.id === relation.to)?.label ?? relation.to,
              })),
              lastSearch: lastSearch === undefined ? null : cloneSearchReport(lastSearch),
              limits: { nodes: nodeLimit, relations: relationLimit, fileBytes: maxFileBytes, searchResults: maxSearchResults },
            };
          },
        }),
      );
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Graph memory plugin disposed"));
      for (const dispose of disposers.reverse()) dispose();
    });
  },
};
