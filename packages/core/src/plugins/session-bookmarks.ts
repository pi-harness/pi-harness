import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "../config.js";

const maxLabelLength = 120;

export type SessionBookmark = { id: string; entryId: string; label: string };

export function normalizeBookmarkLabel(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLabelLength) throw new Error("Bookmark label must contain 1-120 characters");
  return normalized;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function listSessionBookmarks(entries: readonly unknown[]): SessionBookmark[] {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    const item = record(entry);
    if (item?.type !== "label" || typeof item.targetId !== "string") continue;
    if (typeof item.label === "string" && item.label.trim() !== "") labels.set(item.targetId, item.label.trim());
    else labels.delete(item.targetId);
  }
  return [...labels].map(([entryId, label]) => ({ id: entryId, entryId, label }));
}

export default {
  name: "pi-session-bookmarks",
  inject: ["piSession", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const manager = context.piSession.manager;
    const readBookmarks = (): SessionBookmark[] => listSessionBookmarks(manager.getEntries());
    const unregister = context.piTools.register(
      defineTool({
        name: "session_bookmarks",
        label: "Session bookmarks",
        description: "Add, list, or remove labels on entries in the current Pi session using native session history.",
        promptSnippet: "bookmark an important point in the current session",
        parameters: Type.Object(
          {
            action: Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("remove")]),
            label: Type.Optional(Type.String({ description: "Bookmark label for add" })),
            entryId: Type.Optional(Type.String({ description: "Native session entry id for add" })),
            bookmarkId: Type.Optional(Type.String({ description: "Bookmark id for remove" })),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        execute(_toolCallId, params): Promise<AgentToolResult<{ bookmarks: SessionBookmark[] }>> {
          return Promise.resolve().then(() => {
            if (params.action === "add") {
              const label = normalizeBookmarkLabel(params.label ?? "");
              const entryId = params.entryId?.trim();
              if (entryId === undefined || entryId === "") throw new Error("Bookmark entryId is required when adding a bookmark");
              manager.appendLabelChange(entryId, label);
              return { content: [{ type: "text", text: `Bookmark added: ${label}` }], details: { bookmarks: readBookmarks() } };
            }
            if (params.action === "remove") {
              const bookmarkId = params.bookmarkId?.trim();
              if (bookmarkId === undefined || bookmarkId === "") throw new Error("Bookmark bookmarkId is required when removing a bookmark");
              const bookmark = readBookmarks().find((item) => item.id === bookmarkId);
              if (bookmark === undefined) throw new Error("Bookmark was not found");
              manager.appendLabelChange(bookmark.entryId, undefined);
            }
            const bookmarks = readBookmarks();
            return {
              content: [{ type: "text", text: bookmarks.map((bookmark) => `${bookmark.id}: ${bookmark.label}`).join("\n") || "No bookmarks found." }],
              details: { bookmarks },
            };
          });
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "session-bookmarks-panel",
      pluginId: "@pi-harness/core/plugins/session-bookmarks",
      title: "Session Bookmarks",
      description: "为重要会话节点添加原生持久化标签，不修改已有消息内容。",
      icon: "☆",
      read: () => {
        const bookmarks = readBookmarks();
        return { bookmarks, total: bookmarks.length };
      },
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
