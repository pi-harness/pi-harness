import { readFile } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, parseSessionEntries, SessionManager, type AgentToolResult, type SessionInfo } from "@earendil-works/pi-coding-agent";

const maxQueryLength = 120;
const maxPreviewLength = 500;
const maxSessions = 200;
const maxHits = 100;

export type SessionSearchHit = { role: string; text: string };
export type SessionSearchItem = { id: string; name: string; path: string; modified: string; hits: SessionSearchHit[] };

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

export function searchSessionEntries(entries: readonly unknown[], query: string): SessionSearchHit[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length < 1 || normalized.length > maxQueryLength) throw new Error("Session search query must contain 1-120 characters");
  return entries.flatMap((entry) => {
    const item = record(entry);
    const message = record(item?.message);
    if (item?.type !== "message" || typeof message?.role !== "string") return [];
    const text = contentText(message.content);
    return text.toLocaleLowerCase().includes(normalized) ? [{ role: message.role, text: text.slice(0, maxPreviewLength) }] : [];
  });
}

async function searchSession(session: SessionInfo, query: string): Promise<SessionSearchItem | undefined> {
  try {
    const hits = searchSessionEntries(parseSessionEntries(await readFile(session.path, "utf8")), query);
    if (hits.length === 0) return undefined;
    return {
      id: session.id,
      name: session.name?.trim() || session.firstMessage.trim() || session.id,
      path: session.path,
      modified: session.modified.toISOString(),
      hits,
    };
  } catch {
    return undefined;
  }
}

export default {
  name: "pi-session-search",
  inject: ["piHarnessLaunch", "piSession", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: { query: string; total: number; items: SessionSearchItem[] } | undefined;
    const search = async (query: string): Promise<SessionSearchItem[]> => {
      const normalized = query.trim();
      if (normalized.length < 1 || normalized.length > maxQueryLength) throw new Error("Session search query must contain 1-120 characters");
      const sessions = await SessionManager.list(context.piHarnessLaunch.cwd, context.piSession.manager.getSessionDir());
      const items = (await Promise.all(sessions.slice(0, maxSessions).map((session) => searchSession(session, normalized))))
        .filter((item): item is SessionSearchItem => item !== undefined)
        .slice(0, maxHits);
      latest = { query: normalized, total: items.length, items };
      return items;
    };
    const unregister = context.piTools.register(
      defineTool({
        name: "session_search",
        label: "Search sessions",
        description: "Search persisted Pi JSONL sessions for a bounded text query without modifying session files.",
        promptSnippet: "search previous Pi sessions for a phrase",
        parameters: Type.Object({ query: Type.String({ description: "Text to search for, 1-120 characters" }) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ query: string; total: number; items: SessionSearchItem[] }>> {
          const items = await search(params.query);
          return {
            content: [
              {
                type: "text",
                text: items.map((item) => `${item.name}: ${item.hits.map((hit) => hit.text).join(" | ")}`).join("\n") || "No matching sessions found.",
              },
            ],
            details: latest!,
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "session-search-panel",
      pluginId: "@pi-harness/core/plugins/session-search",
      title: "Session Search",
      description: "跨本地持久化会话搜索文本，只读不修改会话文件。",
      icon: "⌕",
      read: () => latest ?? { query: "", total: 0, items: [] },
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
