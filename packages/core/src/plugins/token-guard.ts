import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { assertKnownConfigKeys } from "../config.js";

export interface TokenGuardPluginConfig {
  maxPercent?: number;
  maxRunTokens?: number;
}

type UsageSnapshot = {
  percent: number | null;
  tokens: number | null;
  contextWindow: number;
  error: string | null;
};

type TokenSnapshot = { total: number | null; error: string | null };

const maxErrorLength = 2_000;
const streamingUpdateInterval = 32;
const inspectionEventTypes = new Set(["message_end", "turn_end", "tool_execution_end", "agent_end", "agent_settled", "compaction_end", "entry_appended"]);

export const Config: z<TokenGuardPluginConfig> = z.object({
  maxPercent: z.number().min(1).max(100).default(90),
  maxRunTokens: z.number().min(0).max(10_000_000).step(1).default(0),
});

function dataProperty(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedError(prefix: string, error: unknown): string {
  let message: string | undefined;
  if (typeof error === "string") message = error;
  else {
    const value = dataProperty(error, "message");
    if (typeof value === "string") message = value;
  }
  const suffix = (message ?? "unknown error").replaceAll("\0", "�");
  return `${prefix}: ${suffix}`.slice(0, maxErrorLength);
}

function nullableCount(value: unknown): number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ? value : null;
}

function readUsage(session: { getContextUsage: () => unknown }): UsageSnapshot {
  let usage: unknown;
  try {
    usage = session.getContextUsage();
  } catch (error) {
    return { percent: null, tokens: null, contextWindow: 0, error: boundedError("Context usage inspection failed", error) };
  }
  if (usage === undefined) return { percent: null, tokens: null, contextWindow: 0, error: null };
  const rawPercent = dataProperty(usage, "percent");
  const rawTokens = dataProperty(usage, "tokens");
  const tokens = nullableCount(rawTokens);
  const contextWindow = dataProperty(usage, "contextWindow");
  if (
    (rawPercent !== null && (typeof rawPercent !== "number" || !Number.isFinite(rawPercent) || rawPercent < 0)) ||
    (rawTokens !== null && tokens === null) ||
    typeof contextWindow !== "number" ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0
  ) {
    return { percent: null, tokens: null, contextWindow: 0, error: "Context usage response is invalid" };
  }
  return { percent: rawPercent, tokens, contextWindow, error: null };
}

function readSessionTokens(session: { getSessionStats?: () => unknown }): TokenSnapshot {
  if (typeof session.getSessionStats !== "function") return { total: null, error: "Session statistics are unavailable for the configured run-token budget" };
  let stats: unknown;
  try {
    stats = session.getSessionStats();
  } catch (error) {
    return { total: null, error: boundedError("Session statistics inspection failed", error) };
  }
  const total = dataProperty(dataProperty(stats, "tokens"), "total");
  return typeof total === "number" && Number.isSafeInteger(total) && total >= 0
    ? { total, error: null }
    : { total: null, error: "Session statistics response is invalid" };
}

function boundedCount(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

export default {
  name: "pi-token-guard",
  inject: ["piRuntime", "piPluginUi"],
  Config,
  apply(context: Context, config: TokenGuardPluginConfig) {
    assertKnownConfigKeys("pi-token-guard", config, ["maxPercent", "maxRunTokens"]);
    const maxPercent = config.maxPercent ?? 90;
    const maxRunTokens = config.maxRunTokens ?? 0;
    let activeSession: unknown;
    let abortCount = 0;
    let lastPercent: number | null = null;
    let lastTokens: number | null = null;
    let lastContextWindow = 0;
    let lastExceeded = false;
    let abortIssued = false;
    let runStartTokens: number | null = null;
    let runTokens: number | null = null;
    let runExceeded = false;
    let inspectionError: string | null = null;
    let abortError: string | null = null;
    let messageUpdatesSinceInspection = 0;
    let sampledCurrentStream = false;

    const resetForSession = (session: unknown): void => {
      activeSession = session;
      abortCount = 0;
      lastPercent = null;
      lastTokens = null;
      lastContextWindow = 0;
      lastExceeded = false;
      abortIssued = false;
      runStartTokens = null;
      runTokens = null;
      runExceeded = false;
      inspectionError = null;
      abortError = null;
      messageUpdatesSinceInspection = 0;
      sampledCurrentStream = false;
    };
    const requestAbort = (): void => {
      abortIssued = true;
      abortCount = boundedCount(abortCount);
      abortError = null;
      try {
        void context.piRuntime.abort().catch((error: unknown) => {
          abortError = boundedError("Token Guard could not abort the active run", error);
        });
      } catch (error) {
        abortError = boundedError("Token Guard could not abort the active run", error);
      }
    };
    const inspect = (eventType?: string): void => {
      const session = context.piRuntime.session;
      if (session !== activeSession) resetForSession(session);
      const usage = readUsage(session);
      const sessionTokens = maxRunTokens > 0 ? readSessionTokens(session) : { total: null, error: null };
      inspectionError = usage.error ?? sessionTokens.error;
      lastPercent = usage.percent;
      lastTokens = usage.tokens;
      lastContextWindow = usage.contextWindow;
      if (eventType === "agent_start") {
        runStartTokens = sessionTokens.total;
        runTokens = runStartTokens === null ? null : 0;
        runExceeded = false;
        abortIssued = false;
        abortError = null;
      } else {
        runTokens = runStartTokens === null || sessionTokens.total === null ? null : Math.max(0, sessionTokens.total - runStartTokens);
        runExceeded = maxRunTokens > 0 && runTokens !== null && runTokens >= maxRunTokens;
      }
      lastExceeded = (lastPercent !== null && lastPercent >= maxPercent) || runExceeded;
      if (lastExceeded && session.isStreaming && !abortIssued) requestAbort();
    };

    resetForSession(context.piRuntime.session);
    inspect();
    const unsubscribe = context.on("pi/session-event", (event) => {
      const type = dataProperty(event, "type");
      if (type === "agent_start") {
        messageUpdatesSinceInspection = 0;
        sampledCurrentStream = false;
        inspect(type);
        return;
      }
      if (type === "message_update") {
        if (!sampledCurrentStream) {
          sampledCurrentStream = true;
          inspect();
          return;
        }
        messageUpdatesSinceInspection += 1;
        if (messageUpdatesSinceInspection >= streamingUpdateInterval) {
          inspect();
          messageUpdatesSinceInspection = 0;
        }
        return;
      }
      if (typeof type === "string" && inspectionEventTypes.has(type)) {
        messageUpdatesSinceInspection = 0;
        sampledCurrentStream = false;
        inspect();
      }
    });
    context.effect(() => unsubscribe);
    const disposePanel = context.piPluginUi.register({
      id: "token-guard-panel",
      pluginId: "@pi-harness/core/plugins/token-guard",
      title: "Token Guard",
      description: "在上下文达到预算阈值时自动停止当前运行，避免继续消耗上下文。",
      icon: "◌",
      read: () => {
        if (context.piRuntime.session !== activeSession) inspect();
        return {
          maxPercent,
          maxRunTokens,
          percent: lastPercent,
          tokens: lastTokens,
          contextWindow: lastContextWindow,
          runTokens,
          runExceeded,
          exceeded: lastExceeded,
          aborts: abortCount,
          lastError: abortError ?? inspectionError,
          limits: { errorCharacters: maxErrorLength, streamingUpdateInterval },
        };
      },
    });
    context.effect(() => disposePanel);
  },
};
