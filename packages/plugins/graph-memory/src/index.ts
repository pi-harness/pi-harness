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
const maxSearchResponseBytes = 128 * 1024;
const searchRelationReserveBytes = 16 * 1024;
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
type GraphSearchReport = {
  query: string;
  total: number;
  nodes: GraphNode[];
  relations: GraphRelation[];
  offset: number;
  nextOffset: number | null;
  nodesTruncated: boolean;
  relationsOffset: number;
  relationsTotal: number;
  nextRelationsOffset: number | null;
  relationsTruncated: boolean;
};
type GraphState = Pick<GraphFile, "nodes" | "relations">;
type RecordParameters = { kind: NodeKind; label: string; summary: string; source?: string };
type LinkParameters = { from: string; to: string; relation: RelationKind };
type SearchParameters = { query: string; kind?: NodeKind; limit?: number; offset?: number; relationsOffset?: number };
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
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.size || keys.some((key) => typeof key !== "string" || !allowed.has(key))) throw new Error(`${field} contains an unknown property`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
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
  const descriptors = dataDescriptors(value, "Graph memory search parameters", new Set(["query", "kind", "limit", "offset", "relationsOffset"]));
  const query: unknown = descriptors.query?.value;
  const kind: unknown = descriptors.kind?.value;
  const limit: unknown = descriptors.limit?.value;
  if (typeof query !== "string") throw new Error("Graph memory query must be a string");
  if (kind !== undefined && !isNodeKind(kind)) throw new Error("Graph memory search kind must be task, skill, or event");
  if (limit !== undefined && typeof limit !== "number") throw new Error("Graph memory search limit must be a number");
  const offset = searchOffset(descriptors.offset?.value, "offset", absoluteNodeLimit);
  const relationsOffset = searchOffset(descriptors.relationsOffset?.value, "relationsOffset", absoluteRelationLimit);
  return { query, ...(kind === undefined ? {} : { kind }), ...(limit === undefined ? {} : { limit }), offset, relationsOffset };
}

function searchOffset(value: unknown, name: string, maximum: number): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`Graph memory ${name} must be an integer from 0 to ${maximum}`);
  return value;
}

function searchPage(query: string, ranked: GraphNode[], allRelations: GraphRelation[], params: SearchParameters, limit: number): GraphSearchReport {
  const offset = params.offset ?? 0;
  const relationsOffset = params.relationsOffset ?? 0;
  const report: GraphSearchReport = {
    query,
    total: ranked.length,
    nodes: [],
    relations: [],
    offset,
    nextOffset: null,
    nodesTruncated: false,
    // Node selection must not change when only the relation cursor changes.
    relationsOffset: absoluteRelationLimit,
    relationsTotal: 0,
    nextRelationsOffset: null,
    relationsTruncated: false,
  };
  const bytes = () => Buffer.byteLength(JSON.stringify(report), "utf8");
  for (const node of ranked.slice(offset, offset + limit)) {
    report.nodes.push(cloneNode(node));
    if (bytes() > maxSearchResponseBytes - searchRelationReserveBytes) {
      report.nodes.pop();
      if (report.nodes.length === 0) throw new Error("Graph memory node exceeds the search page byte limit; inspect its stored metadata");
      break;
    }
  }
  const end = offset + report.nodes.length;
  report.relationsOffset = relationsOffset;
  report.nextOffset = end < ranked.length ? end : null;
  report.nodesTruncated = report.nextOffset !== null;
  const ids = new Set(report.nodes.map((node) => node.id));
  const incident = allRelations.filter((relation) => ids.has(relation.from) || ids.has(relation.to));
  report.relationsTotal = incident.length;
  // Reserve the worst-case continuation metadata before byte checks.
  report.nextRelationsOffset = absoluteRelationLimit;
  report.relationsTruncated = false;
  for (const relation of incident.slice(relationsOffset, relationsOffset + limit * 4)) {
    report.relations.push(cloneRelation(relation));
    if (bytes() > maxSearchResponseBytes) {
      report.relations.pop();
      if (report.relations.length === 0) throw new Error("Graph memory relation exceeds the search page byte limit; inspect its stored metadata");
      break;
    }
  }
  const relationEnd = relationsOffset + report.relations.length;
  report.nextRelationsOffset = relationEnd < incident.length ? relationEnd : null;
  report.relationsTruncated = report.nextRelationsOffset !== null;
  if (bytes() > maxSearchResponseBytes) throw new Error("Graph memory search page exceeds its byte limit");
  return report;
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
  if (value.length > maxSummaryBytes) throw new Error(`Graph memory summary must be non-empty and at most ${maxSummaryBytes} bytes`);
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

function canonicalTimestamp(value: unknown): { text: string; milliseconds: number } | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString() === value ? { text: value, milliseconds } : undefined;
  } catch {
    return undefined;
  }
}

function ownDataRecord(value: unknown, allowed: ReadonlySet<string>, required: ReadonlySet<string>): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length < required.size ||
      keys.length > allowed.size ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      [...required].some((key) => !keys.includes(key))
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

const requiredNodeFields = new Set(["id", "kind", "label", "summary", "createdAt", "updatedAt"]);

function isGraphNode(value: unknown): value is GraphNode {
  const node = ownDataRecord(value, nodeFields, requiredNodeFields);
  if (node === undefined) return false;
  const created = canonicalTimestamp(node.createdAt);
  const updated = canonicalTimestamp(node.updatedAt);
  return (
    typeof node.id === "string" &&
    node.id.length > 0 &&
    node.id.length <= maxLabelLength &&
    !node.id.includes("\0") &&
    node.id === node.id.trim() &&
    isNodeKind(node.kind) &&
    typeof node.label === "string" &&
    node.label.trim().length > 0 &&
    node.label.length <= maxLabelLength &&
    !node.label.includes("\0") &&
    node.label === node.label.trim() &&
    typeof node.summary === "string" &&
    node.summary.length <= maxSummaryBytes &&
    node.summary.trim().length > 0 &&
    !node.summary.includes("\0") &&
    node.summary === node.summary.trim() &&
    Buffer.byteLength(node.summary, "utf8") <= maxSummaryBytes &&
    (node.source === undefined || typeof node.source === "string") &&
    (node.source === undefined ||
      (node.source.trim().length > 0 && node.source.length <= maxSourceLength && !node.source.includes("\0") && node.source === node.source.trim())) &&
    created !== undefined &&
    updated !== undefined &&
    updated.milliseconds >= created.milliseconds
  );
}

function isGraphRelation(value: unknown): value is GraphRelation {
  const relation = ownDataRecord(value, relationFields, relationFields);
  if (relation === undefined) return false;
  return (
    typeof relation.id === "string" &&
    relation.id.length > 0 &&
    relation.id.length <= maxLabelLength &&
    !relation.id.includes("\0") &&
    relation.id === relation.id.trim() &&
    typeof relation.from === "string" &&
    relation.from.length > 0 &&
    relation.from.length <= maxLabelLength &&
    !relation.from.includes("\0") &&
    relation.from === relation.from.trim() &&
    typeof relation.to === "string" &&
    relation.to.length > 0 &&
    relation.to.length <= maxLabelLength &&
    !relation.to.includes("\0") &&
    relation.to === relation.to.trim() &&
    isRelationKind(relation.relation) &&
    canonicalTimestamp(relation.createdAt) !== undefined
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
  const parsed: unknown = JSON.parse(raw.toString("utf8"));
  const fileKeys = new Set(["version", "nodes", "relations"]);
  const file = ownDataRecord(parsed, fileKeys, fileKeys);
  if (file === undefined || file.version !== 1 || !Array.isArray(file.nodes) || !Array.isArray(file.relations))
    throw new Error("Graph memory file has an unsupported format");
  if (!file.nodes.every(isGraphNode)) throw new Error("Graph memory file contains invalid nodes");
  if (!file.relations.every(isGraphRelation)) throw new Error("Graph memory file contains invalid relations");
  const fileNodes = file.nodes;
  const fileRelations = file.relations;
  if (fileNodes.length > nodeLimit) throw new Error(`Graph memory file exceeds its ${nodeLimit}-node limit`);
  if (fileRelations.length > relationLimit) throw new Error(`Graph memory file exceeds its ${relationLimit}-relation limit`);
  if (fileNodes.some((node, index) => index > 0 && Date.parse(fileNodes[index - 1]!.updatedAt) < Date.parse(node.updatedAt)))
    throw new Error("Graph memory file contains invalid nodes");
  if (fileRelations.some((relation, index) => index > 0 && Date.parse(fileRelations[index - 1]!.createdAt) < Date.parse(relation.createdAt)))
    throw new Error("Graph memory file contains invalid relations");
  const nodeIds = new Set(fileNodes.map((node) => node.id));
  const relationIds = new Set<string>();
  const semanticRelations = new Set<string>();
  for (const relation of fileRelations) {
    if (!nodeIds.has(relation.from) || !nodeIds.has(relation.to)) throw new Error("Graph memory file contains relations with missing nodes");
    if (relation.from === relation.to) throw new Error("Graph memory file contains self-relations");
    if (relationIds.has(relation.id)) throw new Error("Graph memory file contains duplicate relation ids");
    const semanticId = `${relation.from}\0${relation.to}\0${relation.relation}`;
    if (semanticRelations.has(semanticId)) throw new Error("Graph memory file contains duplicate relations");
    relationIds.add(relation.id);
    semanticRelations.add(semanticId);
  }
  if (nodeIds.size !== fileNodes.length) throw new Error("Graph memory file contains duplicate node ids");
  return { nodes: fileNodes, relations: fileRelations };
}

function nextGraphTimestamp(state: GraphState): string {
  const previous = Math.max(
    ...state.nodes.flatMap((node) => [Date.parse(node.createdAt), Date.parse(node.updatedAt)]),
    ...state.relations.map((relation) => Date.parse(relation.createdAt)),
    Number.NEGATIVE_INFINITY,
  );
  const wallClock = Date.now();
  if (!Number.isFinite(wallClock)) throw new Error("Graph memory wall clock is invalid");
  const milliseconds = previous === Number.NEGATIVE_INFINITY ? wallClock : Math.max(wallClock, previous + 1);
  try {
    return new Date(milliseconds).toISOString();
  } catch (error) {
    throw new Error("Graph memory timestamp sequence is exhausted", { cause: error });
  }
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
  const startedAt = performance.now();
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
      if (performance.now() - startedAt >= lockTimeoutMs) throw new Error("Timed out waiting for graph memory file lock", { cause: error });
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
    let mutationQueue = Promise.resolve();
    let lastSearch: GraphSearchReport | undefined;
    const lifecycle = new AbortController();

    const load = async (): Promise<void> => {
      const pending = mutationQueue.then(async () => {
        const state = await readGraphFile(filePath, nodeLimit, relationLimit);
        if (lastSearch !== undefined && JSON.stringify({ nodes, relations }) !== JSON.stringify(state)) lastSearch = undefined;
        nodes = state.nodes;
        relations = state.relations;
      });
      mutationQueue = pending.then(
        () => undefined,
        () => undefined,
      );
      await pending;
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
          const now = nextGraphTimestamp(state);
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
          const next: GraphRelation = { id: randomUUID(), from, to, relation: params.relation, createdAt: nextGraphTimestamp(state) };
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
          offset: Type.Optional(Type.Integer({ minimum: 0, maximum: absoluteNodeLimit, description: "Node page offset; use nextOffset to continue" })),
          relationsOffset: Type.Optional(
            Type.Integer({
              minimum: 0,
              maximum: absoluteRelationLimit,
              description: "Relation page offset for the same query, kind, limit and node offset; use nextRelationsOffset",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<GraphSearchReport>> {
        const params = searchParameters(rawParams);
        const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
        throwIfAborted(operationSignal);
        await withCancellation(load(), operationSignal);
        throwIfAborted(operationSignal);
        const query = normalizeText(params.query, "Graph memory query", maxQueryLength);
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
          .sort((left, right) => right.score - left.score || Date.parse(right.node.updatedAt) - Date.parse(left.node.updatedAt));
        const report = searchPage(
          query,
          ranked.map((match) => match.node),
          relations,
          params,
          limit,
        );
        lastSearch = cloneSearchReport(report);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(report),
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
