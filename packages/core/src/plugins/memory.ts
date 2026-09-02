import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";

const defaultFileName = "memory.json";
const maxKeyLength = 128;
const maxValueBytes = 64 * 1024;
const maxTagLength = 64;
const maxTags = 16;
const maxEntries = 500;

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

export default {
  name: "pi-memory",
  inject: ["piHarnessLaunch", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: MemoryPluginConfig) {
    const filePath = normalizeFilePath(context.piHarnessLaunch.agentDir, config.fileName);
    const entryLimit = Math.max(1, Math.min(maxEntries, Math.trunc(config.maxEntries ?? maxEntries)));
    let memories: Memory[] = [];
    let loaded = false;
    let loading: Promise<void> | undefined;
    let writeQueue = Promise.resolve();
    let last: MemorySearchReport | undefined;
    const load = async (): Promise<void> => {
      if (loaded) return;
      if (loading !== undefined) return loading;
      loading = (async () => {
        try {
          const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<MemoryFile>;
          if (parsed.version !== 1 || !Array.isArray(parsed.memories)) throw new Error("Memory file has an unsupported format");
          memories = parsed.memories.filter(
            (item): item is Memory => typeof item === "object" && item !== null && typeof item.key === "string" && typeof item.value === "string",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          memories = [];
        }
        loaded = true;
      })();
      return loading;
    };
    const persist = async (): Promise<void> => {
      const payload = JSON.stringify({ version: 1, memories } satisfies MemoryFile, null, 2);
      writeQueue = writeQueue.then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        const temporary = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
        await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, filePath);
      });
      await writeQueue;
    };
    const unregisterSet = context.piTools.register(
      defineTool({
        name: "memory_set",
        label: "Remember fact",
        description: "Persist one explicit fact in the Pi Harness memory store, replacing an existing value with the same key.",
        promptSnippet: "save an explicit fact for future sessions",
        parameters: Type.Object({ key: Type.String(), value: Type.String(), tags: Type.Optional(Type.Array(Type.String())) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<Memory>> {
          await load();
          const key = normalizeKey(params.key);
          const value = normalizeValue(params.value);
          const tags = normalizeTags(params.tags);
          const now = new Date().toISOString();
          const existing = memories.find((item) => item.key === key);
          const memory: Memory =
            existing === undefined ? { id: randomUUID(), key, value, tags, createdAt: now, updatedAt: now } : { ...existing, value, tags, updatedAt: now };
          memories = [memory, ...memories.filter((item) => item.key !== key)].slice(0, entryLimit);
          await persist();
          return { content: [{ type: "text", text: `Memory saved: ${key}` }], details: memory };
        },
      }),
    );
    const unregisterSearch = context.piTools.register(
      defineTool({
        name: "memory_search",
        label: "Search memories",
        description: "Search explicit cross-session memories by key, value, or tag.",
        promptSnippet: "search remembered facts from earlier sessions",
        parameters: Type.Object({ query: Type.String() }),
        async execute(_toolCallId, params): Promise<AgentToolResult<MemorySearchReport>> {
          await load();
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
        parameters: Type.Object({ key: Type.String(), confirm: Type.Boolean() }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ key: string; removed: boolean }>> {
          await load();
          const key = normalizeKey(params.key);
          if (params.confirm !== true) throw new Error("Deleting a memory requires confirm=true");
          const before = memories.length;
          memories = memories.filter((item) => item.key !== key);
          const removed = memories.length !== before;
          if (removed) await persist();
          return { content: [{ type: "text", text: removed ? `Memory deleted: ${key}` : `Memory not found: ${key}` }], details: { key, removed } };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "memory-panel",
      pluginId: "@pi-harness/core/plugins/memory",
      title: "Memory",
      description: "只保存 Agent 明确写入的事实，跨会话持久化并支持检索与删除。",
      icon: "▣",
      read: async () => {
        await load();
        return { filePath, count: memories.length, last: last ?? null, memories: memories.slice(0, 8) };
      },
    });
    context.effect(() => () => {
      unregisterSet();
      unregisterSearch();
      unregisterDelete();
      disposePanel();
    });
  },
};
