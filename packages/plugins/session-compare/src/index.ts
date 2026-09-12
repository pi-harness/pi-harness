import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, parseSessionEntries, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig, readBoundedFile } from "@pi-harness/plugin-api";

const maxSessionFileBytes = 4 * 1024 * 1024;
const maxSessionHeaderBytes = 64 * 1024;
const maxMessageTextLength = 4_000;
const maxDiffMessages = 40;

export interface SessionCompareMessage {
  role: string;
  text: string;
}

export interface SessionCompareDiff {
  shared: number;
  addedCount: number;
  removedCount: number;
  addedTruncated: boolean;
  removedTruncated: boolean;
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

interface SessionReference {
  id: string;
  firstMessage?: string;
  name?: string;
  path: string;
  modified: Date;
}

interface SessionCandidate {
  path: string;
  expectedCwd: string;
  expectedId?: string;
  modified: Date;
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
  let addedCount = 0;
  let removedCount = 0;
  let addedTextTruncated = false;
  let removedTextTruncated = false;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftMessage = left[index];
    const rightMessage = right[index];
    if (leftMessage !== undefined && rightMessage !== undefined && leftMessage.role === rightMessage.role && leftMessage.text === rightMessage.text) {
      shared += 1;
      continue;
    }
    if (rightMessage !== undefined) addedCount += 1;
    if (leftMessage !== undefined) removedCount += 1;
    if (rightMessage !== undefined && added.length < maxDiffMessages) {
      addedTextTruncated ||= rightMessage.text.length > maxMessageTextLength;
      added.push({ ...rightMessage, text: rightMessage.text.slice(0, maxMessageTextLength) });
    }
    if (leftMessage !== undefined && removed.length < maxDiffMessages) {
      removedTextTruncated ||= leftMessage.text.length > maxMessageTextLength;
      removed.push({ ...leftMessage, text: leftMessage.text.slice(0, maxMessageTextLength) });
    }
  }
  return {
    shared,
    added,
    removed,
    addedCount,
    removedCount,
    addedTruncated: addedTextTruncated || addedCount > added.length,
    removedTruncated: removedTextTruncated || removedCount > removed.length,
  };
}

function sessionName(session: SessionReference): string {
  return session.name?.trim() || session.firstMessage?.trim() || session.id;
}

function side(session: SessionReference, messages: readonly SessionCompareMessage[]): SessionCompareSide {
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

interface ReadSession {
  session: SessionReference;
  messages: SessionCompareMessage[];
}

function logicalModified(entries: readonly unknown[], fallback: Date): Date {
  let latest = Number.NaN;
  for (const value of entries) {
    const entry = record(value);
    const message = record(entry?.message);
    if (entry?.type !== "message" || (message?.role !== "user" && message?.role !== "assistant") || !("content" in message)) continue;
    const timestamp =
      typeof message.timestamp === "number" ? message.timestamp : typeof entry.timestamp === "string" ? new Date(entry.timestamp).getTime() : Number.NaN;
    if (!Number.isNaN(timestamp)) latest = Number.isNaN(latest) ? timestamp : Math.max(latest, timestamp);
  }
  return Number.isNaN(latest) ? fallback : new Date(latest);
}

function selectedSessionInfo(
  candidate: SessionCandidate,
  header: Record<string, unknown>,
  entries: readonly unknown[],
  messages: readonly SessionCompareMessage[],
): SessionReference {
  let name: string | undefined;
  for (const value of entries) {
    const entry = record(value);
    if (entry?.type !== "session_info") continue;
    name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
  }
  const firstMessage = messages.find((message) => message.role === "user")?.text;
  const base: SessionReference = {
    id: header.id as string,
    path: candidate.path,
    modified: logicalModified(entries, candidate.modified),
  };
  const session = firstMessage === undefined ? base : { ...base, firstMessage };
  return name === undefined ? session : { ...session, name };
}

function sessionCwdMatches(value: unknown, expectedCwd: string): boolean {
  return value === undefined || value === "" || (typeof value === "string" && resolve(value) === resolve(expectedCwd));
}

async function readSession(candidate: SessionCandidate, signal: AbortSignal): Promise<ReadSession> {
  try {
    const bytes = await readBoundedFile(candidate.path, maxSessionFileBytes, "Session comparison file", signal);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    for (const line of text.split("\n")) if (line.trim() !== "") JSON.parse(line);
    const entries = parseSessionEntries(text);
    const header = record(entries[0]);
    if (
      header?.type !== "session" ||
      typeof header.id !== "string" ||
      (candidate.expectedId !== undefined && header.id !== candidate.expectedId) ||
      !sessionCwdMatches(header.cwd, candidate.expectedCwd)
    )
      throw new Error("Session comparison file changed during execution");
    const messages = sessionMessageEntries(entries);
    return { session: selectedSessionInfo(candidate, header, entries, messages), messages };
  } catch (error) {
    if (signal.aborted) throw new Error("Session comparison was cancelled", { cause: error });
    throw error;
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Session comparison was cancelled", { cause: signal.reason });
}

function headerSessionCandidate(value: unknown, path: string, modified: Date, expectedCwd: string): { candidate: SessionCandidate; id: string } | undefined {
  const header = record(value);
  if (header?.type !== "session" || typeof header.id !== "string" || !sessionCwdMatches(header.cwd, expectedCwd)) return undefined;
  return {
    id: header.id,
    candidate: { path, expectedCwd, expectedId: header.id, modified },
  };
}

async function readSessionHeader(path: string, expectedCwd: string, signal: AbortSignal): Promise<{ candidate: SessionCandidate; id: string } | undefined> {
  throwIfCancelled(signal);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    throwIfCancelled(signal);
    const metadata = await handle.stat();
    throwIfCancelled(signal);
    if (!metadata.isFile()) return undefined;
    const chunks: Buffer[] = [];
    let total = 0;
    let newline = -1;
    while (total < maxSessionHeaderBytes) {
      throwIfCancelled(signal);
      const buffer = Buffer.allocUnsafe(Math.min(16 * 1024, maxSessionHeaderBytes - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      throwIfCancelled(signal);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const index = chunk.indexOf(0x0a);
      chunks.push(index === -1 ? chunk : chunk.subarray(0, index));
      total += index === -1 ? chunk.length : index;
      if (index !== -1) {
        newline = total;
        break;
      }
    }
    throwIfCancelled(signal);
    if (newline === -1 && metadata.size > total) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    return headerSessionCandidate(JSON.parse(text), path, metadata.mtime, expectedCwd);
  } catch {
    throwIfCancelled(signal);
    return undefined;
  } finally {
    await handle?.close();
  }
}

function sessionMatches(session: { candidate: SessionCandidate; id: string }, requested: string): boolean {
  return (
    session.id === requested ||
    basename(session.candidate.path) === requested ||
    (isAbsolute(requested) && resolve(requested) === resolve(session.candidate.path))
  );
}

function directCandidate(directory: string, requested: string): { path: string; authoritative: boolean } | undefined {
  const root = resolve(directory);
  if (isAbsolute(requested)) {
    const path = resolve(requested);
    return dirname(path) === root && basename(path).endsWith(".jsonl") ? { path, authoritative: true } : undefined;
  }
  if (basename(requested) !== requested) return undefined;
  if (requested.endsWith(".jsonl")) return { path: join(root, requested), authoritative: true };
  if (/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(requested)) return { path: join(root, `${requested}.jsonl`), authoritative: false };
  return undefined;
}

async function inspectDirectCandidate(path: string, expectedCwd: string, signal: AbortSignal): Promise<SessionCandidate | undefined> {
  try {
    throwIfCancelled(signal);
    const metadata = await lstat(path);
    throwIfCancelled(signal);
    return metadata.isFile() ? { path, expectedCwd, modified: metadata.mtime } : undefined;
  } catch {
    throwIfCancelled(signal);
    return undefined;
  }
}

async function findSessions(
  cwd: string,
  directory: string,
  leftRequested: string,
  rightRequested: string,
  signal: AbortSignal,
  check: () => void,
): Promise<[SessionCandidate, SessionCandidate]> {
  const expectedCwd = resolve(cwd);
  const found = new Map<string, SessionCandidate>();
  const requested = [...new Set([leftRequested, rightRequested])];
  for (const key of requested) {
    const direct = directCandidate(directory, key);
    if (direct?.authoritative === true) {
      const candidate = await inspectDirectCandidate(direct.path, expectedCwd, signal);
      if (candidate !== undefined) found.set(key, candidate);
    } else if (direct !== undefined) {
      const session = await readSessionHeader(direct.path, expectedCwd, signal);
      if (session !== undefined && sessionMatches(session, key)) found.set(key, session.candidate);
    }
    check();
  }
  if (found.size < requested.length) {
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      handle = await opendir(directory);
    } catch (error) {
      check();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (handle !== undefined) {
      try {
        check();
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
      for await (const entry of handle) {
        check();
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const session = await readSessionHeader(join(directory, entry.name), expectedCwd, signal);
        check();
        if (session === undefined) continue;
        for (const key of requested) if (!found.has(key) && sessionMatches(session, key)) found.set(key, session.candidate);
        if (found.size === requested.length) break;
      }
    }
  }
  check();
  const left = found.get(leftRequested);
  const right = found.get(rightRequested);
  if (left === undefined) throw new Error(`Session was not found: ${leftRequested}`);
  if (right === undefined) throw new Error(`Session was not found: ${rightRequested}`);
  return [left, right];
}

async function compareSessions(
  cwd: string,
  directory: string,
  leftId: string,
  rightId: string,
  signal: AbortSignal,
  check: () => void,
): Promise<SessionCompareReport> {
  check();
  const leftRequested = leftId.trim();
  const rightRequested = rightId.trim();
  if (leftRequested === "") throw new Error("Session id is required");
  if (rightRequested === "") throw new Error("Session id is required");
  const [leftSession, rightSession] = await findSessions(cwd, directory, leftRequested, rightRequested, signal, check);
  check();
  const [left, right] = await Promise.all([readSession(leftSession, signal), readSession(rightSession, signal)]);
  check();
  const diff = compareMessageEntries(left.messages, right.messages);
  return {
    ...diff,
    left: side(left.session, left.messages),
    right: side(right.session, right.messages),
    changed: diff.shared !== left.messages.length || diff.shared !== right.messages.length,
    comparedAt: new Date().toISOString(),
  };
}

function renderMessage(message: SessionCompareMessage): string {
  return `[${message.role}] ${message.text}`;
}

function renderReport(report: SessionCompareReport): string {
  const lines = [
    `Compared ${report.left.id} with ${report.right.id}: ${report.changed ? "changed" : "identical text-message projection"}.`,
    `Shared messages: ${report.shared}. Added in right: ${report.addedCount}. Removed from left: ${report.removedCount}.`,
  ];
  lines.push("Scope: non-empty trimmed message text, compared by journal position; images, tool-call payloads, metadata and non-message entries are excluded.");
  if (report.addedTruncated || report.removedTruncated) lines.push("Difference previews are limited to 40 messages per side and 4,000 characters per message.");
  if (report.added.length > 0) lines.push(`Added:\n${report.added.map(renderMessage).join("\n")}`);
  if (report.removed.length > 0) lines.push(`Removed:\n${report.removed.map(renderMessage).join("\n")}`);
  return lines.join("\n\n");
}

export default {
  name: "pi-session-compare",
  inject: ["piHarnessLaunch", "piSession", "piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    let latest: SessionCompareReport | undefined;
    const lifecycle = new AbortController();
    context.effect(() => () => lifecycle.abort());
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
      }
      return currentContext;
    };

    const unregister = context.piTools.register(
      defineTool({
        name: "session_compare",
        label: "Compare sessions",
        description: "Compare two persisted Pi JSONL sessions by message role and text without modifying either file.",
        promptSnippet: "compare two persisted Pi sessions",
        parameters: Type.Object(
          {
            left: Type.String({ description: "Left session id, filename or full path" }),
            right: Type.String({ description: "Right session id, filename or full path" }),
          },
          { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<SessionCompareReport>> {
          const combined = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          if (combined.aborted) throw new Error("Session comparison was cancelled");
          const operationContext = refreshContext();
          const check = () => {
            if (combined.aborted) throw new Error("Session comparison was cancelled");
            if (refreshContext() !== operationContext) throw new Error("Session comparison context changed during execution");
          };
          if (params === null || typeof params !== "object" || Array.isArray(params)) throw new Error("Session comparison parameters must be an object");
          const descriptors = Object.getOwnPropertyDescriptors(params);
          if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !["left", "right"].includes(key)))
            throw new Error("Unknown session comparison parameter");
          const parameter = (key: "left" | "right"): string => {
            const descriptor = descriptors[key];
            const value: unknown = descriptor?.value;
            if (
              descriptor === undefined ||
              !("value" in descriptor) ||
              typeof value !== "string" ||
              value.trim() === "" ||
              value.length > 4096 ||
              value.includes("\0")
            )
              throw new Error(`Invalid session comparison ${key}`);
            return value;
          };
          const report = await compareSessions(operationContext.cwd, operationContext.directory, parameter("left"), parameter("right"), combined, check);
          check();
          latest = structuredClone(report);
          return { content: [{ type: "text", text: renderReport(report) }], details: report };
        },
      }),
    );
    context.effect(() => unregister);
    const disposePanel = context.piPluginUi.register({
      id: "session-compare-panel",
      pluginId: "@pi-harness/plugin-session-compare",
      title: "Session Compare",
      description: "对比两个持久化会话的消息差异，不修改原始会话文件。",
      icon: "⇄",
      read: () => {
        refreshContext();
        return latest === undefined
          ? { left: null, right: null, shared: 0, added: [], removed: [], changed: false, comparedAt: null }
          : structuredClone(latest);
      },
    });
    context.effect(() => disposePanel);
  },
};
