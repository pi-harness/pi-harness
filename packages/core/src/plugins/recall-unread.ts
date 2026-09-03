import { readFile, stat } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, parseSessionEntries, SessionManager, type AgentToolResult, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys } from "../config.js";

const defaultMaxSessions = 100;
const maxAllowedSessions = 500;
const maxPreviewChars = 500;
const maxSessionFileBytes = 4 * 1024 * 1024;
const sessionReadConcurrency = 8;

export interface RecallUnreadPluginConfig {
  maxSessions?: number;
}

export const Config: z<RecallUnreadPluginConfig> = z.object({ maxSessions: z.number().default(defaultMaxSessions) });

export interface UnreadSession {
  id: string;
  path: string;
  cwd: string;
  name: string;
  modified: string;
  messageCount: number;
  message: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
}

export function unreadUserMessage(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = record(entries[index]);
    if (entry?.type !== "message") continue;
    const message = record(entry.message);
    if (message?.role !== "user") return undefined;
    const text = contentText(message.content).trim();
    return text === "" ? undefined : text.slice(0, maxPreviewChars);
  }
  return undefined;
}

async function unreadSession(session: SessionInfo): Promise<UnreadSession | undefined> {
  try {
    const metadata = await stat(session.path);
    if (!metadata.isFile() || metadata.size > maxSessionFileBytes) return undefined;
    const message = unreadUserMessage(parseSessionEntries(await readFile(session.path, "utf8")));
    if (message === undefined) return undefined;
    return {
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name?.trim() || session.firstMessage.trim() || session.id,
      modified: session.modified.toISOString(),
      messageCount: session.messageCount,
      message,
    };
  } catch {
    return undefined;
  }
}

async function unreadSessions(sessions: readonly SessionInfo[]): Promise<UnreadSession[]> {
  const results: UnreadSession[] = [];
  for (let index = 0; index < sessions.length; index += sessionReadConcurrency) {
    const batch = await Promise.all(sessions.slice(index, index + sessionReadConcurrency).map(unreadSession));
    results.push(...batch.filter((item): item is UnreadSession => item !== undefined));
  }
  return results;
}

export default {
  name: "pi-recall-unread",
  inject: ["piHarnessLaunch", "piSession", "piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: RecallUnreadPluginConfig) {
    assertKnownConfigKeys("pi-recall-unread", config, ["maxSessions"]);
    const maxSessions = Math.max(1, Math.min(maxAllowedSessions, Math.trunc(config.maxSessions ?? defaultMaxSessions)));
    let items: UnreadSession[] = [];
    let scans = 0;
    const scan = async (query = ""): Promise<UnreadSession[]> => {
      const normalizedQuery = query.trim().toLocaleLowerCase();
      if (normalizedQuery.length > 120) throw new Error("Recall unread query must contain 0-120 characters");
      const sessions = await SessionManager.list(context.piHarnessLaunch.cwd, context.piSession.manager.getSessionDir());
      items = (await unreadSessions(sessions.slice(0, maxSessions))).filter(
        (item) => normalizedQuery === "" || `${item.name} ${item.message} ${item.cwd}`.toLocaleLowerCase().includes(normalizedQuery),
      );
      scans += 1;
      return items;
    };
    const unregister = context.piTools.register(
      defineTool({
        name: "session_recall_unread",
        label: "Recall unread sessions",
        description: "Find persisted Pi sessions whose latest message is an unanswered user message without modifying the sessions.",
        promptSnippet: "find previous sessions with unanswered user messages",
        parameters: Type.Object({ query: Type.Optional(Type.String()) }),
        async execute(_toolCallId, params): Promise<AgentToolResult<{ total: number; items: UnreadSession[] }>> {
          const matches = await scan(params.query);
          return {
            content: [
              {
                type: "text",
                text: matches.map((item) => `${item.name}: ${item.message}`).join("\n") || "No unanswered sessions found.",
              },
            ],
            details: { total: matches.length, items: matches },
          };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "recall-unread-panel",
      pluginId: "@pi-harness/core/plugins/recall-unread",
      title: "Recall Unread",
      description: "查看以未回答用户消息结束的原生 Pi 会话，只读不修改。",
      icon: "◌",
      read: async () => {
        const matches = await scan();
        return { scans, total: matches.length, items: matches };
      },
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
