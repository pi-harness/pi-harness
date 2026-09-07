import type { Context } from "@deepseek-ai/cordis";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import z from "@deepseek-ai/schemastery";
import { assertKnownConfigKeys } from "@pi-harness/plugin-api";

type CompressionState = {
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

export default {
  name: "pi-history-compressor",
  inject: ["piPluginUi", "piTools"],
  Config,
  apply(context: Context, config: HistoryCompressorPluginConfig) {
    assertKnownConfigKeys("history-compressor", config, ["enabled", "thresholdPercent"]);
    const enabled = config.enabled !== false;
    const thresholdPercent = Math.max(1, Math.min(100, config.thresholdPercent ?? 85));
    const state: CompressionState = { enabled, thresholdPercent, compactions: 0, lastUsagePercent: null, queued: false, lastError: null };
    let inFlight = false;
    let queued: { session: unknown; automatic: boolean } | undefined;
    const runtime = () => context.get("piRuntime");
    const startCompaction = async (automatic: boolean): Promise<CompressionResult> => {
      const service = runtime();
      if (service === undefined) throw new Error("Pi runtime is not ready");
      inFlight = true;
      try {
        await service.session.compact();
        state.compactions += 1;
        state.lastError = null;
        return { compacted: true, automatic, queued: false };
      } catch (error) {
        state.lastError = (error instanceof Error ? error.message : String(error)).replaceAll("\0", "�").slice(0, 2_000);
        throw error;
      } finally {
        inFlight = false;
      }
    };
    // session.compact() aborts the active agent operation, including a pending retry or queued continuation, so a request raised while the session is busy waits for the authoritative agent_settled event instead of destroying the turn that asked for it.
    const compact = async (automatic: boolean): Promise<CompressionResult> => {
      const service = runtime();
      if (service === undefined) throw new Error("Pi runtime is not ready");
      if (automatic && !enabled) return { compacted: false, automatic, queued: false };
      if (inFlight || queued !== undefined) return { compacted: false, automatic, queued: queued !== undefined };
      if (service.session.isIdle === false) {
        queued = { session: service.session, automatic };
        state.queued = true;
        return { compacted: false, automatic, queued: true };
      }
      return startCompaction(automatic);
    };
    const readUsagePercent = (): number | null => {
      const service = runtime();
      let usage: { percent?: unknown } | undefined;
      try {
        usage = service?.session.getContextUsage();
      } catch (error) {
        state.lastError = (error instanceof Error ? error.message : String(error)).replaceAll("\0", "�").slice(0, 2_000);
        return null;
      }
      state.lastUsagePercent = typeof usage?.percent === "number" ? usage.percent : null;
      return state.lastUsagePercent;
    };
    const inspectAndMaybeCompact = (): void => {
      const usagePercent = readUsagePercent();
      if (enabled && usagePercent !== null && usagePercent >= thresholdPercent) void compact(true).catch(() => undefined);
    };
    const unsubscribe = context.on("pi/session-event", (event) => {
      const descriptor = Object.getOwnPropertyDescriptor(event, "type");
      const type: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      if (type === "agent_end") inspectAndMaybeCompact();
      if (type !== "agent_settled") return;
      const request = queued;
      if (request === undefined) return;
      queued = undefined;
      state.queued = false;
      const service = runtime();
      if (service === undefined || service.session !== request.session) {
        state.lastError = "Session changed before the queued history compaction could start";
        return;
      }
      // An automatic request only records that usage crossed the threshold at agent_end; the run that settled since then may have shrunk the context (an explicit compaction, a rolled-back turn), so the threshold is re-evaluated against the current usage rather than compacting on the stale reading. An explicit request stays unconditional because the user already confirmed it.
      if (request.automatic) {
        const usagePercent = readUsagePercent();
        if (usagePercent === null || usagePercent < thresholdPercent) return;
      }
      void startCompaction(request.automatic).catch(() => undefined);
    });
    const unregisterTool = context.piTools.register(
      defineTool({
        name: "compress_history",
        label: "Compress history",
        description: "Compact the current Pi session after explicit confirmation; compaction is queued until the active agent run has settled.",
        promptSnippet: "compact the current conversation history",
        parameters: Type.Object({ confirm: Type.Boolean({ description: "Must be true to compact history" }) }, { additionalProperties: false }),
        executionMode: "sequential",
        async execute(_toolCallId, params): Promise<AgentToolResult<CompressionResult>> {
          if (params.confirm !== true) throw new Error("History compaction requires confirm=true");
          const result = await compact(false);
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
        read: () => ({ ...state }),
      });
    } catch (error) {
      unregisterTool();
      unsubscribe();
      throw error;
    }
    context.effect(() => () => {
      unsubscribe();
      unregisterTool();
      disposePanel();
    });
  },
};
