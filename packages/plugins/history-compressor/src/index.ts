import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import z from "@deepseek-ai/schemastery";
import { assertKnownConfigKeys, tryAcquireSessionCompaction } from "@pi-harness/plugin-api";

type CompressionState = {
  sessionId: string;
  enabled: boolean;
  thresholdPercent: number;
  compactions: number;
  lastUsagePercent: number | null;
  queued: boolean;
  lastError: string | null;
};
type CompressionResult = { compacted: boolean; automatic: boolean; queued: boolean };
export interface HistoryCompressorPluginConfig {
  enabled?: boolean;
  thresholdPercent?: number;
}
export const Config: z<HistoryCompressorPluginConfig> = z.object({ enabled: z.boolean().default(true), thresholdPercent: z.number().default(85) });

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("History compaction cancelled");
}

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("History compaction cancelled", { cause: signal.reason });
}

function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancellationError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("History compaction failed with a non-error rejection", { cause: error }));
      },
    );
    if (signal.aborted) onAbort();
  });
}

function confirmedParameter(value: unknown): boolean {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid history compaction parameters");
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid history compaction parameters");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== "confirm") throw new Error("Invalid history compaction parameters");
    const descriptor = Object.getOwnPropertyDescriptor(value, "confirm");
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "boolean") throw new Error("Invalid history compaction parameters");
    return descriptor.value;
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid history compaction parameters") throw error;
    throw new Error("Invalid history compaction parameters", { cause: error });
  }
}

export default {
  name: "pi-history-compressor",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: HistoryCompressorPluginConfig) {
    assertKnownConfigKeys("history-compressor", config, ["enabled", "thresholdPercent"]);
    const enabled = config.enabled !== false;
    const thresholdPercent = Math.max(1, Math.min(100, config.thresholdPercent ?? 85));
    const runtime = () => context.get("piRuntime");
    type RuntimeSession = NonNullable<ReturnType<typeof runtime>>["session"];
    const states = new WeakMap<RuntimeSession, CompressionState>();
    const stateFor = (session: RuntimeSession): CompressionState => {
      const sessionId = session.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 512 || /[\0\p{Cc}]/u.test(sessionId))
        throw new Error("History compressor runtime session ID is invalid");
      const existing = states.get(session);
      if (existing !== undefined && existing.sessionId === sessionId) return existing;
      const state: CompressionState = { sessionId, enabled, thresholdPercent, compactions: 0, lastUsagePercent: null, queued: false, lastError: null };
      states.set(session, state);
      return state;
    };
    let inFlight = false;
    const lifecycle = new AbortController();
    let activeRequest: { session: RuntimeSession; sessionId: string; controller: AbortController } | undefined;
    let queued:
      | { session: RuntimeSession; sessionId: string; state: CompressionState; automatic: boolean; signal: AbortSignal; removeAbortListener: () => void }
      | undefined;
    const cancelForSessionChange = (session: unknown): void => {
      const sessionId = session !== null && typeof session === "object" ? (session as { sessionId?: unknown }).sessionId : undefined;
      if (queued !== undefined && (queued.session !== session || queued.sessionId !== sessionId)) {
        const request = queued;
        queued = undefined;
        request.removeAbortListener();
        request.state.queued = false;
        request.state.lastError = "Session changed before the queued history compaction could start";
      }
      if (
        activeRequest !== undefined &&
        (activeRequest.session !== session || activeRequest.sessionId !== sessionId) &&
        !activeRequest.controller.signal.aborted
      ) {
        activeRequest.controller.abort(new Error("Session changed while history compaction was running"));
      }
    };
    const startCompaction = async (session: RuntimeSession, automatic: boolean, callerSignal: AbortSignal): Promise<CompressionResult> => {
      const state = stateFor(session);
      const controller = new AbortController();
      const signal = AbortSignal.any([callerSignal, controller.signal]);
      throwIfAborted(signal);
      const abort = (): void => {
        try {
          session.abortCompaction();
        } catch {
          // Caller cancellation remains authoritative while the runtime tears down.
        }
      };
      const unsubscribeCompaction = session.subscribe((event) => {
        if (event.type === "compaction_start" && signal.aborted) abort();
      });
      const releaseCompaction = tryAcquireSessionCompaction(session);
      if (releaseCompaction === undefined) {
        unsubscribeCompaction();
        return { compacted: false, automatic, queued: false };
      }
      signal.addEventListener("abort", abort, { once: true });
      inFlight = true;
      activeRequest = { session, sessionId: state.sessionId, controller };
      const nativeOperation = Promise.resolve()
        .then(async () => {
          throwIfAborted(signal);
          await session.compact();
        })
        .finally(() => {
          signal.removeEventListener("abort", abort);
          unsubscribeCompaction();
          releaseCompaction();
          inFlight = false;
          if (activeRequest?.controller === controller) activeRequest = undefined;
        });
      try {
        await waitForOperation(nativeOperation, signal);
        throwIfAborted(signal);
        state.compactions += 1;
        state.lastError = null;
        return { compacted: true, automatic, queued: false };
      } catch (error) {
        state.lastError = (error instanceof Error ? error.message : String(error)).replaceAll("\0", "�").slice(0, 2_000);
        throw error;
      }
    };
    // session.compact() aborts the active agent operation, including a pending retry or queued continuation, so a request raised while the session is busy waits for the authoritative agent_settled event instead of destroying the turn that asked for it.
    const compact = async (automatic: boolean, signal = lifecycle.signal): Promise<CompressionResult> => {
      throwIfAborted(signal);
      const service = runtime();
      if (service === undefined) throw new Error("Pi runtime is not ready");
      const state = stateFor(service.session);
      if (automatic && !enabled) return { compacted: false, automatic, queued: false };
      if (inFlight || queued !== undefined || service.session.isCompacting === true) return { compacted: false, automatic, queued: queued !== undefined };
      if (service.session.isIdle === false) {
        const onAbort = (): void => {
          if (queued?.signal !== signal) return;
          queued = undefined;
          state.queued = false;
          state.lastError = "History compaction cancelled before it started";
        };
        signal.addEventListener("abort", onAbort, { once: true });
        queued = {
          session: service.session,
          sessionId: state.sessionId,
          state,
          automatic,
          signal,
          removeAbortListener: () => signal.removeEventListener("abort", onAbort),
        };
        state.queued = true;
        return { compacted: false, automatic, queued: true };
      }
      return startCompaction(service.session, automatic, signal);
    };
    const readUsagePercent = (session: RuntimeSession): number | null => {
      const state = stateFor(session);
      let usage: { percent?: unknown } | undefined;
      try {
        usage = session.getContextUsage();
      } catch (error) {
        state.lastError = (error instanceof Error ? error.message : String(error)).replaceAll("\0", "�").slice(0, 2_000);
        return null;
      }
      state.lastUsagePercent = typeof usage?.percent === "number" ? usage.percent : null;
      return state.lastUsagePercent;
    };
    const inspectAndMaybeCompact = (): void => {
      const service = runtime();
      if (service === undefined) return;
      const usagePercent = readUsagePercent(service.session);
      if (enabled && usagePercent !== null && usagePercent >= thresholdPercent) void compact(true).catch(() => undefined);
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      const service = runtime();
      cancelForSessionChange(service?.session);
      const descriptor = Object.getOwnPropertyDescriptor(event, "type");
      const type: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      if (type === "agent_end") inspectAndMaybeCompact();
      if (type !== "agent_settled") return;
      const request = queued;
      if (request === undefined) return;
      queued = undefined;
      request.removeAbortListener();
      request.state.queued = false;
      if (service === undefined || service.session !== request.session || service.session.sessionId !== request.sessionId) {
        request.state.lastError = "Session changed before the queued history compaction could start";
        return;
      }
      // An automatic request only records that usage crossed the threshold at agent_end; the run that settled since then may have shrunk the context (an explicit compaction, a rolled-back turn), so the threshold is re-evaluated against the current usage rather than compacting on the stale reading. An explicit request stays unconditional because the user already confirmed it.
      if (request.automatic) {
        const usagePercent = readUsagePercent(request.session);
        if (usagePercent === null || usagePercent < thresholdPercent) return;
      }
      void startCompaction(request.session, request.automatic, request.signal).catch(() => undefined);
    });
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "compress_history",
        label: "Compress history",
        description: "Compact the current Pi session after explicit confirmation; compaction is queued until the active agent run has settled.",
        promptSnippet: "compact the current conversation history",
        parameters: Type.Object({ confirm: Type.Boolean({ description: "Must be true to compact history" }) }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params, signal): Promise<AgentToolResult<CompressionResult>> {
          const operationSignal = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal]);
          throwIfAborted(operationSignal);
          if (!confirmedParameter(params)) throw new Error("History compaction requires confirm=true");
          const result = await compact(false, operationSignal);
          const text = result.compacted
            ? "Session history compacted."
            : result.queued
              ? "Session compaction queued until the current agent run settles."
              : "Session compaction is already running.";
          return { content: [{ type: "text", text }], details: result };
        },
      }),
    );
    let disposePanel: () => void;
    try {
      disposePanel = context.piPluginUi.register({
        id: "history-compressor-panel",
        pluginId: "@pi-harness/plugin-history-compressor",
        title: "History Compressor",
        description: "在上下文接近阈值时自动压缩历史消息。",
        icon: "↯",
        read: () => {
          const service = runtime();
          cancelForSessionChange(service?.session);
          if (service === undefined) throw new Error("Pi runtime is not ready");
          return { ...stateFor(service.session) };
        },
      });
    } catch (error) {
      unregisterTool();
      unsubscribe();
      throw error;
    }
    context.effect(() => () => {
      lifecycle.abort(new Error("History compressor plugin disposed"));
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
