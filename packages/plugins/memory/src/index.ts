import { lstat, mkdir, opendir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { readBoundedTextFile } from "@pi-harness/plugin-api";

const defaultFileName = "memory.json";
const maxKeyLength = 128;
const maxValueBytes = 64 * 1024;
const maxTagLength = 64;
const maxTags = 16;
const maxEntries = 500;
const lockRetryMs = 25;
const lockTimeoutMs = 10_000;
const staleLockMs = 30_000;
const maxLockOwnerBytes = 1024;
const memoryFileOverheadBytes = 1024;
const memoryEntryOverheadBytes = maxValueBytes + maxTags * maxTagLength * 4 + maxKeyLength * 8 + 8 * 1024;

type Memory = { id: string; key: string; value: string; tags: string[]; createdAt: string; updatedAt: string };
type MemoryFile = { version: 1; memories: Memory[] };
type MemorySearchReport = { query: string; total: number; memories: Memory[] };

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
  if (value.trim() === "" || Buffer.byteLength(value, "utf8") > maxValueBytes)
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

function isMemory(value: unknown): value is Memory {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
  } catch {
    return false;
  }
  const id = ownData(value, "id");
  const key = ownData(value, "key");
  const storedValue = ownData(value, "value");
  const tags = ownData(value, "tags");
  const createdAt = ownData(value, "createdAt");
  const updatedAt = ownData(value, "updatedAt");
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= maxKeyLength &&
    typeof key === "string" &&
    key.trim().length > 0 &&
    key.length <= maxKeyLength &&
    typeof storedValue === "string" &&
    storedValue.trim().length > 0 &&
    Buffer.byteLength(storedValue, "utf8") <= maxValueBytes &&
    Array.isArray(tags) &&
    tags.length <= maxTags &&
    tags.every((tag) => typeof tag === "string" && tag.trim().length > 0 && tag.length <= maxTagLength) &&
    typeof createdAt === "string" &&
    Number.isFinite(Date.parse(createdAt)) &&
    typeof updatedAt === "string" &&
    Number.isFinite(Date.parse(updatedAt))
  );
}

async function readMemoryFile(filePath: string, entryLimit: number): Promise<Memory[]> {
  let source: string;
  try {
    const maxFileBytes = memoryFileOverheadBytes + entryLimit * memoryEntryOverheadBytes;
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
  if (file.version !== 1 || !Array.isArray(file.memories)) throw new Error("Memory file has an unsupported format");
  if (!file.memories.every(isMemory)) throw new Error("Memory file contains invalid memories");
  // maxEntries is the hard file ceiling that detects a corrupt or hand-grown file. The configured entryLimit only trims what this read returns, so lowering it no longer rejects a file that still fits the byte bound above.
  if (file.memories.length > maxEntries) throw new Error(`Memory file exceeds its ${maxEntries}-entry limit`);
  const keys = new Set(file.memories.map((memory) => memory.key));
  const ids = new Set(file.memories.map((memory) => memory.id));
  if (keys.size !== file.memories.length || ids.size !== file.memories.length) throw new Error("Memory file contains duplicate memories");
  return file.memories.slice(0, entryLimit);
}

async function writeMemoryFile(filePath: string, memories: Memory[]): Promise<void> {
  const payload = JSON.stringify({ version: 1, memories } satisfies MemoryFile, null, 2);
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
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

async function acquireMemoryLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  while (true) {
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
      if (Date.now() >= deadline) throw new Error("Timed out waiting for memory file lock", { cause: error });
      await new Promise<void>((resolve) => setTimeout(resolve, lockRetryMs));
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
    let memories: Memory[] = [];
    let mutationQueue = Promise.resolve();
    let last: MemorySearchReport | undefined;
    const refresh = async (): Promise<void> => {
      memories = await readMemoryFile(filePath, entryLimit);
    };
    const mutate = async <T>(operation: (current: Memory[]) => { memories: Memory[]; result: T }): Promise<T> => {
      let result: T | undefined;
      const run = async (): Promise<void> => {
        const release = await acquireMemoryLock(`${filePath}.lock`);
        try {
          const current = await readMemoryFile(filePath, entryLimit);
          const next = operation(current);
          await writeMemoryFile(filePath, next.memories);
          memories = next.memories;
          result = next.result;
        } finally {
          await release();
        }
      };
      mutationQueue = mutationQueue.catch(() => undefined).then(run);
      await mutationQueue;
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
        async execute(_toolCallId, params): Promise<AgentToolResult<Memory>> {
          const key = normalizeKey(params.key);
          const value = normalizeValue(params.value);
          const tags = normalizeTags(params.tags);
          const saved = await mutate((current) => {
            const now = new Date().toISOString();
            const existing = current.find((item) => item.key === key);
            const next: Memory =
              existing === undefined ? { id: randomUUID(), key, value, tags, createdAt: now, updatedAt: now } : { ...existing, value, tags, updatedAt: now };
            const ordered = [next, ...current.filter((item) => item.key !== key)];
            return { memories: ordered.slice(0, entryLimit), result: { memory: next, evicted: ordered.slice(entryLimit).map((item) => item.key) } };
          });
          const text =
            saved.evicted.length === 0
              ? `Memory saved: ${key}`
              : `Memory saved: ${key} (evicted ${saved.evicted.join(", ")} to stay within ${entryLimit} entries)`;
          return { content: [{ type: "text", text }], details: saved.memory };
        },
      }),
    );
    const unregisterSearch = context.piTools.register(
      defineTool({
        name: "memory_search",
        label: "Search memories",
        description: "Search explicit cross-session memories by key, value, or tag.",
        promptSnippet: "search remembered facts from earlier sessions",
        parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params): Promise<AgentToolResult<MemorySearchReport>> {
          await refresh();
          const query = params.query.trim().toLocaleLowerCase();
          if (query.length < 2 || query.length > maxKeyLength) throw new Error(`Memory search query must contain 2-${maxKeyLength} characters`);
          const results = memories.filter((item) => [item.key, item.value, ...item.tags].some((field) => field.toLocaleLowerCase().includes(query)));
          last = { query: params.query.trim(), total: results.length, memories: results };
          return {
            content: [
              {
                type: "text",
                text: results.length === 0 ? `No memories found for ${params.query.trim()}.` : results.map((item) => `${item.key}: ${item.value}`).join("\n"),
              },
            ],
            details: last,
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
        async execute(_toolCallId, params): Promise<AgentToolResult<{ key: string; removed: boolean }>> {
          const key = normalizeKey(params.key);
          if (params.confirm !== true) throw new Error("Deleting a memory requires confirm=true");
          const removed = await mutate((current) => {
            const next = current.filter((item) => item.key !== key);
            return { memories: next, result: next.length !== current.length };
          });
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
          return { filePath, count: memories.length, last: last ?? null, memories: memories.slice(0, 8) };
        },
      });
    } catch (error) {
      unregisterSet();
      unregisterSearch();
      unregisterDelete();
      throw error;
    }
    context.effect(() => () => {
      unregisterSet();
      unregisterSearch();
      unregisterDelete();
      disposePanel();
    });
  },
};
