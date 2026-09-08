import { opendir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig, readBoundedFile } from "@pi-harness/plugin-api";

const maxQueryLength = 120;
const maxPreviewLength = 500;
const maxSessions = 200;
const maxItems = 100;
const maxHitsPerSession = 10;
const maxDirectoryEntries = 4096;
const maxTotalBytes = 32 * 1024 * 1024;
const maxSessionFileBytes = 4 * 1024 * 1024;

export type SessionSearchHit = { role: string; text: string };
export type SessionSearchItem = { id: string; name: string; path: string; modified: string; hits: SessionSearchHit[]; totalHits: number };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" ? [item.text.trim()] : [];
    })
    .filter(Boolean)
    .join("\n");
}

function matchingPreview(text: string, normalizedQuery: string): string {
  if (text.length <= maxPreviewLength) return text;
  const foldedIndex = text.toLowerCase().indexOf(normalizedQuery);
  let matchIndex = 0;
  let foldedOffset = 0;
  for (const character of text) {
    if (foldedOffset >= foldedIndex) break;
    foldedOffset += character.toLowerCase().length;
    matchIndex += character.length;
  }
  const idealStart = matchIndex - Math.floor((maxPreviewLength - normalizedQuery.length) / 2);
  const start = Math.max(0, Math.min(idealStart, text.length - maxPreviewLength));
  return text.slice(start, start + maxPreviewLength);
}

export function searchSessionEntries(entries: readonly unknown[], query: string): { total: number; hits: SessionSearchHit[] } {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 1 || normalized.length > maxQueryLength) throw new Error("Session search query must contain 1-120 characters");
  const hits: SessionSearchHit[] = [];
  let total = 0;
  for (const entry of entries) {
    const item = record(entry);
    const message = record(item?.message);
    if (item?.type !== "message" || (message?.role !== "user" && message?.role !== "assistant")) continue;
    const text = contentText(message.content);
    if (!text.toLowerCase().includes(normalized)) continue;
    total += 1;
    if (hits.length < maxHitsPerSession) hits.push({ role: message.role, text: matchingPreview(text, normalized) });
  }
  return { total, hits };
}

export interface SessionSearchReport {
  query: string;
  total: number;
  items: SessionSearchItem[];
  cwd: string;
  directory: string;
  scanned: number;
  skipped: number;
  directoryEntries: number;
  byteBudgetUsed: number;
  truncated: boolean;
  scope: string;
}

const scope =
  "User and assistant text in persisted native journals, including historical branches. Images, thinking and tool output are excluded. Directory order; up to 200 files / 4096 entries / 32 MiB read budget (failed reads charge their allowance) / 4 MiB per file. Up to 100 matching sessions, 10 previews per session, 500 characters each. This is a read-only search, not an atomic snapshot.";

async function searchSessions(directory: string, cwd: string, query: string, check: () => void): Promise<SessionSearchReport> {
  const report: SessionSearchReport = {
    query,
    total: 0,
    items: [],
    cwd,
    directory,
    scanned: 0,
    skipped: 0,
    directoryEntries: 0,
    byteBudgetUsed: 0,
    truncated: false,
    scope,
  };
  check();
  let dir: Awaited<ReturnType<typeof opendir>>;
  try {
    dir = await opendir(directory);
  } catch (error) {
    check();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
    throw error;
  }
  for await (const entry of dir) {
    check();
    if (report.directoryEntries >= maxDirectoryEntries || report.scanned + report.skipped >= maxSessions || report.byteBudgetUsed >= maxTotalBytes) {
      report.truncated = true;
      break;
    }
    report.directoryEntries += 1;
    if (!entry.name.endsWith(".jsonl")) continue;
    if (!entry.isFile()) {
      report.skipped += 1;
      continue;
    }
    const path = join(directory, entry.name);
    let entries: unknown[];
    try {
      const allowance = Math.min(maxSessionFileBytes, maxTotalBytes - report.byteBudgetUsed);
      report.byteBudgetUsed += allowance;
      const bytes = await readBoundedFile(path, allowance, "Session search file");
      report.byteBudgetUsed -= allowance - bytes.length;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      entries = text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown);
    } catch {
      check();
      report.skipped += 1;
      continue;
    }
    check();
    const header = record(entries[0]);
    if (header?.type !== "session" || header.version !== 3 || typeof header.id !== "string" || header.id.length > 256 || header.cwd !== cwd) {
      report.skipped += 1;
      continue;
    }
    report.scanned += 1;
    const found = searchSessionEntries(entries, query);
    if (found.total === 0) continue;
    report.total += 1;
    if (report.items.length >= maxItems) {
      report.truncated = true;
      continue;
    }
    const firstUser = entries.map(record).find((item) => item?.type === "message" && record(item.message)?.role === "user");
    let name = contentText(record(firstUser?.message)?.content).slice(0, 256) || header.id;
    let modified = typeof header.timestamp === "string" ? header.timestamp.slice(0, 64) : "";
    for (const value of entries) {
      const item = record(value);
      if (item?.type === "session_info" && typeof item.name === "string" && item.name.trim() !== "") name = item.name.trim().slice(0, 256);
      if (typeof item?.timestamp === "string") modified = item.timestamp.slice(0, 64);
    }
    report.items.push({ id: header.id, name, path, modified, hits: found.hits, totalHits: found.total });
    if (found.total > found.hits.length) report.truncated = true;
  }
  check();
  return report;
}

export default {
  name: "pi-session-search",
  inject: ["piHarnessLaunch", "piSession", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let latest: SessionSearchReport | undefined;
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
    const unregister = context.piTools.register(
      defineTool({
        name: "session_search",
        label: "Search sessions",
        description: "Search persisted Pi JSONL sessions for a bounded text query without modifying session files.",
        promptSnippet: "search previous Pi sessions for a phrase",
        parameters: Type.Object({ query: Type.String({ description: "Text to search for, 1-120 characters" }) }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<SessionSearchReport>> {
          const combined = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          if (combined.aborted) throw new Error("Session search was cancelled");
          if (params === null || typeof params !== "object" || Array.isArray(params)) throw new Error("Session search parameters must be an object");
          const descriptors = Object.getOwnPropertyDescriptors(params);
          if (Reflect.ownKeys(descriptors).some((key) => key !== "query")) throw new Error("Unknown session search parameter");
          const query: unknown = descriptors.query?.value;
          if (typeof query !== "string" || query.length > maxQueryLength || query.trim() === "" || query.includes("\0"))
            throw new Error("Session search query must contain 1-120 characters");
          const manager = context.get("piRuntime")?.session.sessionManager ?? context.piSession.manager;
          const cwd = manager.getCwd();
          const directory = manager.getSessionDir();
          const sessionId = manager.getSessionId();
          const check = (): void => {
            if (combined.aborted) throw new Error("Session search was cancelled");
            if (
              (context.get("piRuntime")?.session.sessionManager ?? context.piSession.manager) !== manager ||
              manager.getSessionId() !== sessionId ||
              manager.getCwd() !== cwd ||
              manager.getSessionDir() !== directory
            )
              throw new Error("Session search context changed during execution");
          };
          const report = await searchSessions(directory, cwd, query.trim(), check);
          check();
          latest = structuredClone(report);
          return { content: [{ type: "text", text: JSON.stringify(report) }], details: report };
        },
      }),
    );
    context.effect(() => unregister);
    const disposePanel = context.piPluginUi.register({
      id: "session-search-panel",
      pluginId: "@pi-harness/plugin-session-search",
      title: "Session Search",
      description: "跨本地持久化会话搜索文本，只读不修改会话文件。",
      icon: "⌕",
      read: () => (latest === undefined ? { query: "", total: 0, items: [], scope } : structuredClone(latest)),
    });
    context.effect(() => disposePanel);
  },
};
