import { lstat, mkdir, opendir, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWriteFile, readBoundedTextFile } from "@pi-harness/plugin-api";

const defaultFileName = "memory.json";
const maxKeyLength = 128;
const maxValueBytes = 64 * 1024;
const maxTagLength = 64;
const maxTags = 16;
const maxEntries = 500;
const maxPanelMemories = 8;
const maxSearchItems = 8;
const maxSearchPageBytes = 128 * 1024;
const maxSearchValueBytes = 8 * 1024;
const lockRetryMs = 25;
const lockTimeoutMs = 10_000;
const staleLockMs = 30_000;
const maxLockOwnerBytes = 1024;
const memoryFileOverheadBytes = 1024;
const memoryEntryOverheadBytes = maxValueBytes * 6 + maxTags * maxTagLength * 6 + maxKeyLength * 12 + 8 * 1024;
const memoryKeys = new Set(["id", "key", "value", "tags", "createdAt", "updatedAt"]);

type Memory = { id: string; key: string; value: string; tags: string[]; createdAt: string; updatedAt: string };
type MemoryFile = { version: 1; memories: Memory[] };
type LastMemorySearchReport = { query: string; total: number; memories: Memory[] };
type MemorySearchItem = Memory & { valueBytes: number; shownValueBytes: number; valueTruncated: boolean };
type MemorySearchReport = {
  query: string;
  total: number;
  offset: number;
  shown: number;
  truncated: boolean;
  nextOffset: number | null;
  memories: MemorySearchItem[];
};

export interface MemoryPluginConfig {
  fileName?: string;
  maxEntries?: number;
}

export const Config: z<MemoryPluginConfig> = z.object({ fileName: z.string().default(defaultFileName), maxEntries: z.number().default(maxEntries) });

function normalizeFilePath(agentDir: string, fileName: string | undefined): string {
  const name = (fileName ?? defaultFileName).trim();
  if (name === "" || basename(name) !== name || !name.toLowerCase().endsWith(".json")) throw new Error("Memory fileName must be a single .json filename");
  return resolve(agentDir, name);
}

function normalizeKey(key: string): string {
  const value = key.trim();
  if (value.length === 0 || value.length > maxKeyLength) throw new Error(`Memory key must contain 1-${maxKeyLength} characters`);
  return value;
}

function normalizeValue(value: string): string {
  if (value.length > maxValueBytes || value.trim() === "" || Buffer.byteLength(value, "utf8") > maxValueBytes)
    throw new Error(`Memory value must be non-empty and at most ${maxValueBytes} bytes`);
  return value;
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  const values = [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  if (values.length > maxTags || values.some((tag) => tag.length > maxTagLength))
    throw new Error(`Memory tags must contain at most ${maxTags} entries of ${maxTagLength} characters`);
  return values;
}

function ownData(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
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

function isMemory(value: unknown): value is Memory {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
  } catch {
    return false;
  }
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== memoryKeys.size ||
      Reflect.ownKeys(descriptors).some((name) => typeof name !== "string" || !memoryKeys.has(name) || !("value" in descriptors[name]!))
    )
      return false;
  } catch {
    return false;
  }
  const id = ownData(value, "id");
  const key = ownData(value, "key");
  const storedValue = ownData(value, "value");
  const tags = ownData(value, "tags");
  const createdAt = ownData(value, "createdAt");
  const updatedAt = ownData(value, "updatedAt");
  const created = canonicalTimestamp(createdAt);
  const updated = canonicalTimestamp(updatedAt);
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= maxKeyLength &&
    id === id.trim() &&
    typeof key === "string" &&
    key.trim().length > 0 &&
    key.length <= maxKeyLength &&
    key === key.trim() &&
    typeof storedValue === "string" &&
    storedValue.length <= maxValueBytes &&
    storedValue.trim().length > 0 &&
    Buffer.byteLength(storedValue, "utf8") <= maxValueBytes &&
    Array.isArray(tags) &&
    tags.length <= maxTags &&
    tags.every((tag) => typeof tag === "string" && tag.trim().length > 0 && tag.length <= maxTagLength && tag === tag.trim()) &&
    new Set(tags).size === tags.length &&
    created !== undefined &&
    updated !== undefined &&
    updated.milliseconds >= created.milliseconds
  );
}

async function readMemoryFile(filePath: string): Promise<Memory[]> {
  let source: string;
  try {
    const maxFileBytes = memoryFileOverheadBytes + maxEntries * memoryEntryOverheadBytes;
    source = await readBoundedTextFile(filePath, maxFileBytes, "Memory file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("Memory file contains invalid JSON", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Memory file has an unsupported format");
  const file = parsed as Partial<MemoryFile>;
  const fileMemories = file.memories;
  if (Object.getPrototypeOf(file) !== Object.prototype || Object.keys(file).length !== 2 || file.version !== 1 || !Array.isArray(fileMemories))
    throw new Error("Memory file has an unsupported format");
  if (!fileMemories.every(isMemory)) throw new Error("Memory file contains invalid memories");
  if (fileMemories.some((memory, index) => index > 0 && Date.parse(fileMemories[index - 1]!.updatedAt) < Date.parse(memory.updatedAt)))
    throw new Error("Memory file contains invalid memories");
  // Read the complete bounded store before applying the configured retention limit so mutations can preserve record identities and report every eviction.
  if (fileMemories.length > maxEntries) throw new Error(`Memory file exceeds its ${maxEntries}-entry limit`);
  const keys = new Set(fileMemories.map((memory) => memory.key));
  const ids = new Set(fileMemories.map((memory) => memory.id));
  if (keys.size !== fileMemories.length || ids.size !== fileMemories.length) throw new Error("Memory file contains duplicate memories");
  return fileMemories;
}

async function writeMemoryFile(filePath: string, memories: Memory[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const payload = JSON.stringify({ version: 1, memories } satisfies MemoryFile, null, 2);
  await atomicWriteFile(filePath, payload, { encoding: "utf8", mode: 0o600, signal });
}

function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Memory operation cancelled", { cause: signal.reason }));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function nextUpdatedAt(memories: readonly Memory[]): string {
  const previous = memories.reduce((latest, memory) => Math.max(latest, Date.parse(memory.updatedAt)), Number.NEGATIVE_INFINITY);
  const wallClock = Date.now();
  if (!Number.isFinite(wallClock)) throw new Error("Memory wall clock is invalid");
  const milliseconds = previous === Number.NEGATIVE_INFINITY ? wallClock : Math.max(wallClock, previous + 1);
  try {
    return new Date(milliseconds).toISOString();
  } catch (error) {
    throw new Error("Memory timestamp sequence is exhausted", { cause: error });
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

function searchItem(memory: Memory): MemorySearchItem {
  const valueBytes = Buffer.byteLength(memory.value, "utf8");
  const value = truncateUtf8(memory.value, maxSearchValueBytes);
  const shownValueBytes = Buffer.byteLength(value, "utf8");
  return { ...memory, value, valueBytes, shownValueBytes, valueTruncated: shownValueBytes < valueBytes };
}

function searchPageOptions(rawOffset: unknown, rawLimit: unknown): { offset: number; limit: number } {
  const offset = rawOffset === undefined ? 0 : rawOffset;
  const limit = rawLimit === undefined ? maxSearchItems : rawLimit;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > maxEntries)
    throw new Error(`Memory search offset must be an integer from 0 to ${maxEntries}`);
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > maxSearchItems)
    throw new Error(`Memory search limit must be an integer from 1 to ${maxSearchItems}`);
  return { offset, limit };
}

function searchPage(query: string, results: readonly Memory[], options: { offset: number; limit: number }): MemorySearchReport {
  const { offset, limit } = options;
  const memories: MemorySearchItem[] = [];
  const report = (): MemorySearchReport => {
    const nextOffset = offset + memories.length < results.length ? offset + memories.length : null;
    return { query, total: results.length, offset, shown: memories.length, truncated: nextOffset !== null, nextOffset, memories };
  };
  for (const memory of results.slice(offset, offset + limit)) {
    memories.push(searchItem(memory));
    if (Buffer.byteLength(JSON.stringify(report()), "utf8") > maxSearchPageBytes) {
      memories.pop();
      break;
    }
  }
  if (offset < results.length && memories.length === 0) throw new Error("Memory search result exceeds the model-visible page limit");
  return report();
}

function memoryLockOwnerIsAlive(value: unknown): boolean | undefined {
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

async function reclaimStaleMemoryLock(lockPath: string, lockMetadata: Awaited<ReturnType<typeof lstat>>): Promise<boolean> {
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
  } catch {
    return false;
  }
  if (!ownerMetadata.isFile() || ownerMetadata.isSymbolicLink() || Date.now() - Number(ownerMetadata.mtimeMs) <= staleLockMs) return false;
  let owner: unknown;
  try {
    owner = JSON.parse(await readBoundedTextFile(ownerPath, maxLockOwnerBytes, "Memory lock owner")) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) return false;
  }
  if (memoryLockOwnerIsAlive(owner) === true) return false;
  let currentLockMetadata;
  let currentOwnerMetadata;
  try {
    [currentLockMetadata, currentOwnerMetadata] = await Promise.all([lstat(lockPath), lstat(ownerPath)]);
  } catch {
    return false;
  }
  if (!sameFile(lockMetadata, currentLockMetadata) || !sameFile(ownerMetadata, currentOwnerMetadata)) return false;
  try {
    await unlink(ownerPath);
    await rmdir(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function acquireMemoryLock(lockPath: string, signal: AbortSignal): Promise<() => Promise<void>> {
  signal.throwIfAborted();
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAt = performance.now();
  while (true) {
    signal.throwIfAborted();
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const token = randomUUID();
      const ownerPath = resolve(lockPath, `${token}.owner`);
      try {
        await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        await rmdir(lockPath).catch(() => undefined);
        throw new Error("Could not establish memory lock ownership", { cause: error });
      }
      return async () => {
        try {
          await unlink(ownerPath);
        } catch (error) {
          throw new Error("Memory lock ownership was lost before release", { cause: error });
        }
        try {
          await rmdir(lockPath);
        } catch (error) {
          throw new Error("Could not safely release memory file lock", { cause: error });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Could not acquire memory file lock", { cause: error });
      let metadata;
      try {
        metadata = await lstat(lockPath);
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("Could not inspect memory file lock", { cause: inspectionError });
      }
      if (metadata.isSymbolicLink()) throw new Error("Memory file lock must not be a symbolic link", { cause: error });
      if (!metadata.isDirectory()) throw new Error("Memory file lock must be a directory", { cause: error });
      if (await reclaimStaleMemoryLock(lockPath, metadata)) continue;
      if (performance.now() - startedAt >= lockTimeoutMs) throw new Error("Timed out waiting for memory file lock", { cause: error });
      await delay(lockRetryMs, undefined, { signal });
    }
  }
}

export default {
  name: "pi-memory",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: MemoryPluginConfig) {
    const filePath = normalizeFilePath(context.piHarnessLaunch.agentDir, config.fileName);
    const configuredEntryLimit = config.maxEntries;
    const entryLimit =
      typeof configuredEntryLimit === "number" && Number.isFinite(configuredEntryLimit)
        ? Math.max(1, Math.min(maxEntries, Math.trunc(configuredEntryLimit)))
        : maxEntries;
    const lifecycle = new AbortController();
    const operationSignal = (signal?: AbortSignal) => (signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]));
    let memories: Memory[] = [];
    let mutationQueue = Promise.resolve();
    let last: LastMemorySearchReport | undefined;
    const refresh = async (signal: AbortSignal = lifecycle.signal): Promise<void> => {
      signal.throwIfAborted();
      const current = await readMemoryFile(filePath);
      signal.throwIfAborted();
      memories = current.slice(0, entryLimit);
    };
    const mutate = async <T>(operation: (current: Memory[]) => { memories: Memory[]; result: T }, signal: AbortSignal): Promise<T> => {
      signal.throwIfAborted();
      let result: T | undefined;
      const run = async (): Promise<void> => {
        const release = await acquireMemoryLock(`${filePath}.lock`, signal);
        try {
          const current = await readMemoryFile(filePath);
          signal.throwIfAborted();
          const next = operation(current);
          await writeMemoryFile(filePath, next.memories, signal);
          memories = next.memories.slice(0, entryLimit);
          result = next.result;
        } finally {
          await release();
        }
      };
      mutationQueue = mutationQueue.catch(() => undefined).then(run);
      await withCancellation(mutationQueue, signal);
      return result as T;
    };
    const unregisterSet = context.piTools.register(
      defineTool({
        name: "memory_set",
        label: "Remember fact",
        description: "Persist one explicit fact in the Pi Harness memory store, replacing an existing value with the same key.",
        promptSnippet: "save an explicit fact for future sessions",
        parameters: Type.Object({ key: Type.String(), value: Type.String(), tags: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<Memory>> {
          const currentSignal = operationSignal(signal);
          currentSignal.throwIfAborted();
          const key = normalizeKey(params.key);
          const value = normalizeValue(params.value);
          const tags = normalizeTags(params.tags);
          const saved = await mutate((current) => {
            const now = nextUpdatedAt(current);
            const existing = current.find((item) => item.key === key);
            const next: Memory =
              existing === undefined ? { id: randomUUID(), key, value, tags, createdAt: now, updatedAt: now } : { ...existing, value, tags, updatedAt: now };
            const ordered = [next, ...current.filter((item) => item.key !== key)];
            return { memories: ordered.slice(0, entryLimit), result: { memory: next, evicted: ordered.slice(entryLimit).map((item) => item.key) } };
          }, currentSignal);
          const text =
            saved.evicted.length === 0
              ? `Memory saved: ${key}`
              : `Memory saved: ${key} (evicted ${saved.evicted.join(", ")} to stay within ${entryLimit} entries)`;
          return { content: [{ type: "text", text }], details: structuredClone(saved.memory) };
        },
      }),
    );
    const unregisterSearch = context.piTools.register(
      defineTool({
        name: "memory_search",
        label: "Search memories",
        description: "Search explicit cross-session memories by key, value, or tag in bounded pages; follow nextOffset until it is null.",
        promptSnippet: "search remembered facts from earlier sessions",
        parameters: Type.Object(
          {
            query: Type.String(),
            offset: Type.Optional(Type.Integer({ minimum: 0, maximum: maxEntries, description: "Search page offset; follow nextOffset for more matches" })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: maxSearchItems, description: `Maximum results per page, default ${maxSearchItems}` })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<MemorySearchReport>> {
          const currentSignal = operationSignal(signal);
          await refresh(currentSignal);
          const query = params.query.trim().toLocaleLowerCase();
          if (query.length < 1 || query.length > maxKeyLength) throw new Error(`Memory search query must contain 1-${maxKeyLength} characters`);
          const pageOptions = searchPageOptions(params.offset, params.limit);
          const results = memories.filter((item) => [item.key, item.value, ...item.tags].some((field) => field.toLocaleLowerCase().includes(query)));
          const displayQuery = params.query.trim();
          const page = searchPage(displayQuery, results, pageOptions);
          last = { query: displayQuery, total: results.length, memories: results };
          return {
            content: [{ type: "text", text: JSON.stringify(page) }],
            details: structuredClone(page),
          };
        },
      }),
    );
    const unregisterDelete = context.piTools.register(
      defineTool({
        name: "memory_delete",
        label: "Forget memory",
        description: "Delete one explicit memory by key. Confirmation is required.",
        promptSnippet: "forget a stored memory after confirmation",
        parameters: Type.Object({ key: Type.String(), confirm: Type.Boolean() }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ key: string; removed: boolean }>> {
          const currentSignal = operationSignal(signal);
          currentSignal.throwIfAborted();
          const key = normalizeKey(params.key);
          if (params.confirm !== true) throw new Error("Deleting a memory requires confirm=true");
          const removed = await mutate((current) => {
            const next = current.filter((item) => item.key !== key);
            return { memories: next, result: next.length !== current.length };
          }, currentSignal);
          return { content: [{ type: "text", text: removed ? `Memory deleted: ${key}` : `Memory not found: ${key}` }], details: { key, removed } };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "memory-panel",
        pluginId: "@pi-harness/plugin-memory",
        title: "Memory",
        description: "只保存 Agent 明确写入的事实，跨会话持久化并支持检索与删除。",
        icon: "▣",
        read: async () => {
          await refresh();
          const recent = memories.slice(0, maxPanelMemories);
          const panelLast =
            last === undefined
              ? null
              : {
                  query: last.query,
                  total: last.total,
                  shown: Math.min(last.memories.length, maxPanelMemories),
                  truncated: last.memories.length > maxPanelMemories,
                  memories: last.memories.slice(0, maxPanelMemories),
                };
          return structuredClone({
            filePath,
            count: memories.length,
            shown: recent.length,
            truncated: memories.length > recent.length,
            last: panelLast,
            memories: recent,
          });
        },
      });
    } catch (error) {
      unregisterSet();
      unregisterSearch();
      unregisterDelete();
      throw error;
    }
    context.effect(() => async () => {
      lifecycle.abort(new Error("Memory plugin is disposed"));
      unregisterSet();
      unregisterSearch();
      unregisterDelete();
      disposePanel();
      await mutationQueue.catch(() => undefined);
    });
  },
};
