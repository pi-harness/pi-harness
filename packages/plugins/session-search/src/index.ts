import { opendir } from "node:fs/promises";
import type { Dir, Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
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
const cursorTtlMs = 5 * 60 * 1000;

interface SearchScan {
  query: string;
  cursor: string;
  dir?: Dir;
  pending?: Dirent;
  invalid: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

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
  let start = Math.max(0, Math.min(idealStart, text.length - maxPreviewLength));
  let end = Math.min(text.length, start + maxPreviewLength);
  // Keep the existing UTF-16 length bound without cutting a surrogate pair.
  const low = (at: number) => text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff;
  const high = (at: number) => text.charCodeAt(at) >= 0xd800 && text.charCodeAt(at) <= 0xdbff;
  if (start > 0 && low(start) && high(start - 1)) start += 1;
  if (end < text.length && high(end - 1) && low(end)) end -= 1;
  return text.slice(start, end);
}

export function searchSessionEntries(entries: readonly unknown[], query: string): { total: number; hits: SessionSearchHit[] } {
  const trimmed = query.trim();
  if (trimmed.length < 1 || trimmed.length > maxQueryLength) throw new Error("Session search query must contain 1-120 characters");
  const normalized = trimmed.toLowerCase();
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
  nextCursor: string | null;
  scope: string;
}

const scope =
  "User and assistant text in persisted native journals, including historical branches. Images, thinking and tool output are excluded. Per page: directory order, up to 200 files / 4096 entries / 32 MiB read budget (failed reads charge their allowance) / 4 MiB per file / 100 matching sessions. Counts describe this page only. Use nextCursor with the same query until null, even after a page with no hits. One cursor per native session; expires after five idle minutes or a new search. Up to 10 previews per session, 500 characters each. Read-only, not an atomic snapshot; skipped files and clipped previews are not recovered by continuation.";

async function searchSessions(directory: string, cwd: string, scan: SearchScan, check: () => void): Promise<SessionSearchReport> {
  const query = scan.query;
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
    nextCursor: null,
    scope,
  };
  check();
  try {
    scan.dir ??= await opendir(directory);
  } catch (error) {
    check();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
    throw error;
  }
  while (true) {
    check();
    const entry = scan.pending ?? (await scan.dir.read());
    delete scan.pending;
    check();
    if (entry === null) break;
    // Keep the lookahead entry for the next page; never consume a result that
    // cannot fit. Reserve a full file allowance so a valid file near the byte
    // boundary is deferred instead of incorrectly classified as oversized.
    if (
      report.directoryEntries >= maxDirectoryEntries ||
      report.scanned + report.skipped >= maxSessions ||
      report.byteBudgetUsed > maxTotalBytes - maxSessionFileBytes ||
      report.items.length >= maxItems
    ) {
      scan.pending = entry;
      report.truncated = true;
      report.nextCursor = randomUUID();
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
    let activeScan: SearchScan | undefined;
    let busy = false;
    const release = async (scan: SearchScan) => {
      scan.invalid = true;
      clearTimeout(scan.timer);
      if (activeScan === scan) activeScan = undefined;
      const dir = scan.dir;
      delete scan.dir;
      if (dir) await dir.close();
    };
    const invalidate = () => {
      if (!activeScan) return;
      activeScan.invalid = true;
      clearTimeout(activeScan.timer);
      // An executing read owns cleanup in its finally block.
      if (!busy) void release(activeScan).catch(() => {});
    };
    const lifecycle = new AbortController();
    context.effect(() => () => {
      lifecycle.abort();
      invalidate();
    });
    const readContext = () => {
      const session = context.get("piRuntime")?.session;
      const manager = session?.sessionManager ?? context.piSession.manager;
      return { session, manager, id: manager.getSessionId(), cwd: manager.getCwd(), directory: manager.getSessionDir() };
    };
    let currentContext = readContext();
    const refreshContext = () => {
      const next = readContext();
      if (
        next.session !== currentContext.session ||
        next.manager !== currentContext.manager ||
        next.id !== currentContext.id ||
        next.cwd !== currentContext.cwd ||
        next.directory !== currentContext.directory
      ) {
        currentContext = next;
        latest = undefined;
        invalidate();
      }
      return currentContext;
    };

    const unregister = context.piTools.register(
      defineTool({
        name: "session_search",
        label: "Search sessions",
        description:
          "Search persisted Pi JSONL sessions without modifying files. Results are paged: pass nextCursor as cursor with the same query until nextCursor is null, including after zero-hit pages.",
        promptSnippet: "search previous Pi sessions for a phrase",
        parameters: Type.Object(
          {
            query: Type.String({ description: "Text to search for, 1-120 characters" }),
            cursor: Type.Optional(
              Type.String({ minLength: 36, maxLength: 36, description: "nextCursor from the previous page of this query; omit to start over" }),
            ),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<SessionSearchReport>> {
          if (busy) throw new Error("Session search is already running");
          const combined = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          if (combined.aborted) throw new Error("Session search was cancelled");
          const operationContext = refreshContext();
          const check = () => {
            if (combined.aborted) throw new Error("Session search was cancelled");
            if (refreshContext() !== operationContext) throw new Error("Session search context changed during execution");
          };
          if (params === null || typeof params !== "object" || Array.isArray(params)) throw new Error("Session search parameters must be an object");
          const descriptors = Object.getOwnPropertyDescriptors(params);
          if (Reflect.ownKeys(descriptors).some((key) => key !== "query" && key !== "cursor")) throw new Error("Unknown session search parameter");
          const query: unknown = descriptors.query?.value;
          if (typeof query !== "string" || query.length > maxQueryLength || query.trim() === "" || query.includes("\0"))
            throw new Error("Session search query must contain 1-120 characters");
          check();
          const cursor: unknown = descriptors.cursor?.value;
          if (descriptors.cursor && (!Object.hasOwn(descriptors.cursor, "value") || typeof cursor !== "string" || !/^[0-9a-f-]{36}$/.test(cursor)))
            throw new Error("Invalid session search cursor");
          if (cursor !== undefined && (!activeScan || activeScan.invalid || activeScan.cursor !== cursor || activeScan.query !== query.trim()))
            throw new Error("Session search cursor is stale or belongs to another query; restart without cursor");
          // Descriptor inspection can invoke Proxy traps that start another
          // search. Recheck ownership before replacing its live directory.
          if (busy) throw new Error("Session search is already running");
          busy = true;
          let scan: SearchScan | undefined;
          try {
            if (cursor === undefined) {
              if (activeScan) await release(activeScan);
              check();
              activeScan = { query: query.trim(), cursor: "", invalid: false };
            }
            scan = activeScan!;
            clearTimeout(scan.timer);
            const report = await searchSessions(operationContext.directory, operationContext.cwd, scan, () => {
              check();
              if (scan!.invalid) throw new Error("Session search cursor was invalidated");
            });
            check();
            if (report.nextCursor === null) await release(scan);
            else {
              scan.cursor = report.nextCursor;
              scan.timer = setTimeout(invalidate, cursorTtlMs);
              scan.timer.unref();
            }
            check();
            latest = structuredClone(report);
            return { content: [{ type: "text", text: JSON.stringify(report) }], details: report };
          } catch (error) {
            if (scan) await release(scan);
            throw error;
          } finally {
            busy = false;
          }
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
      read: () => {
        refreshContext();
        return latest === undefined ? { query: "", total: 0, items: [], scope } : structuredClone(latest);
      },
    });
    context.effect(() => disposePanel);
  },
};
