import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "@pi-harness/plugin-api";

const maxLabelLength = 120;
const failedManagers = new WeakMap<object, object | null>();
const writeFailureMessage = "Bookmark write failed; reopen the session from disk before using bookmarks again";

function parameters(value: unknown): { action: "add" | "list" | "remove"; label?: string; entryId?: string; bookmarkId?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Bookmark parameters must be an object");
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !("value" in descriptor)) throw new Error("Bookmark parameters require string data properties");
    output[key] = descriptor.value;
  }
  if (output.action !== "add" && output.action !== "list" && output.action !== "remove") throw new Error("Unknown bookmark action");
  const allowed = output.action === "add" ? ["action", "label", "entryId"] : output.action === "remove" ? ["action", "bookmarkId"] : ["action"];
  if (Object.keys(output).some((key) => !allowed.includes(key))) throw new Error("Unknown property for bookmark action");
  for (const key of ["label", "entryId", "bookmarkId"] as const) {
    if (
      output[key] !== undefined &&
      (typeof output[key] !== "string" || output[key].includes("\0") || output[key].trim().length > (key === "label" ? 120 : 128))
    )
      throw new Error(`Invalid bookmark ${key}`);
  }
  return output as ReturnType<typeof parameters>;
}

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
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
    const readBookmarks = (): SessionBookmark[] => {
      const manager = context.piSession.manager;
      if (failedManagers.has(manager)) {
        if (failedManagers.get(manager) === manager.getHeader()) throw new Error(writeFailureMessage);
        failedManagers.delete(manager);
      }
      return listSessionBookmarks(manager.getEntries());
    };
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
        async execute(_toolCallId, rawParams, signal): Promise<AgentToolResult<{ bookmarks: SessionBookmark[] }>> {
          if (signal?.aborted === true || lifecycle.signal.aborted) throw new Error("Bookmark request was cancelled");
          const manager = context.piSession.manager;
          const header = manager.getHeader();
          return Promise.resolve().then(() => {
            if (signal?.aborted === true || lifecycle.signal.aborted) throw new Error("Bookmark request was cancelled");
            if (context.piSession.manager !== manager || manager.getHeader() !== header) throw new Error("Bookmark session changed before execution");
            const params = parameters(rawParams);
            readBookmarks();
            const persist = (entryId: string, label: string | undefined): void => {
              if (manager.getEntry(entryId) === undefined) throw new Error(`Entry ${entryId} not found`);
              try {
                manager.appendLabelChange(entryId, label);
              } catch (error) {
                failedManagers.set(manager, header);
                throw new Error(writeFailureMessage, { cause: error });
              }
            };
            if (params.action === "add") {
              const label = normalizeBookmarkLabel(params.label ?? "");
              const entryId = params.entryId?.trim();
              if (entryId === undefined || entryId === "") throw new Error("Bookmark entryId is required when adding a bookmark");
              persist(entryId, label);
              return { content: [{ type: "text", text: `Bookmark added: ${label}` }], details: { bookmarks: readBookmarks() } };
            }
            if (params.action === "remove") {
              const bookmarkId = params.bookmarkId?.trim();
              if (bookmarkId === undefined || bookmarkId === "") throw new Error("Bookmark bookmarkId is required when removing a bookmark");
              const bookmark = readBookmarks().find((item) => item.id === bookmarkId);
              if (bookmark === undefined) throw new Error("Bookmark was not found");
              persist(bookmark.entryId, undefined);
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
    context.effect(() => unregister);
    const disposePanel = context.piPluginUi.register({
      id: "session-bookmarks-panel",
      pluginId: "@pi-harness/plugin-session-bookmarks",
      title: "Session Bookmarks",
      description: "为重要会话节点添加原生持久化标签，不修改已有消息内容。",
      icon: "☆",
      read: () => {
        const bookmarks = readBookmarks();
        return { bookmarks, total: bookmarks.length };
      },
    });
    context.effect(() => disposePanel);
  },
};
