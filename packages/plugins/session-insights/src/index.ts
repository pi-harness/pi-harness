import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {} from "@pi-harness/plugin-api";

export type SessionInsightsPluginConfig = Record<never, never>;

export const Config: z<SessionInsightsPluginConfig> = z.object({});

const toolParameterNames = new Set(["compact", "confirm"]);
const statsRefreshEvents = new Set(["message_end", "tool_execution_end", "agent_end", "agent_settled", "compaction_end", "entry_appended"]);
const maxSessionIdLength = 512;
const maxSessionFileLength = 4_096;
const maxCost = 1_000_000_000;
const maxErrorLength = 2_000;

function assertEmptyConfig(value: unknown): void {
  if (value === null || typeof value !== "object") throw new Error("Unknown session-insights config; supported keys are (none)");
  let hasUnknownKeys: boolean;
  try {
    hasUnknownKeys = Array.isArray(value) || Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length > 0;
  } catch (error) {
    throw new Error("Unknown session-insights config could not be inspected safely", { cause: error });
  }
  if (hasUnknownKeys) throw new Error("Unknown session-insights config keys; supported keys are (none)");
}

export interface SessionInsightsStats {
  readonly sessionFile: string | null;
  readonly sessionId: string;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly totalMessages: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: number;
  readonly contextUsage: {
    readonly tokens: number | null;
    readonly contextWindow: number;
    readonly percent: number | null;
  } | null;
}

interface SessionInsightsCompactionState {
  readonly status: "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";
  readonly requestedAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
}

export interface SessionInsightsDetails extends SessionInsightsStats {
  readonly compaction: SessionInsightsCompactionState;
}

function ownDataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return undefined;
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return undefined;
  }
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedText(value: unknown, maximum: number, allowUndefined: true): string | null | undefined;
function boundedText(value: unknown, maximum: number, allowUndefined: false): string | undefined;
function boundedText(value: unknown, maximum: number, allowUndefined: boolean): string | null | undefined {
  if (allowUndefined && value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\p{Cc}]/u.test(value)) return undefined;
  return value;
}

function snapshotStats(value: unknown): SessionInsightsStats {
  const source = ownDataRecord(value);
  const tokens = ownDataRecord(source?.tokens);
  const sessionFile = boundedText(source?.sessionFile, maxSessionFileLength, true);
  const sessionId = boundedText(source?.sessionId, maxSessionIdLength, false);
  const userMessages = count(source?.userMessages);
  const assistantMessages = count(source?.assistantMessages);
  const toolCalls = count(source?.toolCalls);
  const toolResults = count(source?.toolResults);
  const totalMessages = count(source?.totalMessages);
  const input = count(tokens?.input);
  const output = count(tokens?.output);
  const cacheRead = count(tokens?.cacheRead);
  const cacheWrite = count(tokens?.cacheWrite);
  const total = count(tokens?.total);
  const cost = source?.cost;
  if (
    source === undefined ||
    tokens === undefined ||
    sessionFile === undefined ||
    sessionId === undefined ||
    userMessages === undefined ||
    assistantMessages === undefined ||
    toolCalls === undefined ||
    toolResults === undefined ||
    totalMessages === undefined ||
    !Number.isSafeInteger(userMessages + assistantMessages + toolResults) ||
    userMessages + assistantMessages + toolResults > totalMessages ||
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    total === undefined ||
    !Number.isSafeInteger(input + output + cacheRead + cacheWrite) ||
    total !== input + output + cacheRead + cacheWrite ||
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    cost > maxCost
  )
    throw new Error("Session statistics response is invalid");

  let contextUsage: SessionInsightsStats["contextUsage"] = null;
  if (source.contextUsage !== undefined) {
    const usage = ownDataRecord(source.contextUsage);
    const usageTokens = usage?.tokens;
    const contextWindow = count(usage?.contextWindow);
    const percent = usage?.percent;
    const tokensValid = usageTokens === null || count(usageTokens) !== undefined;
    const percentValid = percent === null || (typeof percent === "number" && Number.isFinite(percent) && percent >= 0);
    const nullabilityMatches = (usageTokens === null) === (percent === null);
    const expectedPercent = typeof usageTokens === "number" && contextWindow !== undefined && contextWindow > 0 ? (usageTokens / contextWindow) * 100 : null;
    const percentMatches =
      expectedPercent === null ||
      (typeof percent === "number" && Math.abs(percent - expectedPercent) <= Math.max(1e-9, Math.abs(expectedPercent) * Number.EPSILON * 8));
    if (usage === undefined || !tokensValid || contextWindow === undefined || contextWindow <= 0 || !percentValid || !nullabilityMatches || !percentMatches)
      throw new Error("Session statistics context usage is invalid");
    contextUsage = { tokens: usageTokens as number | null, contextWindow, percent };
  }

  return {
    sessionFile,
    sessionId,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages,
    tokens: { input, output, cacheRead, cacheWrite, total },
    cost,
    contextUsage,
  };
}

function cloneDetails(stats: SessionInsightsStats, compaction: SessionInsightsCompactionState): SessionInsightsDetails {
  return {
    ...stats,
    tokens: { ...stats.tokens },
    contextUsage: stats.contextUsage === null ? null : { ...stats.contextUsage },
    compaction: { ...compaction },
  };
}

function dataProperty(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedError(error: unknown): string {
  const message = typeof error === "string" ? error : dataProperty(error, "message");
  return (typeof message === "string" ? message : "Unknown session compaction error").replaceAll("\0", "�").slice(0, maxErrorLength);
}

function boundedInspectionError(error: unknown): string {
  const message = typeof error === "string" ? error : dataProperty(error, "message");
  return `Session statistics inspection failed: ${typeof message === "string" ? message.replaceAll("\0", "�") : "unknown error"}`.slice(0, maxErrorLength);
}

function cancellationError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback, { cause: signal.reason });
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError(signal, "Session report operation was cancelled");
}

function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancellationError(signal, "Session report operation was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("Session compaction failed with a non-error rejection", { cause: error }));
      },
    );
  });
}

function parseToolParams(value: unknown): { compact: boolean } {
  if (value === null || typeof value !== "object") throw new Error("Session report parameters must be an object");
  let prototype: unknown;
  let descriptors: PropertyDescriptorMap;
  let array: boolean;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value) as unknown;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    throw new Error("Session report parameters could not be inspected safely", { cause: error });
  }
  if (array) throw new Error("Session report parameters must be an object");
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Session report parameters must be a plain object");
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !toolParameterNames.has(key)))
    throw new Error("Session report parameters contain an unknown property");
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("Session report parameters must use data properties");
  const compact = descriptors.compact?.value as unknown;
  const confirm = descriptors.confirm?.value as unknown;
  if (compact !== undefined && typeof compact !== "boolean") throw new Error("Session report parameters compact must be a boolean");
  if (confirm !== undefined && typeof confirm !== "boolean") throw new Error("Session report parameters confirm must be a boolean");
  if (compact === true && confirm !== true) throw new Error("Session report compaction requires confirm=true");
  return { compact: compact === true };
}

export default {
  name: "pi-session-insights",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: SessionInsightsPluginConfig = {}) {
    assertEmptyConfig(config);
    const runtime = () => context.get("piRuntime");
    const lifecycle = new AbortController();
    const uninitializedSession = Symbol("uninitialized session");
    let cachedSession: unknown = uninitializedSession;
    let cachedStats: SessionInsightsStats | undefined;
    let cachedError: string | undefined;
    let compaction: SessionInsightsCompactionState = { status: "idle" };
    let active: Promise<void> | undefined;
    let activeRequest: { session: unknown; controller: AbortController } | undefined;
    let queued:
      | {
          session: NonNullable<ReturnType<typeof runtime>>["session"];
          signal: AbortSignal;
          requestedAt: string;
          removeAbortListener: () => void;
        }
      | undefined;
    const refreshStats = (): void => {
      const service = runtime();
      cachedSession = service?.session;
      cachedStats = undefined;
      cachedError = undefined;
      if (service === undefined) {
        cachedError = "Pi runtime is not ready";
        return;
      }
      try {
        cachedStats = snapshotStats(service.session.getSessionStats());
      } catch (error) {
        cachedError = boundedInspectionError(error);
      }
    };
    const cancelForSessionChange = (session: unknown): void => {
      if (queued !== undefined && queued.session !== session) {
        const request = queued;
        queued = undefined;
        request.removeAbortListener();
        compaction = {
          status: "cancelled",
          requestedAt: request.requestedAt,
          finishedAt: new Date().toISOString(),
          error: "Session changed before the queued session compaction could start",
        };
      }
      if (activeRequest !== undefined && activeRequest.session !== session && !activeRequest.controller.signal.aborted) {
        activeRequest.controller.abort(new Error("Session changed while session compaction was running"));
      }
    };
    const readDetails = (): SessionInsightsDetails => {
      const session = runtime()?.session;
      cancelForSessionChange(session);
      if (session !== cachedSession) refreshStats();
      if (cachedError !== undefined) throw new Error(cachedError);
      if (cachedStats === undefined) throw new Error("Session statistics are unavailable");
      return cloneDetails(cachedStats, compaction);
    };
    const startCompaction = (session: NonNullable<ReturnType<typeof runtime>>["session"], callerSignal: AbortSignal, requestedAt: string): Promise<void> => {
      const controller = new AbortController();
      const signal = AbortSignal.any([callerSignal, controller.signal]);
      const startedAt = new Date().toISOString();
      compaction = { status: "running", requestedAt, startedAt };
      const operation = Promise.resolve().then(async () => {
        throwIfCancelled(signal);
        const abort = (): void => {
          try {
            session.abortCompaction();
          } catch {
            // Cancellation remains authoritative even if the runtime is already tearing down.
          }
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          await waitForOperation(
            Promise.resolve().then(async () => session.compact()),
            signal,
          );
          throwIfCancelled(signal);
          compaction = { status: "completed", requestedAt, startedAt, finishedAt: new Date().toISOString() };
          if (runtime()?.session === session) refreshStats();
        } catch (error) {
          compaction = {
            status: signal.aborted ? "cancelled" : "failed",
            requestedAt,
            startedAt,
            finishedAt: new Date().toISOString(),
            error: boundedError(signal.aborted ? cancellationError(signal, "Session compaction was cancelled") : error),
          };
          if (runtime()?.session === session) refreshStats();
          throw error;
        } finally {
          signal.removeEventListener("abort", abort);
        }
      });
      active = operation;
      activeRequest = { session, controller };
      void operation.then(
        () => {
          if (active === operation) active = undefined;
          if (activeRequest?.controller === controller) activeRequest = undefined;
        },
        () => {
          if (active === operation) active = undefined;
          if (activeRequest?.controller === controller) activeRequest = undefined;
        },
      );
      return operation;
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      const type = dataProperty(event, "type");
      if (typeof type !== "string") return;
      const service = runtime();
      cancelForSessionChange(service?.session);
      if (statsRefreshEvents.has(type)) refreshStats();
      if (type !== "agent_settled" || queued === undefined) return;
      const request = queued;
      queued = undefined;
      request.removeAbortListener();
      if (service === undefined || service.session !== request.session) {
        compaction = {
          status: "cancelled",
          requestedAt: request.requestedAt,
          finishedAt: new Date().toISOString(),
          error: "Session changed before the queued session compaction could start",
        };
        return;
      }
      void startCompaction(service.session, request.signal, request.requestedAt).catch(() => undefined);
    });
    const tool = defineTool({
      name: "session_report",
      label: "Session report",
      description: "Inspect the current session token, message, tool, cost, and context statistics.",
      promptSnippet: "inspect current session usage and context statistics",
      promptGuidelines: ["Set compact=true only with confirm=true after the user approves model-backed compaction that may incur usage and cost."],
      parameters: Type.Object(
        {
          compact: Type.Optional(Type.Boolean({ description: "Compact the session with the active model; this may incur usage and cost" })),
          confirm: Type.Optional(Type.Boolean({ description: "Must be true when compaction is requested" })),
        },
        { additionalProperties: false },
      ),
      executionMode: "sequential",
      async execute(_toolCallId, params, signal): Promise<AgentToolResult<SessionInsightsDetails>> {
        const request = parseToolParams(params);
        const actionSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
        throwIfCancelled(actionSignal);
        const service = runtime();
        if (service === undefined) throw new Error("Pi runtime is not ready");
        cancelForSessionChange(service.session);
        refreshStats();
        if (request.compact) {
          if (active !== undefined || queued !== undefined) throw new Error("A session compaction is already in progress");
          const requestedAt = new Date().toISOString();
          if (service.session.isIdle === false) {
            const onAbort = (): void => {
              if (queued?.signal !== actionSignal) return;
              queued = undefined;
              compaction = {
                status: "cancelled",
                requestedAt,
                finishedAt: new Date().toISOString(),
                error: "Session compaction was cancelled before it started",
              };
            };
            actionSignal.addEventListener("abort", onAbort, { once: true });
            queued = {
              session: service.session,
              signal: actionSignal,
              requestedAt,
              removeAbortListener: () => actionSignal.removeEventListener("abort", onAbort),
            };
            compaction = { status: "queued", requestedAt };
            const queuedReport = readDetails();
            return {
              content: [{ type: "text", text: "Session compaction queued until the current agent run settles." }],
              details: queuedReport,
            };
          }
          await startCompaction(service.session, actionSignal, requestedAt);
        }
        const report = readDetails();
        return {
          content: [{ type: "text", text: `Session has ${report.totalMessages} messages and ${report.tokens.total} tracked tokens.` }],
          details: report,
        };
      },
    });
    let unregisterTool: (() => void) | undefined;
    let disposePanel: (() => void) | undefined;
    try {
      unregisterTool = context.piTools.register(tool);
      disposePanel = context.piPluginUi.register({
        id: "session-insights-panel",
        pluginId: "@pi-harness/plugin-session-insights",
        title: "Session Insights",
        description: "查看当前会话的消息、工具、token、成本和上下文统计，并可触发确认后的会话压缩。",
        icon: "▥",
        read: readDetails,
      });
    } catch (error) {
      lifecycle.abort(new Error("Session Insights plugin registration failed"));
      unsubscribe();
      unregisterTool?.();
      disposePanel?.();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("Session Insights plugin disposed"));
      if (queued !== undefined) {
        queued.removeAbortListener();
        queued = undefined;
      }
      unsubscribe();
      unregisterTool?.();
      disposePanel?.();
    });
  },
};
