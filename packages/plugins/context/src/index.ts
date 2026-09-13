import type { Context } from "@deepseek-ai/cordis";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { EmptyConfig } from "@pi-harness/plugin-api";

type RuntimeEvent = AgentSessionEvent & { readonly type?: string };
type MessageRole = "user" | "assistant" | "toolResult" | "system" | "other";
type ContextComposition = Record<MessageRole, number>;
type ContextInsightReport = {
  sessionId: string | null;
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  messages: number;
  scannedMessages: number;
  messagesTruncated: boolean;
  events: number;
  compactions: number;
  composition: ContextComposition;
  eventTypes: Record<string, number>;
  recentEvents: { type: string; at: number }[];
};
type ContextSessionSnapshot = Pick<
  ContextInsightReport,
  "tokens" | "contextWindow" | "percent" | "messages" | "scannedMessages" | "messagesTruncated" | "composition"
>;

const maxRecentEvents = 50;
const maxEventTypes = 64;
const maxEventTypeLength = 128;
const maxScannedMessages = 10_000;
const contextRefreshEvents = new Set(["message_end", "tool_execution_end", "agent_end", "agent_settled", "compaction_end", "entry_appended"]);

function boundedCount(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function normalizedEventType(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const type = value.trim().replaceAll("\0", "�");
  if (type.length === 0) return "unknown";
  return type.length <= maxEventTypeLength ? type : "other";
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseEmptyParams(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Context inspect parameters must be an object");
  let prototype: unknown;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error("Context inspect parameters could not be inspected safely");
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Context inspect parameters must be a plain object");
  if (Reflect.ownKeys(descriptors).length > 0) throw new Error("Context inspect parameters contain an unknown property");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Context inspection was cancelled", { cause: signal.reason });
}

function dataProperty(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function messageRole(message: unknown): MessageRole {
  if (typeof message !== "object" || message === null) return "other";
  const role = dataProperty(message, "role");
  if (role === "user" || role === "assistant" || role === "toolResult" || role === "system") return role;
  return "other";
}

export default {
  name: "pi-context",
  inject: ["piPluginUi", "piTools"],
  Config: EmptyConfig,
  apply(context: Context) {
    const lifecycle = new AbortController();
    let eventCount = 0;
    let compactionCount = 0;
    const eventTypes = new Map<string, number>();
    const recentEvents: { type: string; at: number }[] = [];
    let cachedSession: unknown;
    let cachedSessionId: string | undefined;
    let cachedSnapshot: ContextSessionSnapshot = {
      tokens: null,
      contextWindow: null,
      percent: null,
      messages: 0,
      scannedMessages: 0,
      messagesTruncated: false,
      composition: { user: 0, assistant: 0, toolResult: 0, system: 0, other: 0 },
    };
    const resetEvents = (): void => {
      eventCount = 0;
      compactionCount = 0;
      eventTypes.clear();
      recentEvents.length = 0;
    };
    const refreshSnapshot = (): void => {
      const runtime = context.get("piRuntime");
      const session = runtime?.session;
      const sessionId = session?.sessionId;
      if (session !== cachedSession || sessionId !== cachedSessionId) resetEvents();
      cachedSession = session;
      cachedSessionId = sessionId;
      let usage: unknown;
      if (session !== undefined) {
        try {
          usage = session.getContextUsage();
        } catch {
          usage = undefined;
        }
      }
      let messages: readonly unknown[] = [];
      if (session !== undefined) {
        try {
          if (Array.isArray(session.messages)) messages = session.messages;
        } catch {
          messages = [];
        }
      }
      const rawMessageCount = dataProperty(messages, "length");
      const messageCount = typeof rawMessageCount === "number" && Number.isSafeInteger(rawMessageCount) && rawMessageCount >= 0 ? rawMessageCount : 0;
      const scannedMessages = Math.min(messageCount, maxScannedMessages);
      const start = messageCount - scannedMessages;
      const composition: ContextComposition = { user: 0, assistant: 0, toolResult: 0, system: 0, other: 0 };
      for (let index = start; index < messageCount; index += 1) composition[messageRole(dataProperty(messages, String(index)))] += 1;
      cachedSnapshot = {
        tokens: nonNegativeInteger(dataProperty(usage, "tokens")),
        contextWindow: nonNegativeInteger(dataProperty(usage, "contextWindow")),
        percent: validPercent(dataProperty(usage, "percent")),
        messages: messageCount,
        scannedMessages,
        messagesTruncated: messageCount > scannedMessages,
        composition,
      };
    };
    const ensureCurrentSession = (): void => {
      const session = context.get("piRuntime")?.session;
      if (session !== cachedSession || session?.sessionId !== cachedSessionId) refreshSnapshot();
    };
    const report = (): ContextInsightReport => {
      ensureCurrentSession();
      return {
        sessionId: cachedSessionId ?? null,
        ...cachedSnapshot,
        composition: { ...cachedSnapshot.composition },
        events: eventCount,
        compactions: compactionCount,
        eventTypes: Object.fromEntries(eventTypes),
        recentEvents: recentEvents.map((event) => ({ ...event })),
      };
    };
    const onEvent = (event: RuntimeEvent) => {
      ensureCurrentSession();
      eventCount = boundedCount(eventCount);
      let type = normalizedEventType(dataProperty(event, "type"));
      if (!eventTypes.has(type) && eventTypes.size >= maxEventTypes - 1) type = "other";
      eventTypes.set(type, boundedCount(eventTypes.get(type) ?? 0));
      recentEvents.push({ type, at: Date.now() });
      if (recentEvents.length > maxRecentEvents) recentEvents.shift();
      if (type === "compaction_start") compactionCount = boundedCount(compactionCount);
      if (contextRefreshEvents.has(type)) refreshSnapshot();
    };
    const unsubscribe = context.on("pi/session-event", onEvent);
    context.effect(() => () => {
      lifecycle.abort(new Error("Context Insights plugin disposed"));
      unsubscribe();
    });
    refreshSnapshot();
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "context_inspect",
        label: "Context inspect",
        description: "Inspect current context usage, message composition, and recent lifecycle events.",
        promptSnippet: "inspect the current context composition and recent events",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "sequential",
        execute(_toolCallId, params, signal): Promise<AgentToolResult<ContextInsightReport>> {
          return Promise.resolve().then(() => {
            parseEmptyParams(params);
            const actionSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
            throwIfAborted(actionSignal);
            refreshSnapshot();
            const details = report();
            return {
              content: [
                { type: "text" as const, text: `${details.messages} messages (${details.scannedMessages} scanned), ${details.events} context events.` },
              ],
              details,
            };
          });
        },
      }),
    );
    context.effect(() => unregisterTool);
    const disposePanel = context.piPluginUi.register({
      id: "context-insight-panel",
      pluginId: "@pi-harness/plugin-context",
      title: "上下文洞察",
      description: "查看当前上下文占用、消息规模和压缩事件。",
      icon: "◒",
      read: () => ({
        ...report(),
        limits: {
          scannedMessages: maxScannedMessages,
          recentEvents: maxRecentEvents,
          eventTypes: maxEventTypes,
          eventTypeCharacters: maxEventTypeLength,
        },
      }),
    });
    context.effect(() => disposePanel);
  },
};
