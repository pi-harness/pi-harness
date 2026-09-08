import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, parseSessionEntries, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { assertKnownConfigKeys, readBoundedFile } from "@pi-harness/plugin-api";

const defaultMaxSessions = 100;
const maxAllowedSessions = 500;
const maxPreviewChars = 500;
const maxContentParts = 1_000;
const maxSessionFileBytes = 4 * 1024 * 1024;
const sessionReadConcurrency = 8;
const maxDirectoryEntries = 4_096;
const maxPanelItems = 50;
const maxToolItems = 100;
const maxSessionIdChars = 256;
const maxSessionNameChars = 256;
const maxSessionPathChars = 4_096;
const maxQueryLength = 120;
const maxStatusErrorChars = 2_000;
const queryParameterNames = new Set(["query"]);

export interface RecallUnreadPluginConfig {
  maxSessions?: number;
}

export const Config: z<RecallUnreadPluginConfig> = z.object({
  maxSessions: z.number().min(1).max(maxAllowedSessions).step(1).default(defaultMaxSessions),
});

export interface UnreadSession {
  id: string;
  path: string;
  cwd: string;
  name: string;
  modified: string;
  messageCount: number;
  message: string;
}

type DataProperty = { found: true; value: unknown } | { found: false };

function record(value: unknown): object | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function dataProperty(value: unknown, name: string): DataProperty {
  const item = record(value);
  if (item === undefined) return { found: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(item, name);
    return descriptor !== undefined && "value" in descriptor ? { found: true, value: descriptor.value } : { found: false };
  } catch {
    return { found: false };
  }
}

function arrayData(value: readonly unknown[], index: number): DataProperty {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return descriptor !== undefined && "value" in descriptor ? { found: true, value: descriptor.value } : { found: false };
  } catch {
    return { found: false };
  }
}

function appendBoundedText(state: { text: string; started: boolean; hasContentAfterLimit: boolean }, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (!state.started) {
      if (/\s/u.test(character)) continue;
      state.started = true;
    }
    if (state.text.length < maxPreviewChars) state.text += character;
    else if (!/\s/u.test(character)) state.hasContentAfterLimit = true;
  }
}

function contentText(value: unknown): string {
  const state = { text: "", started: false, hasContentAfterLimit: false };
  if (typeof value === "string") appendBoundedText(state, value);
  else if (Array.isArray(value)) {
    let textParts = 0;
    for (let index = 0; index < Math.min(value.length, maxContentParts); index += 1) {
      const part = arrayData(value, index);
      if (!part.found) continue;
      const type = dataProperty(part.value, "type");
      const text = dataProperty(part.value, "text");
      if (!type.found || type.value !== "text" || !text.found || typeof text.value !== "string") continue;
      if (textParts > 0) appendBoundedText(state, "\n");
      appendBoundedText(state, text.value);
      textParts += 1;
    }
  }
  return state.text.length < maxPreviewChars || !state.hasContentAfterLimit ? state.text.trimEnd() : state.text;
}

export function unreadUserMessage(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = arrayData(entries, index);
    if (!entry.found) continue;
    const entryType = dataProperty(entry.value, "type");
    if (!entryType.found || entryType.value !== "message") continue;
    const messageProperty = dataProperty(entry.value, "message");
    if (!messageProperty.found) continue;
    const message = record(messageProperty.value);
    if (message === undefined) continue;
    const role = dataProperty(message, "role");
    if (!role.found || typeof role.value !== "string") continue;
    if (role.value !== "user") return undefined;
    const content = dataProperty(message, "content");
    if (!content.found) continue;
    const text = contentText(content.value);
    return text === "" ? undefined : text;
  }
  return undefined;
}

type SessionCandidate = { path: string; modified: Date };
type RecallInventory = {
  available: number;
  candidates: number;
  scanned: number;
  unread: number;
  shown: number;
  truncated: boolean;
  discoveryTruncated: boolean;
  scanTruncated: boolean;
  displayTruncated: boolean;
};
type SessionDiscovery = { candidates: SessionCandidate[]; available: number; truncated: boolean };
type RecallStatus = { state: "running" | "completed" | "failed" | "cancelled"; at?: string; error?: string };

function boundedMetadataText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized.slice(0, maximum);
}

function sessionId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxSessionIdChars || value.includes("\0")) return undefined;
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value) ? value : undefined;
}

function sessionCwd(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxSessionPathChars || value.includes("\0") || !isAbsolute(value)) return undefined;
  return value;
}

function queryParameter(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Recall Unread parameters must be an object");
  let prototype: unknown;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error("Recall Unread parameters must be a plain object with data properties");
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Recall Unread parameters must be a plain object");
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !queryParameterNames.has(key)))
    throw new Error("Recall Unread parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Recall Unread parameters must use data properties");
  const query = descriptors.query?.value as unknown;
  if (query !== undefined && typeof query !== "string") throw new Error("Recall Unread query must be a string");
  const normalized = (query ?? "").trim();
  if (normalized.length > maxQueryLength) throw new Error(`Recall unread query must contain 0-${maxQueryLength} characters`);
  if (normalized.includes("\0")) throw new Error("Recall Unread query must not contain NUL characters");
  return normalized.toLocaleLowerCase();
}

function boundedError(error: unknown): string {
  if (typeof error === "string") return error.slice(0, maxStatusErrorChars);
  if (error !== null && typeof error === "object") {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") return descriptor.value.slice(0, maxStatusErrorChars);
    } catch {
      // Fall through to the stable message below.
    }
  }
  return "Unknown Recall Unread error";
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Recall Unread scan was cancelled", { cause: signal.reason });
}

async function discoverSessionCandidates(sessionDir: string, activePath: string | undefined, signal: AbortSignal): Promise<SessionDiscovery> {
  throwIfCancelled(signal);
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await opendir(sessionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { candidates: [], available: 0, truncated: false };
    throw error;
  }
  const candidates: SessionCandidate[] = [];
  let available = 0;
  let inspected = 0;
  let truncated = false;
  for await (const entry of directory) {
    throwIfCancelled(signal);
    inspected += 1;
    if (inspected > maxDirectoryEntries) {
      truncated = true;
      break;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(sessionDir, entry.name);
    try {
      const metadata = await lstat(path);
      throwIfCancelled(signal);
      if (!metadata.isFile() || !Number.isFinite(metadata.mtimeMs)) continue;
      available += 1;
      if (path.length > maxSessionPathChars || (activePath !== undefined && resolve(path) === resolve(activePath))) continue;
      candidates.push({ path, modified: metadata.mtime });
    } catch {
      // Files may disappear or change type while the directory is being scanned.
    }
  }
  return { candidates: candidates.sort((left, right) => right.modified.getTime() - left.modified.getTime()), available, truncated };
}

function sessionMetadata(entries: readonly unknown[], candidate: SessionCandidate, expectedCwd: string): Omit<UnreadSession, "message"> | undefined {
  const headerEntry = arrayData(entries, 0);
  if (!headerEntry.found) return undefined;
  const headerType = dataProperty(headerEntry.value, "type");
  if (!headerType.found || headerType.value !== "session") return undefined;
  const idProperty = dataProperty(headerEntry.value, "id");
  const cwdProperty = dataProperty(headerEntry.value, "cwd");
  const id = sessionId(idProperty.found ? idProperty.value : undefined);
  const cwd = sessionCwd(cwdProperty.found ? cwdProperty.value : undefined);
  if (id === undefined || cwd === undefined || resolve(cwd) !== resolve(expectedCwd)) return undefined;

  let name: string | undefined;
  let firstMessage: string | undefined;
  let messageCount = 0;
  for (let index = 1; index < entries.length; index += 1) {
    const entry = arrayData(entries, index);
    if (!entry.found) continue;
    const type = dataProperty(entry.value, "type");
    if (!type.found) continue;
    if (type.value === "session_info") {
      const rawName = dataProperty(entry.value, "name");
      name = boundedMetadataText(rawName.found ? rawName.value : undefined, maxSessionNameChars);
      continue;
    }
    if (type.value !== "message") continue;
    messageCount += 1;
    if (firstMessage !== undefined) continue;
    const messageProperty = dataProperty(entry.value, "message");
    if (!messageProperty.found) continue;
    const role = dataProperty(messageProperty.value, "role");
    const content = dataProperty(messageProperty.value, "content");
    if (!role.found || role.value !== "user" || !content.found) continue;
    firstMessage = contentText(content.value);
  }
  return {
    id,
    path: candidate.path,
    cwd,
    name: name ?? boundedMetadataText(firstMessage, maxSessionNameChars) ?? id,
    modified: candidate.modified.toISOString(),
    messageCount,
  };
}

async function unreadSession(candidate: SessionCandidate, activeId: string, expectedCwd: string, signal: AbortSignal): Promise<UnreadSession | undefined> {
  try {
    throwIfCancelled(signal);
    const bytes = await readBoundedFile(candidate.path, maxSessionFileBytes, "Pi session file");
    throwIfCancelled(signal);
    const entries = parseSessionEntries(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const metadata = sessionMetadata(entries, candidate, expectedCwd);
    if (metadata === undefined || metadata.id === activeId) return undefined;
    const message = unreadUserMessage(entries);
    return message === undefined ? undefined : { ...metadata, message };
  } catch {
    throwIfCancelled(signal);
    return undefined;
  }
}

async function unreadSessions(candidates: readonly SessionCandidate[], activeId: string, expectedCwd: string, signal: AbortSignal): Promise<UnreadSession[]> {
  const results: UnreadSession[] = [];
  for (let index = 0; index < candidates.length; index += sessionReadConcurrency) {
    throwIfCancelled(signal);
    const batch = await Promise.all(
      candidates.slice(index, index + sessionReadConcurrency).map((candidate) => unreadSession(candidate, activeId, expectedCwd, signal)),
    );
    throwIfCancelled(signal);
    results.push(...batch.filter((item): item is UnreadSession => item !== undefined));
  }
  return results;
}

export default {
  name: "pi-recall-unread",
  inject: ["piHarnessLaunch", "piSession", "piPluginUi", "piTools"],
  Config,
  async apply(context: Context, config: RecallUnreadPluginConfig) {
    assertKnownConfigKeys("pi-recall-unread", config, ["maxSessions"]);
    const configuredMaxSessions = config.maxSessions ?? defaultMaxSessions;
    const maxSessions = Number.isFinite(configuredMaxSessions)
      ? Math.max(1, Math.min(maxAllowedSessions, Math.trunc(configuredMaxSessions)))
      : defaultMaxSessions;
    const lifecycle = new AbortController();
    let items: UnreadSession[] = [];
    let scans = 0;
    let inventory: RecallInventory = {
      available: 0,
      candidates: 0,
      scanned: 0,
      unread: 0,
      shown: 0,
      truncated: false,
      discoveryTruncated: false,
      scanTruncated: false,
      displayTruncated: false,
    };
    let status: RecallStatus = { state: "running" };
    let scanQueue: Promise<void> = Promise.resolve();
    let operationSequence = 0;
    const runExclusive = <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
      const result = scanQueue.then(
        async () => {
          throwIfCancelled(signal);
          return operation();
        },
        async () => {
          throwIfCancelled(signal);
          return operation();
        },
      );
      scanQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const activeManager = () => context.get("piRuntime")?.session.sessionManager ?? context.piSession.manager;
    const scan = async (signal: AbortSignal): Promise<UnreadSession[]> => {
      throwIfCancelled(signal);
      const manager = activeManager();
      const activeId = manager.getSessionId();
      const activePath = manager.getSessionFile();
      const cwd = manager.getCwd();
      const discovery = await discoverSessionCandidates(manager.getSessionDir(), activePath, signal);
      const scannedCandidates = discovery.candidates.slice(0, maxSessions);
      const nextItems = await unreadSessions(scannedCandidates, activeId, cwd, signal);
      if (activeManager() !== manager || manager.getSessionId() !== activeId || manager.getSessionFile() !== activePath || manager.getCwd() !== cwd)
        throw new Error("Recall Unread session changed during scanning; run the scan again");
      throwIfCancelled(signal);
      const shown = Math.min(nextItems.length, maxPanelItems);
      const scanTruncated = discovery.candidates.length > scannedCandidates.length;
      const displayTruncated = nextItems.length > shown;
      const nextInventory: RecallInventory = {
        available: discovery.available,
        candidates: discovery.candidates.length,
        scanned: scannedCandidates.length,
        unread: nextItems.length,
        shown,
        truncated: discovery.truncated || scanTruncated || displayTruncated,
        discoveryTruncated: discovery.truncated,
        scanTruncated,
        displayTruncated,
      };
      throwIfCancelled(signal);
      items = structuredClone(nextItems);
      inventory = { ...nextInventory };
      scans += 1;
      return structuredClone(items);
    };
    const unregister = context.piTools.register(
      defineTool({
        name: "session_recall_unread",
        label: "Recall unread sessions",
        description: "Find persisted Pi sessions whose latest message is an unanswered user message without modifying the sessions.",
        promptSnippet: "find previous sessions with unanswered user messages",
        parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: maxQueryLength })) }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(
          _toolCallId,
          params,
          signal,
        ): Promise<
          AgentToolResult<{
            total: number;
            items: UnreadSession[];
            inventory: RecallInventory & { matched: number; shown: number; resultTruncated: boolean };
          }>
        > {
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          const sequence = ++operationSequence;
          status = { state: "running" };
          try {
            const result = await runExclusive(operationSignal, async () => {
              throwIfCancelled(operationSignal);
              const query = queryParameter(params);
              const scanned = await scan(operationSignal);
              throwIfCancelled(operationSignal);
              const matches = scanned.filter((item) => query === "" || `${item.name} ${item.message} ${item.cwd}`.toLocaleLowerCase().includes(query));
              const shown = matches.slice(0, maxToolItems);
              const resultTruncated = matches.length > shown.length;
              const resultInventory = {
                ...inventory,
                matched: matches.length,
                shown: shown.length,
                resultTruncated,
                truncated: inventory.truncated || resultTruncated,
              };
              return {
                content: [
                  {
                    type: "text" as const,
                    text: shown.map((item) => `${item.name}: ${item.message}`).join("\n") || "No unanswered sessions found.",
                  },
                ],
                details: structuredClone({ total: matches.length, items: shown, inventory: resultInventory }),
              };
            });
            if (sequence === operationSequence) status = { state: "completed", at: new Date().toISOString() };
            return result;
          } catch (error) {
            if (sequence === operationSequence)
              status = {
                state: operationSignal.aborted ? "cancelled" : "failed",
                at: new Date().toISOString(),
                error: boundedError(error),
              };
            throw error;
          }
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "recall-unread-panel",
        pluginId: "@pi-harness/plugin-recall-unread",
        title: "Recall Unread",
        description: "查看以未回答用户消息结束的原生 Pi 会话，只读不修改。",
        icon: "◌",
        read: () => ({
          scans,
          total: items.length,
          items: structuredClone(items.slice(0, maxPanelItems)),
          inventory: { ...inventory },
          status: { ...status },
          limits: {
            directoryEntries: maxDirectoryEntries,
            sessionBytes: maxSessionFileBytes,
            sessions: maxSessions,
            allowedSessions: maxAllowedSessions,
            readConcurrency: sessionReadConcurrency,
            contentParts: maxContentParts,
            previewCharacters: maxPreviewChars,
            panelItems: maxPanelItems,
            toolItems: maxToolItems,
            queryCharacters: maxQueryLength,
            sessionIdCharacters: maxSessionIdChars,
            sessionNameCharacters: maxSessionNameChars,
            sessionPathCharacters: maxSessionPathChars,
            statusErrorCharacters: maxStatusErrorChars,
          },
        }),
      });
    } catch (error) {
      lifecycle.abort(new Error("Recall Unread plugin activation failed", { cause: error }));
      unregister();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Recall Unread plugin was disposed"));
      unregister();
      disposePanel();
    });
    try {
      await scan(lifecycle.signal);
      status = { state: "completed", at: new Date().toISOString() };
    } catch (error) {
      status = { state: "failed", at: new Date().toISOString(), error: boundedError(error) };
    }
  },
};
