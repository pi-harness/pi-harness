import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, parseSessionEntries, SessionManager, type AgentToolResult, type SessionInfo } from "@earendil-works/pi-coding-agent";

const maxSessions = 200;
const maxSessionFileBytes = 4 * 1024 * 1024;
const maxMessageTextLength = 4_000;
const maxDiffMessages = 40;

export interface SessionCompareMessage {
  role: string;
  text: string;
}

export interface SessionCompareDiff {
  shared: number;
  added: SessionCompareMessage[];
  removed: SessionCompareMessage[];
}

export interface SessionCompareSide {
  id: string;
  name: string;
  path: string;
  modified: string;
  messageCount: number;
  roles: Record<string, number>;
}

export interface SessionCompareReport extends SessionCompareDiff {
  left: SessionCompareSide;
  right: SessionCompareSide;
  changed: boolean;
  comparedAt: string;
}

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
    .join("\n")
    .trim();
}

export function sessionMessageEntries(entries: readonly unknown[]): SessionCompareMessage[] {
  return entries.flatMap((entry) => {
    const item = record(entry);
    const message = record(item?.message);
    if (item?.type !== "message" || typeof message?.role !== "string") return [];
    const text = contentText(message.content);
    return text === "" ? [] : [{ role: message.role, text }];
  });
}

export function compareMessageEntries(left: readonly SessionCompareMessage[], right: readonly SessionCompareMessage[]): SessionCompareDiff {
  const added: SessionCompareMessage[] = [];
  const removed: SessionCompareMessage[] = [];
  let shared = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftMessage = left[index];
    const rightMessage = right[index];
    if (leftMessage !== undefined && rightMessage !== undefined && leftMessage.role === rightMessage.role && leftMessage.text === rightMessage.text) {
      shared += 1;
      continue;
    }
    if (rightMessage !== undefined && added.length < maxDiffMessages) added.push({ ...rightMessage, text: rightMessage.text.slice(0, maxMessageTextLength) });
    if (leftMessage !== undefined && removed.length < maxDiffMessages) removed.push({ ...leftMessage, text: leftMessage.text.slice(0, maxMessageTextLength) });
  }
  return { shared, added, removed };
}

function sessionName(session: SessionInfo): string {
  return session.name?.trim() || session.firstMessage.trim() || session.id;
}

function side(session: SessionInfo, messages: readonly SessionCompareMessage[]): SessionCompareSide {
  const roles: Record<string, number> = {};
  for (const message of messages) roles[message.role] = (roles[message.role] ?? 0) + 1;
  return {
    id: session.id,
    name: sessionName(session),
    path: session.path,
    modified: session.modified.toISOString(),
    messageCount: messages.length,
    roles,
  };
}

async function readMessages(session: SessionInfo): Promise<SessionCompareMessage[]> {
  const metadata = await stat(session.path);
  if (!metadata.isFile()) throw new Error(`Session is not a file: ${session.id}`);
  if (metadata.size > maxSessionFileBytes) throw new Error(`Session ${session.id} exceeds the ${maxSessionFileBytes}-byte comparison limit`);
  return sessionMessageEntries(parseSessionEntries(await readFile(session.path, "utf8")));
}

function findSession(sessions: readonly SessionInfo[], requested: string): SessionInfo {
  const value = requested.trim();
  if (value === "") throw new Error("Session id is required");
  const exact = sessions.find((session) => session.id === value || session.path === value || basename(session.path) === value);
  if (exact === undefined) throw new Error(`Session was not found: ${value}`);
  return exact;
}

async function compareSessions(context: Context, leftId: string, rightId: string): Promise<SessionCompareReport> {
  const sessions = await SessionManager.list(context.piHarnessLaunch.cwd, context.piSession.manager.getSessionDir());
  const bounded = sessions.slice(0, maxSessions);
  const leftSession = findSession(bounded, leftId);
  const rightSession = findSession(bounded, rightId);
  const [leftMessages, rightMessages] = await Promise.all([readMessages(leftSession), readMessages(rightSession)]);
  const diff = compareMessageEntries(leftMessages, rightMessages);
  return {
    ...diff,
    left: side(leftSession, leftMessages),
    right: side(rightSession, rightMessages),
    changed: diff.shared !== leftMessages.length || diff.shared !== rightMessages.length,
    comparedAt: new Date().toISOString(),
  };
}

function renderMessage(message: SessionCompareMessage): string {
  return `[${message.role}] ${message.text}`;
}

function renderReport(report: SessionCompareReport): string {
  const lines = [
    `Compared ${report.left.id} with ${report.right.id}: ${report.changed ? "changed" : "identical"}.`,
    `Shared messages: ${report.shared}. Added in right: ${report.added.length}. Removed from left: ${report.removed.length}.`,
  ];
  if (report.added.length > 0) lines.push(`Added:\n${report.added.map(renderMessage).join("\n")}`);
  if (report.removed.length > 0) lines.push(`Removed:\n${report.removed.map(renderMessage).join("\n")}`);
  return lines.join("\n\n");
}

export default {
  name: "pi-session-compare",
  inject: ["piHarnessLaunch", "piSession", "piPluginUi", "piTools"],
  apply(context: Context) {
    let latest: SessionCompareReport | undefined;
    const unregister = context.piTools.register(
      defineTool({
        name: "session_compare",
        label: "Compare sessions",
        description: "Compare two persisted Pi JSONL sessions by message role and text without modifying either file.",
        promptSnippet: "compare two persisted Pi sessions",
        parameters: Type.Object({
          left: Type.String({ description: "Left session id or session filename" }),
          right: Type.String({ description: "Right session id or session filename" }),
        }),
        async execute(_toolCallId, params): Promise<AgentToolResult<SessionCompareReport>> {
          latest = await compareSessions(context, params.left, params.right);
          return { content: [{ type: "text", text: renderReport(latest) }], details: latest };
        },
      }),
    );
    const disposePanel = context.piPluginUi.register({
      id: "session-compare-panel",
      pluginId: "@pi-harness/core/plugins/session-compare",
      title: "Session Compare",
      description: "对比两个持久化会话的消息差异，不修改原始会话文件。",
      icon: "⇄",
      read: () => latest ?? { left: null, right: null, shared: 0, added: [], removed: [], changed: false, comparedAt: null },
    });
    context.effect(() => () => {
      unregister();
      disposePanel();
    });
  },
};
